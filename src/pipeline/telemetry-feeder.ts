/**
 * Central Alpha Server / Sim Lab Outbound Telemetry Feeder
 * 
 * Reports live Aptos on-chain execution reality back to the central Alpha Server:
 *  1. Live execution reality (closed trades, win rate, realized PnL, avg hold bars)
 *  2. AI Trap Shield counterfactual ground truth (true traps saved vs false alarms killed)
 *  3. Per-asset win rates and cooldown status
 *  4. Stop-loss post-mortem lessons
 *  5. Open positions and margin/budget status
 */

import { config, watchPairs, getDerivedSignerAddress, isClientConfigured } from '../config';
import { logger } from '../utils/logger';
import { tradeExecutor, TradeRecord, ShadowTrade } from '../trades/executor';
import { portfolioHarvester } from '../risk/portfolio-harvester';
import { getSimPairDirective } from '../strategy/manager';
import { simConnectionManager } from './connection-manager';

export interface ClientTelemetryPayload {
  timestamp: number;
  clientId: string;               // e.g. "desk-01-jetson"
  botId: string;                  // e.g. "desk-01-jetson"
  botName: string;                // e.g. "Alpha Autonomous Client"
  source: 'live_mainnet';
  triggerReason: 'periodic_sync' | 'trade_closed' | 'shadow_trade_resolved';

  // 1. Live Execution Reality
  execution: {
    totalTradesClosed: number;
    winRatePct: number;
    totalNetRealizedPnlUsd: number;
    avgHoldBars: number;
    recentClosedTrades: Array<{
      id: string;
      symbol: string;
      action: 'LONG' | 'SHORT';
      entryPrice: number;
      exitPrice: number;
      realizedPnlUsd: number;
      realizedPnlPct: number;
      rMultiple?: number;
      barsHeld?: number;
      exitReason?: string;
      closedAt?: number;
      confidence?: number;
      strategyName?: string;
    }>;
  };

  // 2. AI Trap Shield Counterfactual Ground Truth
  shadowTracking: {
    totalVetoed: number;
    activeTracking: number;
    trueTrapsSaved: number;    // Veto saved money (trade would have hit SL)
    falseAlarmsKilled: number; // Veto killed winner (trade would have hit TP)
    precisionPct: number;      // trueTraps / (trueTraps + falseAlarms) * 100
    estimatedSavedUsd: number;
    estimatedMissedUsd: number;
    vetoCategoryPerformance: Record<string, {
      totalVetoes: number;
      trueTraps: number;
      falseAlarms: number;
      accuracyPct: number;
    }>;
  };

  // 3. Per-Asset Win Rates & Cooldown Recommendations
  assetExpectancy: Record<string, {
    symbol: string;
    totalTrades: number;
    winRatePct: number;
    totalPnlUsd: number;
    scoreAdjustment: number;
    cooldownActive: boolean;
  }>;

  // 4. Lessons from Stop-Losses
  recentLossLessons: Array<{
    symbol: string;
    action: string;
    pnlUsd: number;
    pnlPct: number;
    lesson: string;
    exitReason: string;
  }>;

  // 5. Open Positions & Gas Balance
  gasApt?: number;
  budgetUsd?: number;
  openPositions?: Array<{
    symbol: string;
    side: 'LONG' | 'SHORT';
    sizeUsd: number;
    entryPrice: number;
    markPrice: number;
    unrealizedPnlUsd: number;
    unrealizedPnlPct: number;
    stopLoss?: number;
    takeProfit?: number;
    leverage?: number;
  }>;
}

let feederTimer: NodeJS.Timeout | null = null;
let isInitialized = false;

/**
 * Builds the comprehensive ClientTelemetryPayload from active trading state
 */
