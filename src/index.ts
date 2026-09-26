/**
 * Autonomous Client Trading Agent for Decibel DEX on Aptos Mainnet
 * 
 * Architecture: "Standalone-First, Sim Lab Supercharged"
 *  - Primary Mode: Works 100% autonomously out-of-the-box with NO Sim Lab connection required.
 *  - Optional Supercharge: If SIMLAB_KEY is provided, syncs macro regimes & live calibration.
 *  - Failover: Seamlessly drops back into Standalone Mode if Sim Lab disconnects or key expires.
 */

import { config, watchPairs, getDerivedSignerAddress, isClientConfigured, isClientOnboarded } from './config';
import { logger } from './utils/logger';
import { standaloneEngine, fetchPublicKlines, KlineBar } from './engine/standalone-engine';
import { localAIBrain } from './ai/brain';
import { superchargeClient } from './simlab/supercharge-client';
import { tradeExecutor } from './trades/executor';
import { portfolioHarvester } from './engine/harvester';
import { startApiServer, agentState, registerScanTrigger, seedMarketsForPairs } from './api-server';
import { getSimPairDirective } from './strategy/manager';
import { startSimPipelineConsumer, stopSimPipelineConsumer } from './pipeline/sim-consumer';
import { startTelemetryFeeder, stopTelemetryFeeder } from './pipeline/telemetry-feeder';
import { telegramNotifier } from './notify/telegram';
import { resolveNodeApiKey } from './utils/node-key-resolver';
import { mcpClient } from './mcp/client';

let isRunning = false;
let mainLoopTimer: NodeJS.Timeout | null = null;
let positionPollTimer: NodeJS.Timeout | null = null;
let cycleCount = 0;

// Per-pair 1h kline cache with TTL — refreshed every 5 minutes in background
const klines1hCache: Record<string, { bars: Array<{t:number;o:number;h:number;l:number;c:number;v:number}>; ts: number }> = {};
const KLINES_1H_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refresh1hKlinesForPair(symbol: string): Promise<void> {
  const cached = klines1hCache[symbol];
  if (cached && Date.now() - cached.ts < KLINES_1H_TTL_MS) return; // still fresh
  try {
    const bars = await fetchPublicKlines(symbol, '1h', 35);
    if (bars && bars.length >= 5) {
      klines1hCache[symbol] = {
        bars: bars.slice(-35).map((k) => ({ t: k.openTime, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume })),
        ts: Date.now(),
      };
    }
  } catch { /* silent — 1h is supplemental */ }
}

function printBanner(): void {
  const modeColor = config.IS_SIMLAB_CONFIGURED ? '⚡ SIM LAB SUPERCHARGED' : '🛡️  PURE STANDALONE';
  const paperLabel = config.PAPER_TRADING ? 'ENABLED (Zero-Risk Simulation)' : 'DISABLED (Real On-Chain Orders)';
  const derivedSigner = getDerivedSignerAddress();

  console.log(`
================================================================================
  DECIBEL DEX AUTONOMOUS TRADING AGENT — APTOS MAINNET
================================================================================
  Client ID:          ${config.CLIENT_ID}
  Client Name:        ${config.CLIENT_NAME}
  Alpha Pipeline:     ${config.SIM_PIPELINE_ENABLED ? 'ACTIVE (' + config.SIM_PIPELINE_URL + ')' : 'DISABLED'}
  Operating Mode:     ${modeColor}
  AI Brain Provider:  ${config.ACTIVE_AI_PROVIDER.toUpperCase()}
  Paper Trading:      ${paperLabel}
  Network:            ${config.NETWORK.toUpperCase()}
  Aptos Node:         ${config.DECIBEL_NODE_API_KEY ? 'Authorized Builder Key (' + config.DECIBEL_NODE_API_KEY.slice(0, 10) + '...)' : 'Secure Fleet Proxy (Rate-Limit Free)'}
  Subaccount:         ${config.DECIBEL_SUBACCOUNT_ADDRESS || 'Not Configured (Required for Live)'}
  Signer Key (Gas):   ${derivedSigner ? derivedSigner + ' (Option B Non-Custodial)' : 'Not Configured'}
  Allocated Budget:   $${config.BUDGET_USD.toFixed(2)} USD
  Active Strategy:    ${standaloneEngine.getDirectives().activeStrategy}
  Score Floor:        ${standaloneEngine.getDirectives().scoreFloor}
  Wick Tolerance:     ${standaloneEngine.getDirectives().bullTrapUpperWickPct}%
  Local Health API:   http://localhost:${config.HEALTH_PORT}
  Watch Pairs:        ${watchPairs.join(', ')}
================================================================================
`);
}

async function runTradingCycle(): Promise<void> {
  const isReady = isClientConfigured() || (config.PAPER_TRADING && isClientOnboarded());
  if (!isReady) {
    if (cycleCount % 6 === 0) {
      logger.info('⏳ [AGENT PRE-ONBOARD] Waiting for operator credentials via Web Dashboard (http://localhost:5050)...');
    }
    cycleCount++;
    return;
  }

  cycleCount++;
  logger.info(`🔄 [CYCLE #${cycleCount}] Scanning ${watchPairs.length} markets for confluence setups...`);

  const livePrices: Record<string, number> = {};

  // Process pairs in fast parallel batches of 7 to scan 28+ pairs in under 2 seconds without freezing
  const BATCH_SIZE = 7;
  for (let i = 0; i < watchPairs.length; i += BATCH_SIZE) {
    const batch = watchPairs.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (symbol) => {
        try {
          // 1. Fetch 15m klines (primary — used for signals and chart)
          const klines = await fetchPublicKlines(symbol, '15m', 60);
          if (!klines || klines.length < 20) {
            logger.debug(`[${symbol}] Insufficient kline data returned. Skipping.`);
            return;
          }

          // 1b. Refresh 1h klines (cached for 5 minutes per pair)
          await refresh1hKlinesForPair(symbol);

          const currentPrice = klines[klines.length - 1].close;
          livePrices[symbol] = currentPrice;

          // 2. Standalone Engine 5-Layer Strategy Evaluation
          const cached1hBars: KlineBar[] | undefined = klines1hCache[symbol]?.bars
            ? klines1hCache[symbol].bars.map((b) => ({
                openTime: b.t,
                open: b.o,
                high: b.h,
                low: b.l,
                close: b.c,
                volume: b.v,
                closeTime: b.t + 3600000,
              }))
            : undefined;

          const simDir = getSimPairDirective(symbol);
          const orderflow = simDir?.orderflow;
          const fundingRate = typeof orderflow?.fundingRate === 'number' ? orderflow.fundingRate : 0.0001;
          const oiChange24h = typeof orderflow?.oiChange24h === 'number' ? orderflow.oiChange24h : 0.0;
          const lsRatio = typeof orderflow?.lsRatio === 'number' ? orderflow.lsRatio : 1.0;

          const signal = standaloneEngine.evaluateSetup(symbol, klines, cached1hBars, {
            fundingRate,
            oiChange24h,
            lsRatio,
            cvdTrend: orderflow?.cvdTrend,
            predictedFundingRate: orderflow?.predictedFundingRate,
            liquidationClusters: orderflow?.liquidationClusters,
          });

          // Market metrics
          const firstPrice = klines[0].open;
          const high24h = Math.max(...klines.map((k) => k.high));
          const low24h = Math.min(...klines.map((k) => k.low));
          const volume24hUsd = klines.reduce((acc, k) => acc + k.volume * k.close, 0);
          const change24h = firstPrice > 0 ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0;
          const trend = signal.trend;
          const action = signal.triggered ? signal.action : 'WAIT';
          const confidence = signal.confidence;
          const riskLevel = signal.riskLevel;

          // Build per-pair SMC summary from real signal indicators
          const ind = signal.indicators;
          const smcParts: string[] = [];

          // Liquidity sweep type
          if (ind.smcSignal === 'SWEEP_LOW_REVERSAL') {
            smcParts.push(`🟢 SSL Sweep: Lows swept at $${ind.swingLow?.toFixed(4) || '—'} with bullish reversal`);
          } else if (ind.smcSignal === 'SWEEP_HIGH_REVERSAL') {
            smcParts.push(`🔴 BSL Sweep: Highs swept at $${ind.swingHigh?.toFixed(4) || '—'} with bearish reversal`);
          } else if (ind.smcSignal === 'FAIR_VALUE_GAP_TAP') {
            smcParts.push(`⚡ FVG Tap: Price entering Fair Value Gap zone`);
          }

          // Wick signals
          if (ind.upperWickPct > 40) smcParts.push(`🔴 Heavy upper wick (${ind.upperWickPct.toFixed(1)}%) — bearish rejection`);
          else if (ind.lowerWickPct > 40) smcParts.push(`🟢 Heavy lower wick (${ind.lowerWickPct.toFixed(1)}%) — bullish support`);

          // RSI extremes
          if (ind.rsi14 > 72) smcParts.push(`⚠️ RSI ${ind.rsi14.toFixed(1)} overbought — premium zone risk`);
          else if (ind.rsi14 < 28) smcParts.push(`✅ RSI ${ind.rsi14.toFixed(1)} oversold — discount zone opportunity`);

          // Trend structure
          if (ind.ema9 > ind.ema21) smcParts.push(`↗ EMA structure bullish (9>${ind.ema21?.toFixed?.(4) || '—'})`);
          else if (ind.ema9 < ind.ema21) smcParts.push(`↘ EMA structure bearish (9<${ind.ema21?.toFixed?.(4) || '—'})`);

          const smcSummaryText = smcParts.length > 0
            ? smcParts.join(' · ')
            : `⬜ Neutral: Price in equilibrium range — no sweep or FVG active`;

          // Serialize klines for dashboard candlestick rendering
          const klines15mSerialized = klines.slice(-35).map((k) => ({
            t: k.openTime,
            o: k.open,
            h: k.high,
            l: k.low,
            c: k.close,
            v: k.volume,
          }));
          const klines1hSerialized = klines1hCache[symbol]?.bars || [];

          agentState.markets[symbol] = {
            symbol,
            markPrice: currentPrice,
            change24h,
            volume24hUsd,
            high24h,
            low24h,
            trend,
            action,
            confidence,
            riskLevel,
            fundingRate,
            coinglassOIChange: oiChange24h,
            coinglassLSRatio: lsRatio,
            strategyName: signal.strategyName,
            candlestick: {
              rsi14: ind.rsi14,
              stochRsi14: ind.stochRsi14,
              ema9: ind.ema9,
              ema21: ind.ema21,
              ema50: ind.ema50,
              upperWickPct: ind.upperWickPct,
              lowerWickPct: ind.lowerWickPct,
              rvol: ind.rvol,
              adx14: ind.adx14,
              trend1h: ind.trend1h,
              lastPattern: ind.smc?.turtleSoup?.isTurtleSoup
                ? ind.smc.turtleSoup.type
                : (ind.smcSignal !== 'NONE' ? ind.smcSignal : ind.lastPattern),
              smc: ind.smc || {
                summary: smcSummaryText,
                liquiditySweep: ind.smcSignal === 'SWEEP_LOW_REVERSAL'
                  ? { type: 'BULLISH_SWEEP_SSL', swingLow: ind.swingLow }
                  : ind.smcSignal === 'SWEEP_HIGH_REVERSAL'
                    ? { type: 'BEARISH_SWEEP_BSL', swingHigh: ind.swingHigh }
                    : undefined,
              },
              klines15m: klines15mSerialized,
              klines1h: klines1hSerialized,
            },
            updatedAt: Date.now(),
          };

          if (!signal.triggered || (signal.action !== 'LONG' && signal.action !== 'SHORT')) {
            logger.debug(
              `[${symbol}] No signal. RSI: ${signal.indicators.rsi14.toFixed(1)}, ` +
              `EMA9/21: ${signal.indicators.ema9.toFixed(2)}/${signal.indicators.ema21.toFixed(2)}`,
            );
            return;
          }

          logger.info(
            `🎯 [SETUP DETECTED] ${symbol} ${signal.action} Triggered! ` +
            `EMA Crossover: ${signal.indicators.emaCrossover} | RSI: ${signal.indicators.rsi14.toFixed(1)} | ` +
            `UpperWick: ${signal.indicators.upperWickPct.toFixed(1)}% | LowerWick: ${signal.indicators.lowerWickPct.toFixed(1)}%`,
          );

          // 3. AI Brain Verification
          const isSimLab = superchargeClient.isActive();
          const currentDirectives = standaloneEngine.getDirectives();
          const aiEval = await localAIBrain.evaluate(signal, isSimLab, currentDirectives);
          logger.info(
            `🧠 [AI BRAIN: ${aiEval.role} (${aiEval.provider.toUpperCase()})] Verdict: ${aiEval.confirmed ? 'CONFIRMED' : 'REJECTED'} | ` +
            `Confidence: ${aiEval.confidenceScore}/100 | Sentiment: ${aiEval.sentiment} | Reasoning: "${aiEval.reasoning}"`,
          );

          // 4. Decibel Execution & Risk Guard Validation
          if (aiEval.confirmed) {
            // Feature 4: Counterfactual Shadow Advisory Guard
            const shadowCheck = superchargeClient.checkCounterfactualAdvisory(symbol, signal.action);
            if (shadowCheck.vetoed) {
              logger.warn(`🛡️ [COUNTERFACTUAL VETO] ${symbol} ${signal.action} vetoed by Sim Lab Paper Advisory: ${shadowCheck.reason}`);
              tradeExecutor.recordShadowTrade({
                symbol,
                action: signal.action,
                entryPrice: signal.entryPrice,
                takeProfit: signal.takeProfit,
                stopLoss: signal.stopLoss,
                confidence: aiEval.confidenceScore,
                vetoCategory: 'SIM_COUNTERFACTUAL_VETO',
                vetoReason: shadowCheck.reason || 'Sim Lab Paper Simulation negative EV veto',
              });
              return;
            }

            const execResult = await tradeExecutor.executeTrade(signal, aiEval);
            if (execResult.success && execResult.trade) {
              logger.info(`✨ [TRADE FILLED] ${execResult.trade.symbol} ${execResult.trade.action} active!`);
            } else {
              logger.warn(`⚠️ [TRADE BLOCKED] ${execResult.error}`);
              const errStr = (execResult.error || '').toLowerCase();
              const vetoCategory = errStr.includes('budget') || errStr.includes('margin')
                ? 'BUDGET_EXHAUSTED'
                : errStr.includes('position')
                ? 'MAX_POSITIONS'
                : errStr.includes('banned')
                ? 'DIRECTIONAL_BAN'
                : 'RISK_GUARD';

              tradeExecutor.recordShadowTrade({
                symbol,
                action: signal.action,
                entryPrice: signal.entryPrice,
                takeProfit: signal.takeProfit,
                stopLoss: signal.stopLoss,
                confidence: aiEval.confidenceScore,
                vetoCategory,
                vetoReason: execResult.error || 'Blocked by Pre-Trade Risk Guard',
              });
            }
          } else {
            tradeExecutor.recordShadowTrade({
              symbol,
              action: signal.action,
              entryPrice: signal.entryPrice,
              takeProfit: signal.takeProfit,
              stopLoss: signal.stopLoss,
              confidence: aiEval.confidenceScore,
              vetoCategory: aiEval.trapCategory || 'AI_REJECTED',
              vetoReason: aiEval.reasoning || 'Rejected by AI Brain confidence/sentiment filter',
            });
          }
        } catch (err: any) {
          logger.error(`Error processing ${symbol}: ${err.message}`);
        }
      }),
    );
  }

  // Ensure all open positions have a price in livePrices even if outside watchPairs
  for (const t of tradeExecutor.getOpenTrades()) {
    if (!livePrices[t.symbol]) {
      if (agentState.markets[t.symbol]?.markPrice) {
        livePrices[t.symbol] = agentState.markets[t.symbol].markPrice;
      } else {
        try {
          const p = await mcpClient.getPrice(t.symbol);
          if (p?.markPrice) livePrices[t.symbol] = p.markPrice;
        } catch {}
      }
    }
  }

  // 5. Monitor Open Positions (Enforce Dynamic TP/SL & Trailing Harvester)
  tradeExecutor.monitorOpenTrades(livePrices);
  portfolioHarvester.evaluate(livePrices);

  // 6. Telemetry Reporting
  const stats = tradeExecutor.getStats();
  const openTrades = tradeExecutor.getOpenTrades();

  logger.info(
    `📊 [STATUS] Open: ${stats.openTradesCount} | Closed: ${stats.closedTradesCount} | ` +
    `Win Rate: ${stats.winRate}% | Realized PnL: $${stats.totalPnlUsd} | ` +
    `Budget Used: $${stats.budgetUsedUsd} / $${config.BUDGET_USD}`,
  );

  // 7. Stream Real On-Chain Telemetry to Sim Lab (Always active)
  superchargeClient.sendHeartbeat().catch(() => {});
}