export async function buildTelemetryPayload(
  triggerReason: ClientTelemetryPayload['triggerReason'] = 'periodic_sync'
): Promise<ClientTelemetryPayload> {
  await tradeExecutor.syncOnChainPositions().catch(() => {});
  const closedTrades = tradeExecutor.getClosedTrades();
  const openTrades = tradeExecutor.getOpenTrades();
  const stats = tradeExecutor.getStats();
  const shadowStats = tradeExecutor.getShadowStats();
  const shadowTrades = tradeExecutor.getShadowTrades();

  // 1. Compute execution reality & avg hold bars (15-min bar basis)
  let totalHoldBars = 0;
  let tradesWithBars = 0;

  const recentClosedTrades = closedTrades.slice(-20).map((t) => {
    const isLong = t.action === 'LONG';
    const priceDiff = t.exitPrice ? (isLong ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice) : 0;
    const stopDistance = Math.abs(t.entryPrice - (t.stopLoss || (isLong ? t.entryPrice * 0.985 : t.entryPrice * 1.015)));
    const rMultiple = stopDistance > 0 ? Number((priceDiff / stopDistance).toFixed(2)) : undefined;
    const holdMs = (t.closedAt && t.openedAt && t.closedAt > t.openedAt) ? (t.closedAt - t.openedAt) : 0;
    const barsHeld = holdMs > 0 ? Math.max(1, Math.round(holdMs / (15 * 60 * 1000))) : 1;

    totalHoldBars += barsHeld;
    tradesWithBars++;

    return {
      id: t.id,
      symbol: t.symbol,
      action: t.action,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice || t.entryPrice,
      realizedPnlUsd: t.pnlUsd || 0,
      realizedPnlPct: t.pnlPct || 0,
      rMultiple,
      barsHeld,
      exitReason: t.status,
      closedAt: t.closedAt,
      confidence: t.confidence,
      strategyName: t.strategyName,
    };
  });

  const avgHoldBars = tradesWithBars > 0 ? Number((totalHoldBars / tradesWithBars).toFixed(1)) : 0;

  // 2. Compute AI Trap Shield counterfactual category breakdowns
  const vetoCategoryPerformance: Record<string, {
    totalVetoes: number;
    trueTraps: number;
    falseAlarms: number;
    accuracyPct: number;
  }> = {};

  for (const st of shadowTrades) {
    const cat = st.vetoCategory || 'GENERAL_VETO';
    if (!vetoCategoryPerformance[cat]) {
      vetoCategoryPerformance[cat] = {
        totalVetoes: 0,
        trueTraps: 0,
        falseAlarms: 0,
        accuracyPct: 100,
      };
    }
    vetoCategoryPerformance[cat].totalVetoes++;
    if (st.status === 'counterfactual_loss') {
      vetoCategoryPerformance[cat].trueTraps++;
    } else if (st.status === 'counterfactual_win') {
      vetoCategoryPerformance[cat].falseAlarms++;
    }
  }

  for (const cat of Object.keys(vetoCategoryPerformance)) {
    const item = vetoCategoryPerformance[cat];
    const resolved = item.trueTraps + item.falseAlarms;
    item.accuracyPct = resolved > 0 ? Number(((item.trueTraps / resolved) * 100).toFixed(1)) : 100;
  }

  // 3. Compute Per-Asset Win Rates & Expectancy
  const assetExpectancy: Record<string, {
    symbol: string;
    totalTrades: number;
    winRatePct: number;
    totalPnlUsd: number;
    scoreAdjustment: number;
    cooldownActive: boolean;
  }> = {};

  const allSymbols = Array.from(new Set([...watchPairs, ...closedTrades.map((t) => t.symbol)]));
  for (const sym of allSymbols) {
    const symTrades = closedTrades.filter((t) => t.symbol === sym);
    const total = symTrades.length;
    const wins = symTrades.filter((t) => (t.pnlUsd || 0) > 0).length;
    const winRate = total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0;
    const totalPnl = Number(symTrades.reduce((acc, t) => acc + (t.pnlUsd || 0), 0).toFixed(2));
    const directive = getSimPairDirective(sym);
    const cooldownActive = Boolean(directive?.coolOffActive);

    let scoreAdjustment = 0;
    if (total >= 3) {
      if (winRate >= 60) scoreAdjustment = 5;
      else if (winRate < 40) scoreAdjustment = -10;
    }

    assetExpectancy[sym] = {
      symbol: sym,
      totalTrades: total,
      winRatePct: winRate,
      totalPnlUsd: totalPnl,
      scoreAdjustment,
      cooldownActive,
    };
  }

  // 4. Lessons from Stop-Losses
  const lossTrades = closedTrades.filter((t) => (t.pnlUsd || 0) < 0 || t.status === 'closed_sl');
  const recentLossLessons = lossTrades.slice(-10).map((t) => {
    const exitReason = t.status || 'closed_sl';
    const regime = t.regime || 'MARKET_CHOP';
    const strat = t.strategyName || 'Momentum Strategy';
    const lesson = `${t.symbol} ${t.action} stopped out at $${t.exitPrice || t.entryPrice} (${t.pnlPct || 0}%). Strategy: "${strat}" under ${regime}. Entry at $${t.entryPrice}.`;

    return {
      symbol: t.symbol,
      action: t.action,
      pnlUsd: t.pnlUsd || 0,
      pnlPct: t.pnlPct || 0,
      lesson,
      exitReason,
      timestamp: (t as any).closedAt || (t as any).timestamp || 0,
    };
  });

  // 5. Open Positions & Gas / Collateral Status
  let gasApt = 0;
  try {
    const onChain = await tradeExecutor.fetchOnChainBalance();
    gasApt = onChain.aptBalance;
  } catch {}

  const openPositions = openTrades.map((t) => ({
    symbol: t.symbol,
    side: t.action,
    sizeUsd: t.sizeUsd,
    entryPrice: t.entryPrice,
    markPrice: t.exitPrice || t.entryPrice,
    unrealizedPnlUsd: t.pnlUsd || 0,
    unrealizedPnlPct: t.pnlPct || 0,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    leverage: t.leverage,
  }));

  const payload: ClientTelemetryPayload = {
    timestamp: Date.now(),
    clientId: config.CLIENT_ID,
    botId: config.CLIENT_ID,
    botName: config.CLIENT_NAME,
    source: 'live_mainnet',
    triggerReason,
    execution: {
      totalTradesClosed: stats.closedTradesCount,
      winRatePct: stats.winRate,
      totalNetRealizedPnlUsd: stats.totalPnlUsd,
      avgHoldBars,
      recentClosedTrades,
    },
    shadowTracking: {
      totalVetoed: shadowStats.totalVetoed,
      activeTracking: shadowStats.activeTracking,
      trueTrapsSaved: shadowStats.trueTrapsSaved,
      falseAlarmsKilled: shadowStats.counterfactualWins,
      precisionPct: shadowStats.precisionPct,
      estimatedSavedUsd: shadowStats.estimatedSavedUsd,
      estimatedMissedUsd: shadowStats.estimatedMissedUsd,
      vetoCategoryPerformance,
    },
    assetExpectancy,
    recentLossLessons,
    gasApt,
    budgetUsd: config.BUDGET_USD,
    openPositions,
    isConfigured: isClientConfigured(),
    onChain: {
      aptBalance: isClientConfigured() ? gasApt : 0,
      subaccount: isClientConfigured() ? (config.DECIBEL_SUBACCOUNT_ADDRESS || '') : '',
      signerAddress: isClientConfigured() ? (tradeExecutor.getSignerAddress() || getDerivedSignerAddress() || config.DECIBEL_OWNER_ADDRESS || '') : '',
    },
  } as any;

  return payload;
}