async function bootstrap(): Promise<void> {
  // Resolve Aptos Node credentials dynamically on startup (zero hardcoded secrets)
  try {
    await resolveNodeApiKey();
  } catch (err: any) {
    logger.debug(`Node key auto-resolution note: ${err.message}`);
  }

  printBanner();

  // 1. Central Alpha Server Pipeline (Bidirectional Bridge: Port 4000)
  if (process.env.SIM_PIPELINE_ENABLED !== 'false' && config.SIM_PIPELINE_ENABLED) {
    logger.info(`🔗 [SIM PIPELINE] Initializing Bidirectional Central Alpha Bridge (Client: ${config.CLIENT_ID})...`);
    startSimPipelineConsumer();
    startTelemetryFeeder();
  }

  // 2. Initialize Sim Lab Pipeline Telemetry (Continuous real on-chain telemetry)
  superchargeClient.startPipelineTelemetry();
  if (config.IS_SIMLAB_CONFIGURED) {
    logger.info('⚡ [SIM LAB] SIMLAB_KEY detected. Connecting to Sim Lab Fleet Command...');
    await superchargeClient.connect();
  } else {
    logger.info(`📡 [SIM LAB TELEMETRY] Continuous on-chain pipeline active to ${superchargeClient.getServerUrl()}`);
  }

  // 3. Start Local Dashboard & Health API Server
  try {
    startApiServer();
    registerScanTrigger(() => {
      logger.info('⚡ Immediate market scan triggered via operator credentials update!');
      runTradingCycle().catch((err) => logger.error(`Immediate cycle error: ${err.message}`));
    });
    if (isClientConfigured()) {
      seedMarketsForPairs();
    }
  } catch (err: any) {
    logger.warn(`Local API dashboard server skipped: ${err.message}`);
  }

  // 4. Initialize Telegram 2-Way Interactive Copilot Chat
  try {
    telegramNotifier.setChatHandler(async (message: string) => {
      if (message.trim().toLowerCase() === '/scan' || message.trim().toLowerCase() === 'scan') {
        runTradingCycle().catch((err) => logger.error(`Telegram scan trigger error: ${err.message}`));
      }

      let gasBalance = 0;
      let marginBalance = 0;
      try {
        const onChain = await tradeExecutor.fetchOnChainBalance();
        gasBalance = onChain?.aptBalance ?? 0;
        marginBalance = onChain?.balanceUsd ?? 0;
      } catch {}

      const res = await localAIBrain.chat(message, {
        clientName: config.CLIENT_NAME,
        clientId: config.CLIENT_ID,
        network: config.NETWORK,
        subaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
        signerAddress: tradeExecutor.getSignerAddress() || getDerivedSignerAddress(),
        gasAptBalance: gasBalance,
        onChainBalanceUsd: marginBalance,
        stats: tradeExecutor.getStats(),
        openPositions: tradeExecutor.getOpenTrades(),
        recentTrades: tradeExecutor.getClosedTrades().slice(-10),
        budgetUsd: config.BUDGET_USD,
        maxLeverage: config.MAX_LEVERAGE,
        paperTrading: config.PAPER_TRADING,
        watchPairs: [...watchPairs],
        directives: standaloneEngine.getDirectives(),
        isSimLabConnected: superchargeClient.isActive(),
        simLabServerUrl: superchargeClient.getServerUrl(),
        activeAiProvider: config.ACTIVE_AI_PROVIDER,
        activeAiModel: config.GEMINI_MODEL,
      });

      return res.reply;
    });
    telegramNotifier.startPolling();
  } catch (err: any) {
    logger.warn(`Telegram interactive chat initialization skipped: ${err.message}`);
  }

  // 5. Start Main Trading Engine Loop
  isRunning = true;
  logger.info(`🚀 Starting autonomous market scanner (polling every ${config.POLL_INTERVAL_MS / 1000}s)...`);

  // Run first cycle immediately
  await runTradingCycle().catch((err) => logger.error(`Cycle error: ${err.message}`));

  // Recurring loop
  mainLoopTimer = setInterval(async () => {
    if (!isRunning) return;
    try {
      await runTradingCycle();
    } catch (err: any) {
      logger.error(`Trading loop iteration failed: ${err.message}`);
    }
  }, config.POLL_INTERVAL_MS);

  // Position monitor — ultra-fast poll (3s) when positions are active, 15s when idle
  const positionLoop = async (): Promise<void> => {
    if (!isRunning) return;
    try {
      const openTrades = tradeExecutor.getOpenTrades();
      if (openTrades.length > 0) {
        const openPrices: Record<string, number> = {};
        for (const t of openTrades) {
          const sym = t.symbol;
          if (agentState.markets[sym]?.markPrice) {
            openPrices[sym] = agentState.markets[sym].markPrice;
          } else {
            try {
              const p = await mcpClient.getPrice(sym);
              if (p?.markPrice) openPrices[sym] = p.markPrice;
            } catch {}
          }
        }
        tradeExecutor.monitorOpenTrades(openPrices);
        portfolioHarvester.evaluate(openPrices);
      }
    } catch (err: any) {
      logger.debug(`[FAST POSITION MONITOR] Error in cycle: ${err.message}`);
    }
    const hasOpen = tradeExecutor.getOpenTrades().length > 0;
    const nextPoll = hasOpen ? 3_000 : 15_000;
    positionPollTimer = setTimeout(positionLoop, nextPoll);
  };
  positionLoop();
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────

function shutdown(): void {
  if (!isRunning) return;
  logger.info('🛑 Shutting down Autonomous Trading Agent gracefully...');
  isRunning = false;

  if (mainLoopTimer) clearInterval(mainLoopTimer);
  if (positionPollTimer) clearTimeout(positionPollTimer);
  telegramNotifier.stopPolling();
  stopSimPipelineConsumer();
  stopTelemetryFeeder();
  superchargeClient.stop();
  tradeExecutor.saveTrades();

  logger.info('👋 Agent stopped safely. All states preserved in data/trades.json.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrap().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