/**
 * Pushes live telemetry to the Central Alpha Server
 */
export async function pushTelemetry(
  triggerReason: ClientTelemetryPayload['triggerReason'] = 'periodic_sync'
): Promise<boolean> {
  try {
    // Feature 5: 8-Second Telemetry Heartbeat guard
    try {
      const { superchargeClient } = require('../simlab/supercharge-client');
      if (!superchargeClient.getFeatureFlags().syncTelemetry) {
        return false;
      }
    } catch {}

    const payload = await buildTelemetryPayload(triggerReason);

    const apiKey = process.env.CLIENT_API_KEY || process.env.SIMLAB_CONNECTION_TOKEN || config.CLIENT_API_KEY || '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Client-Id': config.CLIENT_ID,
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    }

    const { success, urlUsed } = await simConnectionManager.postTelemetry(payload, headers);

    if (success) {
      logger.info(
        `📤 [TELEMETRY FEEDER] Pushed live telemetry to ${urlUsed} (Win rate: ${payload.execution.winRatePct}%, Closed trades: ${payload.execution.totalTradesClosed}, Trigger: ${triggerReason})`
      );
      return true;
    }

    return false;
  } catch (err: any) {
    logger.warn(`⚠️ [TELEMETRY FEEDER] Telemetry push error: ${err.message}`);
    return false;
  }
}

/**
 * Starts the continuous outbound telemetry feeding loop and hooks trade close events
 */
export function startTelemetryFeeder(): void {
  if (feederTimer) {
    clearInterval(feederTimer);
    feederTimer = null;
  }

  const intervalMs = config.SIM_TELEMETRY_INTERVAL_MS || 30000;
  logger.info(`📡 [TELEMETRY FEEDER] Starting live telemetry feeder (interval ${intervalMs}ms) -> ${config.SIM_TELEMETRY_URL}`);

  // Hook into tradeExecutor events only once
  if (!isInitialized) {
    tradeExecutor.onTradeClosed((trade: TradeRecord) => {
      logger.info(`🔔 [TELEMETRY FEEDER] Immediate push triggered by closed trade: ${trade.symbol} (${trade.status})`);
      pushTelemetry('trade_closed').catch(() => {});
    });

    tradeExecutor.onShadowTradeResolved((shadow: ShadowTrade) => {
      logger.info(`👻 [TELEMETRY FEEDER] Immediate push triggered by resolved shadow trade: ${shadow.symbol} (${shadow.status})`);
      pushTelemetry('shadow_trade_resolved').catch(() => {});
    });

    isInitialized = true;
  }

  // Initial push immediately
  pushTelemetry('periodic_sync').catch(() => {});

  // Periodic recurring push
  feederTimer = setInterval(async () => {
    await pushTelemetry('periodic_sync').catch(() => {});
  }, intervalMs);
}

/**
 * Stops the outbound telemetry feeder loop
 */
export function stopTelemetryFeeder(): void {
  if (feederTimer) {
    clearInterval(feederTimer);
    feederTimer = null;
    logger.info('🛑 [TELEMETRY FEEDER] Live telemetry feeder stopped.');
  }
}
