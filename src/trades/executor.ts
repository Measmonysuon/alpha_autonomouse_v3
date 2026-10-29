/**
 * Decibel DEX Order Executor & Paper Trading Engine
 * 
 * Capabilities:
 *  1. Pre-Trade Validation against RiskGuard (banned direction, wicks, score floor, budget cap)
 *  2. Direct On-Chain Execution on Decibel DEX via official Aptos TS SDK using delegate key
 *  3. Fallback execution via Decibel MCP if available
 *  4. Zero-Risk Local Paper Trading mode (PAPER_TRADING=true)
 *  5. Automatic Stop Loss (1.5x ATR) and Take Profit (2.5x ATR) management
 *  6. Atomic persistence to data/trades.json
 */

import fs from 'fs';
import path from 'path';
import { Account, Ed25519PrivateKey, Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import {
  createAptosClient,
  triggerNodeKeyFailover,
  isNodeRateLimitOrAuthError,
} from '../utils/node-key-resolver';
import { config, isClientConfigured, getDerivedSignerAddress } from '../config';
import { logger } from '../utils/logger';
import { StandaloneSignal, standaloneEngine } from '../engine/standalone-engine';
import { AIBrainEvaluation } from '../ai/brain';
import { riskGuard, RiskValidationResult } from '../risk/guard';
import { mcpClient, quantizeOrderParameters } from '../mcp/client';
import { telegramNotifier } from '../notify/telegram';
import type { StrategyAttribution } from '../strategy/types';
import { getSimPairDirective } from '../strategy/manager';
import { dbClient } from '../db/database';

export interface TradeLifecycleEvent {
  timestamp: number;
  stage: 'ENTRY' | 'SCALE_OUT_TP1' | 'RATCHET_ADVANCE' | 'HARVEST' | 'EXIT';
  title: string;
  description: string;
  price?: number;
  pnlUsd?: number;
  details?: string[];
}

export interface TradeRecord {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  action: 'LONG' | 'SHORT';
  entryPrice: number;
  takeProfit: number;
  takeProfit1?: number;
  takeProfit2?: number;
  dynamicTakeProfit?: number;
  isDualTp?: boolean;
  stopLoss: number;
  sizeUsd: number;
  sizeBase: number;
  leverage: number;
  allocatedUsd: number;
  confidence: number;
  executionProfile?: 'STANDARD_SWING';
  microTargetProfitUsd?: number;
  orderId?: string;
  txHash?: string;
  status: 'open' | 'closed_tp' | 'closed_sl' | 'closed_manual';
  isPaper: boolean;
  openedAt: number;
  closedAt?: number;
  exitPrice?: number;
  pnlUsd?: number;
  isManual?: boolean;
  pnlPct?: number;
  strategyName?: string;
  regime?: string;
  strategyAttribution?: StrategyAttribution;
  notes?: string;
  exitReason?: string;
  tx_version?: string;
  entryRationale?: string;
  strategyTags?: string[];
  hardStopLoss?: number;
  softRatchetPrice?: number;
  estimatedLiquidationPrice?: number;
  estimatedProfitPct?: number;
  estimatedLossPct?: number;
  estimatedWinRatePct?: number;
  lifecycleEvents?: TradeLifecycleEvent[];
  exitSummary?: string;
  tp1Hit?: boolean;
  breakevenMoved?: boolean;
  barsHeld?: number;
  partialRealizedPnlUsd?: number;
  atr?: number;
  grossPnlUsd?: number;
  netPnlUsd?: number;
  feeUsd?: number;
  currentPrice?: number;
  unrealizedPnlUsd?: number;
  unrealizedPnlPct?: number;
  isMaker?: boolean;
  routing?: string;
  onChainTpSlSecured?: boolean;
  stagnationRatchetApplied?: boolean;
  ratchetLevel?: number;
}

export interface ShadowTrade {
  id: string;
  symbol: string;
  action: 'LONG' | 'SHORT';
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  confidence: number;
  vetoCategory: 'AI_REJECTED' | 'BUDGET_EXHAUSTED' | 'MAX_POSITIONS' | 'DIRECTIONAL_BAN' | 'SEMI_AUTO_HOLD' | 'RISK_GUARD' | 'SIM_COUNTERFACTUAL_VETO' | 'BULL_TRAP' | 'BEAR_TRAP' | 'CVD_DISTRIBUTION_TRAP' | 'CVD_ABSORPTION_TRAP' | 'SHORT_SQUEEZE_EXHAUSTION' | 'LONG_SQUEEZE_FLUSH' | 'BULL_TRAP_OVERCROWDING' | 'BEAR_TRAP_OVERCROWDING' | 'MARKET_COOLING' | 'MACRO_NEWS_WHIPSAW' | string;
  vetoReason: string;
  status: 'tracking' | 'counterfactual_win' | 'counterfactual_loss';
  hypotheticalPnlPct: number;
  openedAt: number;
  closedAt?: number;
}

export interface TradeDatabase {
  trades: TradeRecord[];
  shadowTrades?: ShadowTrade[];
  lastUpdated: number;
}

const TRADES_FILE_PATH = path.resolve(process.cwd(), 'data/trades.json');

export class TradeExecutor {
  private aptos?: Aptos;
  private aptosAccount?: Account;
  private tradesCache: TradeRecord[] = [];
  private shadowTradesCache: ShadowTrade[] = [];
  private onTradeClosedListeners: Array<(trade: TradeRecord) => void> = [];
  private onShadowTradeResolvedListeners: Array<(shadow: ShadowTrade) => void> = [];
  private missingOnChainCount: Map<string, number> = new Map();
  private missingFirstSeenAt: Map<string, number> = new Map();
  private inFlightSymbols: Set<string> = new Set();
  private configuredLeverages: Map<string, number> = new Map();
  private autoArmCooldownMap: Map<string, number> = new Map();

  constructor() {
    this.ensureDataDirectory();
    this.loadTrades();
    this.initAptosSigner();
  }

  public markExecutionInFlight(symbol: string, durationMs?: number): void {
    const key = symbol.replace('-', '/').toUpperCase();
    this.inFlightSymbols.add(key);
    if (durationMs && durationMs > 0) {
      setTimeout(() => this.inFlightSymbols.delete(key), durationMs);
    }
  }

  public clearExecutionInFlight(symbol: string): void {
    this.inFlightSymbols.delete(symbol.replace('-', '/').toUpperCase());
  }

  public isExecutionInFlight(symbol: string): boolean {
    return this.inFlightSymbols.has(symbol.replace('-', '/').toUpperCase());
  }

  /**
   * Ensure leverage is configured on Decibel DEX subaccount for the market before trading.
   * Authoritative Business Rule:
   * 1. If Bot >= Exchange Market Max: Execute at highest exchange allows (marketMax).
   * 2. If Bot < Exchange Market Max: Configure exact Bot leverage.
   * 3. If on-chain leverage would remain higher than Bot leverage: FAIL CLOSED / NO TRADE.
   * 4. If leverage setting fails or cannot be verified: FAIL CLOSED / NO TRADE.
   */
  public async ensureLeverageConfigured(symbol: string, targetLeverage: number): Promise<number> {
    const symKey = symbol.replace('-', '/').toUpperCase();
    const desired = Math.max(1, Math.min(100, Math.round(targetLeverage)));

    // Discover authoritative on-chain market maximum leverage
    let marketMax = 10;
    try {
      const market = await mcpClient.getMarketDetail(symbol);
      if (market?.maxLeverage && market.maxLeverage > 0) {
        marketMax = market.maxLeverage;
      }
    } catch {}

    // Rule 1: If bot wants 10x and exchange allows lower (e.g. 5x), execute highest exchange allows
    let effectiveTarget = desired;
    if (desired >= marketMax) {
      effectiveTarget = marketMax;
      if (desired > marketMax) {
        logger.info(`⚙️ [LEVERAGE RULE] Bot requested ${desired}x >= market max (${marketMax}x) for ${symKey}. Clamping to highest exchange allows: ${marketMax}x.`);
      }
    }

    if (this.configuredLeverages.get(symKey) === effectiveTarget) {
      return effectiveTarget;
    }

    try {
      logger.info(`⚙️ [EXECUTOR] Configuring on-chain leverage for ${symKey} to ${effectiveTarget}x (cross margin)...`);
      await mcpClient.setLeverage(symKey, effectiveTarget, 'cross');
      this.configuredLeverages.set(symKey, effectiveTarget);
      logger.info(`✅ [EXECUTOR] On-chain leverage successfully set to ${effectiveTarget}x for ${symKey}`);
      return effectiveTarget;
    } catch (err: any) {
      const msg = String(err?.message || '');
      const match = msg.match(/exceeds maximum (\d+)x/i);
      if (match && match[1]) {
        const parsedMax = parseInt(match[1], 10);
        if (parsedMax > 0 && parsedMax <= effectiveTarget) {
          try {
            logger.warn(`⚠️ [EXECUTOR] Leverage clamped to on-chain ceiling ${parsedMax}x for ${symKey}...`);
            await mcpClient.setLeverage(symKey, parsedMax, 'cross');
            this.configuredLeverages.set(symKey, parsedMax);
            logger.info(`✅ [EXECUTOR] On-chain leverage confirmed at ${parsedMax}x for ${symKey}`);
            return parsedMax;
          } catch (clampErr: any) {
            logger.error(`🚨 [EXECUTOR] Failed to set clamped leverage for ${symKey}: ${clampErr.message}`);
          }
        }
      }

      // FAIL CLOSED: Never proceed with trade when leverage configuration fails!
      logger.error(`🚨 [LEVERAGE VETO] Cannot configure ${effectiveTarget}x on Decibel DEX for ${symKey}: ${err.message}. Trade aborted to protect capital.`);
      throw new Error(`LEVERAGE_CONFIG_REJECTED: ${err.message}`);
    }
  }

  public onTradeClosed(listener: (trade: TradeRecord) => void): void {
    this.onTradeClosedListeners.push(listener);
  }

  public onShadowTradeResolved(listener: (shadow: ShadowTrade) => void): void {
    this.onShadowTradeResolvedListeners.push(listener);
  }

  public notifyTradeClosed(trade: TradeRecord): void {
    const isStopHit = trade.status === 'closed_sl' || (trade.pnlUsd !== undefined && trade.pnlUsd <= -0.30) || (trade.exitReason && trade.exitReason.includes('SL'));
    if (isStopHit) {
      const reason = `Stop hit (PnL: $${trade.pnlUsd?.toFixed(2) ?? 'N/A'}, Exit: ${trade.exitReason || trade.status}). 45m post-stop fleet quarantine active.`;
      riskGuard.triggerL4TrapCoolOff(trade.symbol, trade.action, 'STOP_LOSS_REVERSAL', reason, 45);
      try {
        const { pushInstantVeto } = require('../pipeline/telemetry-feeder');
        pushInstantVeto(trade.symbol, trade.action, 'STOP_LOSS_REVERSAL', reason, 45).catch(() => {});
      } catch {}
    }

    for (const fn of this.onTradeClosedListeners) {
      try {
        fn(trade);
      } catch (err: any) {
        logger.error(`Trade closed listener error: ${err.message}`);
      }
    }
  }

  public notifyShadowTradeResolved(shadow: ShadowTrade): void {
    for (const fn of this.onShadowTradeResolvedListeners) {
      try {
        fn(shadow);
      } catch (err: any) {
        logger.error(`Shadow trade resolved listener error: ${err.message}`);
      }
    }
  }

  private ensureDataDirectory(): void {
    const dir = path.dirname(TRADES_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private initAptosSigner(): void {
    if (config.PAPER_TRADING) {
      logger.info('📝 [EXECUTOR] Running in PAPER TRADING mode. Fills simulated in data/trades.json.');
      return;
    }

    const key = config.DECIBEL_DELEGATE_KEY || config.DECIBEL_PRIVATE_KEY;
    if (!key) {
      logger.warn('⚠️ [EXECUTOR] No Decibel delegate key found. Defaulting to PAPER TRADING mode.');
      return;
    }

    try {
      const cleanPk = key.replace(/^ed25519-priv-/, '');
      const pk = new Ed25519PrivateKey(cleanPk);
      this.aptosAccount = Account.fromPrivateKey({ privateKey: pk });

      const net = config.NETWORK === 'testnet' ? Network.TESTNET : Network.MAINNET;
      this.aptos = createAptosClient(net);
      const signerAddr = this.aptosAccount.accountAddress.toString();
      logger.info(`🔑 [EXECUTOR] Aptos signer initialized for delegate address: ${signerAddr}`);

      // Async APT balance check — warn if no gas fees available
      this.aptos.getAccountAPTAmount({ accountAddress: signerAddr }).then((octas: bigint | number) => {
        const apt = Number(octas) / 1e8;
        if (apt < 0.001) {
          logger.warn(
            `⛽ [EXECUTOR] CRITICAL: Delegate wallet has only ${apt.toFixed(6)} APT. ` +
            `On-chain transactions will FAIL — please fund ${signerAddr} with APT for gas fees.`
          );
        } else {
          logger.info(`⛽ [EXECUTOR] Delegate APT balance: ${apt.toFixed(4)} APT (sufficient for gas).`);
        }
      }).catch(() => {
        logger.warn(`⛽ [EXECUTOR] Could not verify APT gas balance for delegate ${signerAddr}. Ensure wallet is funded.`);
      });
    } catch (err: any) {
      logger.error(`❌ [EXECUTOR] Failed to initialize Aptos SDK signer: ${err.message}`);
    }
  }

  public reinitAptos(): void {
    const net = config.NETWORK === 'testnet' ? Network.TESTNET : Network.MAINNET;
    this.aptos = createAptosClient(net);
    logger.info(`🔌 [EXECUTOR] Aptos client re-initialized with active gateway / proxy.`);
  }

  public getAptos(): Aptos {
    if (!this.aptos) {
      const net = config.NETWORK === 'testnet' ? Network.TESTNET : Network.MAINNET;
      this.aptos = createAptosClient(net);
    }
    return this.aptos;
  }

  public reinitializeSigner(): void {
    logger.info('🔄 [EXECUTOR] Reinitializing Aptos signer with latest credentials...');
    this.initAptosSigner();
  }

  /**
   * Returns the actual live on-chain gas fee / signer address.
   * Derived from the initialized Aptos account or delegate private key.
   */
  public getSignerAddress(): string {
    if (this.aptosAccount) {
      return this.aptosAccount.accountAddress.toString();
    }
    const derived = getDerivedSignerAddress();
    if (derived) {
      return derived;
    }
    const owner = config.DECIBEL_OWNER_ADDRESS || '';
    if (owner && !owner.includes('your_') && owner.startsWith('0x') && owner.length > 10) {
      return owner;
    }
    return '';
  }

  // ── Database Operations (data/trades.json) ──────────────────────────────────

  public loadTrades(): TradeRecord[] {
    if (!isClientConfigured()) {
      this.tradesCache = [];
      this.shadowTradesCache = [];
      return [];
    }
    try {
      if (fs.existsSync(TRADES_FILE_PATH)) {
        const raw = fs.readFileSync(TRADES_FILE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        this.tradesCache = Array.isArray(parsed) ? parsed : (parsed.trades || []);
        this.shadowTradesCache = Array.isArray(parsed.shadowTrades) ? parsed.shadowTrades : [];
      } else {
        this.tradesCache = [];
        this.shadowTradesCache = [];
      }
    } catch (err: any) {
      logger.error(`Failed to read ${TRADES_FILE_PATH}: ${err.message}`);
      this.tradesCache = [];
      this.shadowTradesCache = [];
    }

    // Hydrate & merge from SQLite database so all executed & on-chain trades are collected
    try {
      const sqliteTrades = dbClient.getTrades({ limit: 1000 });
      if (sqliteTrades && sqliteTrades.length > 0) {
        const sqliteIdSet = new Set(sqliteTrades.map(s => s.id));
        // Prune any cache items that were deleted or pruned from SQLite
        this.tradesCache = this.tradesCache.filter(t => sqliteIdSet.has(t.id));
        const cacheMap = new Map(this.tradesCache.map(t => [t.id, t]));
        for (const st of sqliteTrades) {
          const grossPnl = Number(st.realized_pnl || 0);
          const feeUsd = Number(st.fee_usd || 0);
          // Authoritative on-chain Net Realized PnL = Gross PnL minus on-chain protocol fees
          const netPnl = grossPnl - feeUsd;

          const rawStatus = (st.status || 'closed').toLowerCase();
          let status: 'open' | 'closed_tp' | 'closed_sl' | 'closed_manual' =
            rawStatus.includes('open') ? 'open' :
              rawStatus.includes('tp') ? 'closed_tp' :
                rawStatus.includes('sl') ? 'closed_sl' : 'closed_manual';

          // Authoritative Ledger Rectification: Never allow a trade with net loss to remain 'closed_tp'
          if (status === 'closed_tp' && netPnl < -0.0001) {
            status = 'closed_sl';
          }
          let rectifiedExitReason = st.exit_reason;
          if (status !== 'open' && netPnl < -0.0001 && rectifiedExitReason && (rectifiedExitReason.toUpperCase().includes('TP') || rectifiedExitReason.toUpperCase().includes('HARVEST') || rectifiedExitReason.toUpperCase().includes('TRAILING'))) {
            rectifiedExitReason = 'ON_CHAIN_SL';
          }
          const existing = cacheMap.get(st.id);

          if (!existing) {
            const trade: TradeRecord = {
              id: st.id,
              symbol: st.symbol,
              side: st.side as 'buy' | 'sell',
              action: st.action as 'LONG' | 'SHORT',
              entryPrice: st.entry_price,
              exitPrice: st.exit_price ?? undefined,
              takeProfit: 0,
              stopLoss: 0,
              sizeUsd: Number(((st.entry_price || 0) * (st.size || 0)).toFixed(2)),
              sizeBase: st.size,
              leverage: st.leverage ?? 1,
              allocatedUsd: st.allocated_usd ?? 0,
              confidence: st.confidence ?? 85,
              orderId: st.client_order_id || st.id,
              txHash: st.tx_version ?? undefined,
              tx_version: st.tx_version ?? undefined,
              status,
              isPaper: false,
              openedAt: st.opened_at,
              closedAt: st.closed_at ?? undefined,
              pnlUsd: netPnl,
              netPnlUsd: netPnl,
              grossPnlUsd: grossPnl,
              feeUsd: feeUsd,
              pnlPct: st.realized_pnl_pct !== null && st.realized_pnl_pct !== undefined ? Number(st.realized_pnl_pct) : undefined,
              strategyName: st.strategy_name ?? 'Decibel Autonomous Trade',
              exitReason: rectifiedExitReason ?? undefined,
              notes: rectifiedExitReason ?? undefined,
              // Authoritative manual flag from DB — 1 = human-placed trade
              isManual: st.is_manual === 1,
            };
            this.tradesCache.push(trade);
            cacheMap.set(st.id, trade);
          } else {
            existing.pnlUsd = netPnl;
            existing.netPnlUsd = netPnl;
            existing.grossPnlUsd = grossPnl;
            existing.feeUsd = feeUsd;
            existing.status = status;
            if (status !== 'open' && netPnl < -0.0001 && existing.exitReason && (existing.exitReason.toUpperCase().includes('TP') || existing.exitReason.toUpperCase().includes('HARVEST') || existing.exitReason.toUpperCase().includes('TRAILING'))) {
              existing.exitReason = 'ON_CHAIN_SL';
            }
            existing.sizeBase = st.size || existing.sizeBase;
            existing.entryPrice = st.entry_price || existing.entryPrice;
            // Always refresh the manual flag from DB in case it was updated
            existing.isManual = st.is_manual === 1;
            if (st.exit_price) existing.exitPrice = st.exit_price;
            if (st.closed_at) existing.closedAt = st.closed_at;
            if (st.tx_version) existing.txHash = st.tx_version;
          }
        }
      }
    } catch (err: any) {
      logger.debug(`SQLite trades sync to cache: ${err.message}`);
    }

    return this.tradesCache;
  }

  public saveTrades(): void {
    try {
      this.ensureDataDirectory();
      const payload: TradeDatabase = {
        trades: this.tradesCache,
        shadowTrades: this.shadowTradesCache.slice(-100),
        lastUpdated: Date.now(),
      };
      fs.writeFileSync(TRADES_FILE_PATH, JSON.stringify(payload, null, 2), 'utf8');

      // Mirror directly to SQLite database for ultra-fast queries
      for (const t of this.tradesCache) {
        try {
          dbClient.upsertTrade({
            id: t.id,
            client_order_id: t.orderId || t.id,
            tx_version: t.txHash,
            symbol: t.symbol,
            side: t.side,
            action: t.action,
            is_manual: (t.notes?.includes('Manual') || t.strategyName?.includes('Manual')) ? 1 : 0,
            entry_price: t.entryPrice,
            exit_price: t.exitPrice,
            size: t.sizeBase,
            allocated_usd: t.allocatedUsd,
            leverage: t.leverage,
            realized_pnl: t.grossPnlUsd !== undefined ? t.grossPnlUsd : (t.pnlUsd || 0),
            fee_usd: t.feeUsd || 0,
            realized_pnl_pct: t.pnlPct || 0,
            status: t.status ? t.status.toUpperCase() : 'OPEN',
            opened_at: t.openedAt,
            closed_at: t.closedAt,
            strategy_name: t.strategyName,
            confidence: t.confidence,
            exit_reason: t.exitReason || t.notes,
          });
        } catch { }
      }
    } catch (err: any) {
      logger.error(`Failed to write ${TRADES_FILE_PATH}: ${err.message}`);
    }
  }

  public getOpenTrades(): TradeRecord[] {
    return this.tradesCache.filter((t) => t.status === 'open');
  }

  public getClosedTrades(): TradeRecord[] {
    return this.tradesCache.filter((t) => t.status !== 'open');
  }

  /**
   * Sync and reconcile active on-chain positions from Decibel DEX into local tradesCache.
   * Guarantees that trades placed externally or on remote servers (Finland/Mac/Web)
   * are immediately tracked, visible in the UI, and pushed to Sim Lab telemetry.
   */
  public async syncOnChainPositions(): Promise<TradeRecord[]> {
    if (!isClientConfigured() || config.PAPER_TRADING) {
      return this.getOpenTrades();
    }
    try {
      if (!mcpClient.isConnected()) {
        await mcpClient.connect().catch(() => { });
      }
      const onChainList = await mcpClient.getPositions();
      if (!Array.isArray(onChainList)) return this.getOpenTrades();

      let modified = false;
      const onChainSymbols = new Set(
        onChainList.flatMap((p) => [
          p.symbol.toUpperCase(),
          p.symbol.replace('-', '/').toUpperCase(),
          p.symbol.replace('/', '-').toUpperCase(),
        ])
      );

      // 1. Ingest any on-chain position that is not currently open in local cache
      for (const pos of onChainList) {
        const symNorm = pos.symbol.replace('-', '/').toUpperCase();
        if (this.isExecutionInFlight(symNorm)) {
          logger.debug(`[RECONCILE] Skipping ingestion for ${pos.symbol}: order execution currently in-flight by agent`);
          continue;
        }

        let existing = this.tradesCache.find(
          (t) => t.symbol.replace('-', '/').toUpperCase() === symNorm && t.status === 'open',
        );
        const isLong = existing ? existing.action === 'LONG' : (pos.action === 'LONG' || pos.side === 'buy');

        const lev = Math.max(1, pos.leverage || existing?.leverage || 1);
        // 1. Static Hard Stop Loss (15% margin risk / catastrophic on-chain circuit breaker)
        const staticHardSl = isLong
          ? Number((pos.entryPrice * (1 - 0.15 / lev)).toFixed(4))
          : Number((pos.entryPrice * (1 + 0.15 / lev)).toFixed(4));
        const hardSl = (pos.stopLoss && pos.stopLoss > 0) ? pos.stopLoss : staticHardSl;

        // 2. Dynamic Soft SL buffer: sits between entry and hard SL (~1.2% - 1.8% price move)
        const softSlDist = Math.min(pos.entryPrice * 0.02, Math.max(pos.entryPrice * 0.008, Math.abs(pos.entryPrice - staticHardSl) * 0.35));
        const initialSoftSl = isLong
          ? Number((pos.entryPrice - softSlDist).toFixed(4))
          : Number((pos.entryPrice + softSlDist).toFixed(4));
        const ratchetedSl = existing?.stopLoss && existing.stopLoss > 0 ? existing.stopLoss : 0;
        let activeSl = ratchetedSl > 0 ? ratchetedSl : initialSoftSl;
        if (isLong && ratchetedSl > 0 && initialSoftSl > 0) {
          activeSl = Math.max(ratchetedSl, initialSoftSl);
        } else if (!isLong && ratchetedSl > 0 && initialSoftSl > 0) {
          activeSl = Math.min(ratchetedSl, initialSoftSl);
        }
        let softRatchet = existing?.softRatchetPrice && existing.softRatchetPrice > 0
          ? (isLong ? Math.max(existing.softRatchetPrice, activeSl) : Math.min(existing.softRatchetPrice, activeSl))
          : activeSl;
        // Invariant: If trade has NOT locked breakeven/profit, softRatchet MUST NOT sit above entry price
        if (!existing || !existing.breakevenMoved) {
          if (isLong && softRatchet >= pos.entryPrice) softRatchet = activeSl;
          else if (!isLong && softRatchet <= pos.entryPrice) softRatchet = activeSl;
        }

        // 3. Dynamic Take Profit (anchored to 1.5x - 2.0x ATR, ~1.5% - 2.2% price move)
        const dynamicTpDist = Math.min(pos.entryPrice * 0.025, Math.max(pos.entryPrice * 0.012, softSlDist * 1.5));
        const dynamicTp = isLong
          ? Number((pos.entryPrice + dynamicTpDist).toFixed(4))
          : Number((pos.entryPrice - dynamicTpDist).toFixed(4));

        // Strict Directional Invariant: Long TP must be > entry; Short TP must be < entry
        const isPosTpDirectionallyValid = pos.takeProfit && pos.takeProfit > 0 &&
          (isLong ? pos.takeProfit >= pos.entryPrice * 1.008 : pos.takeProfit <= pos.entryPrice * 0.992) &&
          Math.abs(pos.takeProfit - pos.entryPrice) / pos.entryPrice <= 0.04;

        const activeTp = isPosTpDirectionallyValid
          ? pos.takeProfit
          : dynamicTp;

        // If not found open, check if a recent closed trade can be revived (only if un-intentional RPC dropout)
        let recentClosed: TradeRecord | undefined;
        if (!existing) {
          recentClosed = this.tradesCache.find(
            (t) => t.symbol.replace('-', '/').toUpperCase() === symNorm && t.status !== 'open' && (t.closedAt ? Date.now() - t.closedAt < 600000 : false),
          );
          if (recentClosed) {
            const isIntentionalClose = recentClosed.exitReason && !['ON_CHAIN_DEX_CLOSE', 'DEX_EXTERNAL', 'EXTERNAL_INDEXER_DROPOUT'].includes(recentClosed.exitReason);
            if (!isIntentionalClose && (recentClosed.closedAt ? Date.now() - recentClosed.closedAt < 30000 : false)) {
              recentClosed.status = 'open';
              delete recentClosed.closedAt;
              delete recentClosed.exitPrice;
              delete recentClosed.exitReason;
              if (recentClosed.stopLoss <= 0) {
                recentClosed.stopLoss = softRatchet;
              }
              existing = recentClosed;
              modified = true;
              logger.info(`🔄 [RECONCILE] Restored persistent open position: ${existing.symbol} ${existing.action} (id: ${existing.id})`);
            } else if (isIntentionalClose) {
              logger.warn(`⚠️ [RECONCILE] Position ${pos.symbol} was intentionally closed locally (${recentClosed.exitReason}) but remains in DEX state. Retrying on-chain close...`);
              mcpClient.closePosition(pos.symbol).catch((err: any) => {
                logger.error(`[RECONCILE] Failed to retry on-chain close for ${pos.symbol}: ${err.message}`);
              });
              // Do NOT set existing and do NOT ingest a duplicate trade
              continue;
            }
          }
        }

        const simDirectives = standaloneEngine.getDirectives();
        const simStratName = simDirectives?.activeStrategy || '6-Pillar Fleet CIO V10 - Regime-Adaptive Bi-Directional EV';
        const simStratId = 'ai_strategy_1790652542785';
        const simStratAttribution: StrategyAttribution = {
          strategyId: simStratId,
          strategyName: simStratName,
          isPairOverride: false,
          layersActive: { layer1: true, layer2: true, layer3: true, layer4: true, layer5: true },
        };

        if (!existing) {
          const newTrade: TradeRecord = {
            id: `decibel-onchain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            symbol: pos.symbol,
            side: isLong ? 'buy' : 'sell',
            action: isLong ? 'LONG' : 'SHORT',
            entryPrice: pos.entryPrice || 0,
            takeProfit: activeTp,
            stopLoss: softRatchet,
            hardStopLoss: hardSl,
            softRatchetPrice: softRatchet,
            estimatedLiquidationPrice: pos.liquidationPrice,
            sizeUsd: pos.sizeUsd || (pos.sizeBase * (pos.entryPrice || 0)),
            sizeBase: pos.sizeBase || 0,
            leverage: pos.leverage || 1,
            allocatedUsd: pos.allocatedUsd || ((pos.sizeUsd || 0) / (pos.leverage || 1)),
            confidence: 85,
            status: 'open',
            isPaper: false,
            openedAt: Date.now(),
            strategyName: (recentClosed?.strategyName && !recentClosed.strategyName.includes('On-Chain'))
              ? recentClosed.strategyName
              : simStratName,
            strategyAttribution: simStratAttribution,
            notes: 'Reconciled directly from Aptos on-chain DEX state',
            estimatedProfitPct: (activeTp && pos.entryPrice) ? Number((Math.abs((activeTp - pos.entryPrice) / pos.entryPrice) * 100 * (pos.leverage || 1)).toFixed(1)) : 7.5,
            estimatedLossPct: softRatchet && pos.entryPrice ? Number((Math.abs((pos.entryPrice - softRatchet) / pos.entryPrice) * 100 * (pos.leverage || 1)).toFixed(1)) : 5.3,
            estimatedWinRatePct: 85,
          };
          this.tradesCache.push(newTrade);
          modified = true;
          logger.info(`🔄 [RECONCILE] Ingested live on-chain position: ${newTrade.symbol} ${newTrade.action} (${newTrade.sizeBase} units @ $${newTrade.entryPrice}, ${newTrade.leverage}x) [Strategy: ${newTrade.strategyName} | TP: $${activeTp} | Hard SL: $${hardSl} | Soft Ratchet: $${softRatchet}]`);
        } else {
          // ALWAYS update live on-chain leverage, position size, and margin for existing/restored positions
          if (pos.leverage && pos.leverage > 0 && existing.leverage !== pos.leverage) {
            logger.info(`⚙️ [RECONCILE] Updating ${existing.symbol} leverage to on-chain: ${existing.leverage}x → ${pos.leverage}x`);
            existing.leverage = pos.leverage;
            modified = true;
          }
          if (pos.sizeBase && pos.sizeBase > 0 && Math.abs(existing.sizeBase - pos.sizeBase) > 0.0001) {
            logger.info(`⚙️ [RECONCILE] Updating ${existing.symbol} sizeBase to on-chain: ${existing.sizeBase} → ${pos.sizeBase}`);
            existing.sizeBase = pos.sizeBase;
            existing.sizeUsd = pos.sizeUsd || (pos.sizeBase * (pos.entryPrice || existing.entryPrice));
            modified = true;
          }
          if (pos.allocatedUsd && pos.allocatedUsd > 0 && Math.abs((existing.allocatedUsd || 0) - pos.allocatedUsd) > 0.01) {
            existing.allocatedUsd = pos.allocatedUsd;
            modified = true;
          }
          if (pos.unrealizedPnl !== undefined) {
            existing.unrealizedPnlUsd = Number(pos.unrealizedPnl.toFixed(4));
            const alloc = existing.allocatedUsd || 1;
            existing.unrealizedPnlPct = Number(((pos.unrealizedPnl / alloc) * 100).toFixed(2));
            existing.pnlUsd = Number(pos.unrealizedPnl.toFixed(4));
            existing.netPnlUsd = Number(pos.unrealizedPnl.toFixed(4));
          }
          if (pos.markPrice && pos.markPrice > 0) {
            existing.currentPrice = pos.markPrice;
          }
          // Update strategy name and attribution if generic, template default, or out-of-sync with active Sim Lab directive
          const isGenericStrat = !existing.strategyName ||
            existing.strategyName === 'Decibel On-Chain Position' ||
            existing.strategyName === 'Autonomous Engine' ||
            existing.strategyName === 'Decibel Autonomous Trade' ||
            existing.strategyName === 'Turtle Soup & Liquidity Grab' ||
            (existing.id.startsWith('decibel-onchain-') && existing.strategyName !== simStratName);

          if (isGenericStrat && simStratName) {
            logger.info(`🏷️ [RECONCILE] Updating ${existing.symbol} strategy name to active Sim Lab directive: "${simStratName}"`);
            existing.strategyName = simStratName;
            existing.strategyAttribution = simStratAttribution;
            modified = true;
          }
          const refEntry = pos.entryPrice || existing.entryPrice;
          const isExistingLong = existing.action === 'LONG';
          const isTpDirectionallySane = (tp: number) =>
            isExistingLong ? (tp >= refEntry * 1.008) : (tp <= refEntry * 0.992);

          const isTpUnrealistic = existing.takeProfit > 0 &&
            (!isTpDirectionallySane(existing.takeProfit) || Math.abs(existing.takeProfit - refEntry) / refEntry > 0.04);

          if (!existing.takeProfit || existing.takeProfit <= 0 || isTpUnrealistic) {
            const oldTp = existing.takeProfit;
            const validOnChainTp = pos.takeProfit && pos.takeProfit > 0 && isTpDirectionallySane(pos.takeProfit) && Math.abs(pos.takeProfit - refEntry) / refEntry <= 0.04;
            existing.takeProfit = validOnChainTp
              ? pos.takeProfit!
              : (isExistingLong ? Number((refEntry + dynamicTpDist).toFixed(4)) : Number((refEntry - dynamicTpDist).toFixed(4)));
            modified = true;
            logger.info(`🎯 [DYNAMIC TP REALIGN] Calibrated TP for ${existing.symbol}: $${oldTp} → $${existing.takeProfit}`);
          } else if (pos.takeProfit && pos.takeProfit !== existing.takeProfit && isTpDirectionallySane(pos.takeProfit)) {
            existing.takeProfit = pos.takeProfit;
            modified = true;
          }
          if (pos.stopLoss && pos.stopLoss > 0) {
            // pos.stopLoss from DEX is the on-chain catastrophic Hard SL
            if (existing.hardStopLoss !== pos.stopLoss) {
              logger.info(`🛡️ [RECONCILE] Updating ${existing.symbol} Hard SL from DEX: $${existing.hardStopLoss} → $${pos.stopLoss}`);
              existing.hardStopLoss = pos.stopLoss;
              modified = true;
            }
          }
          if (pos.entryPrice && Math.abs(pos.entryPrice - existing.entryPrice) > 0.0001) {
            existing.entryPrice = pos.entryPrice;
            modified = true;
          }
          if (!existing.hardStopLoss || existing.hardStopLoss <= 0) {
            existing.hardStopLoss = hardSl;
            modified = true;
          }
          // Calibrate dynamic stop loss to protected ATR level if missing or stuck at wide hard SL
          if (!existing.breakevenMoved && (!existing.stopLoss || existing.stopLoss <= 0 || Math.abs(existing.stopLoss - staticHardSl) / staticHardSl < 0.015)) {
            existing.stopLoss = initialSoftSl;
            existing.softRatchetPrice = initialSoftSl;
            modified = true;
          }
          if (existing.softRatchetPrice && existing.softRatchetPrice > 0) {
            const isLong = existing.action === 'LONG';
            // Invariant: If trade has NOT locked breakeven/profit, ratchet MUST NOT sit above entry price
            if (!existing.breakevenMoved) {
              const maxSoft = isLong ? existing.entryPrice * 0.997 : (existing.hardStopLoss || hardSl) * 0.998;
              const minSoft = isLong ? (existing.hardStopLoss || hardSl) * 1.002 : existing.entryPrice * 1.003;
              if (isLong) {
                if (minSoft < maxSoft) {
                  existing.stopLoss = Number(Math.max(minSoft, Math.min(maxSoft, existing.stopLoss || initialSoftSl)).toFixed(4));
                } else {
                  const target = existing.stopLoss || initialSoftSl;
                  existing.stopLoss = Number(Math.max(hardSl, Math.min(existing.entryPrice * 0.999, target)).toFixed(4));
                }
              } else {
                if (minSoft < maxSoft) {
                  existing.stopLoss = Number(Math.min(maxSoft, Math.max(minSoft, existing.stopLoss || initialSoftSl)).toFixed(4));
                } else {
                  const target = existing.stopLoss || initialSoftSl;
                  existing.stopLoss = Number(Math.min(hardSl, Math.max(existing.entryPrice * 1.001, target)).toFixed(4));
                }
              }
              existing.softRatchetPrice = existing.stopLoss;
            } else {
              // Ratchet can ONLY improve in favor of trade (up for Long, down for Short), never backward
              existing.softRatchetPrice = isLong
                ? Math.max(existing.softRatchetPrice, existing.stopLoss || 0)
                : Math.min(existing.softRatchetPrice, existing.stopLoss || Infinity);
            }
          }
          if (pos.liquidationPrice) existing.estimatedLiquidationPrice = pos.liquidationPrice;

          const curLev = existing.leverage || pos.leverage || 1;
          const curTp = existing.takeProfit || pos.takeProfit || activeTp || 0;
          const curEntry = existing.entryPrice || pos.entryPrice || 0;
          const effectiveLossSl = existing.stopLoss || initialSoftSl;
          existing.estimatedProfitPct = (curTp > 0 && curEntry > 0)
            ? Number((Math.abs((curTp - curEntry) / curEntry) * 100 * curLev).toFixed(1))
            : (existing.estimatedProfitPct || 7.5);
          existing.estimatedLossPct = (effectiveLossSl > 0 && curEntry > 0)
            ? Number((Math.abs((curEntry - effectiveLossSl) / curEntry) * 100 * curLev).toFixed(1))
            : (existing.estimatedLossPct || 5.3);
          existing.estimatedWinRatePct = existing.confidence || existing.estimatedWinRatePct || 85;
          modified = true;
        }

        // Detect on-chain partial execution (TP1 matched by DEX):
        if (existing && existing.sizeBase && pos.sizeBase && pos.sizeBase < existing.sizeBase * 0.85 && !(existing as any).tp1Harvested) {
          (existing as any).tp1Harvested = true;
          const lockedProfitSl = isLong ? pos.entryPrice + (softSlDist * 0.35) : pos.entryPrice - (softSlDist * 0.35);
          existing.stopLoss = Number(lockedProfitSl.toFixed(4));
          existing.hardStopLoss = Number(lockedProfitSl.toFixed(4));
          if (existing.takeProfit2 && existing.takeProfit2 > 0) {
            existing.takeProfit = existing.takeProfit2;
          }
          modified = true;
          logger.info(`🎉 [ON-CHAIN TP1 FILLED] Partial scale banked on ${existing.symbol}! Ratcheted runner SL to locked profit: $${existing.stopLoss}`);
        }

        // Auto-arm on-chain hard SL & dynamic hard TP if position is open without an active stop or TP order
        const targetTp = (existing?.takeProfit1 && existing.takeProfit1 > 0)
          ? existing.takeProfit1
          : ((existing?.takeProfit && existing.takeProfit > 0) ? existing.takeProfit : (pos.takeProfit || activeTp));

        // Fix gas drawdown: Decibel DEX get_positions does not return trigger order triggers on the position struct.
        // Check if on-chain TP/SL has already been armed for this trade, avoiding the 15-second infinite broadcast loop.
        const isAlreadyArmed = existing?.onChainTpSlSecured === true;
        const needsOnChainSl = !isAlreadyArmed && hardSl > 0;
        const needsOnChainTp = !isAlreadyArmed && targetTp > 0;

        if ((needsOnChainSl || needsOnChainTp) && isClientConfigured() && !config.PAPER_TRADING) {
          const now = Date.now();
          const lastArm = this.autoArmCooldownMap.get(pos.symbol) || 0;
          if (now - lastArm >= 60_000) {
            this.autoArmCooldownMap.set(pos.symbol, now);
            logger.info(`🛡️🎯 [CONCRETE ARMOR] Auto-arming on-chain TP/SL for ${pos.symbol}: TP: $${targetTp} | SL: $${hardSl}`);
            mcpClient.setTpSl({
              symbol: pos.symbol,
              tpTrigger: targetTp > 0 ? targetTp : undefined,
              slTrigger: hardSl,
            }).then(() => {
              if (existing) {
                existing.onChainTpSlSecured = true;
                this.saveTrades();
              }
              logger.info(`🛡️🎯 [CONCRETE ARMOR] Successfully secured hard on-chain TP/SL for ${pos.symbol}: TP: $${targetTp} | SL: $${hardSl}`);
            }).catch((err: any) => {
              logger.warn(`Failed auto-arming TP/SL for ${pos.symbol}: ${err.message}`);
            });
          }
        }
      }

      // 2. If a trade is marked open locally but no longer exists on-chain, confirm over multiple checks
      const now = Date.now();
      for (const trade of this.tradesCache.filter((t) => t.status === 'open' && !t.isPaper)) {
        const symNorm = trade.symbol.replace('-', '/').toUpperCase();
        const symRaw = trade.symbol.toUpperCase();
        if (!onChainSymbols.has(symNorm) && !onChainSymbols.has(symRaw)) {
          // Guard 1: Allow 30s grace period for freshly opened or restored trades
          if (trade.openedAt && now - trade.openedAt < 30_000) {
            continue;
          }

          const missed = (this.missingOnChainCount.get(symNorm) || 0) + 1;
          this.missingOnChainCount.set(symNorm, missed);
          if (!this.missingFirstSeenAt.has(symNorm)) {
            this.missingFirstSeenAt.set(symNorm, now);
          }
          const durationMissingMs = now - (this.missingFirstSeenAt.get(symNorm) || now);

          // Require at least 6 consecutive cycles AND at least 20 seconds of continuous confirmed absence
          if (missed >= 6 && durationMissingMs >= 20000) {
            const pnl = trade.pnlUsd || 0;
            const smartStatus = pnl > 0.05 ? 'closed_tp' : (pnl < 0 ? 'closed_sl' : 'closed_manual');
            const smartReason = smartStatus === 'closed_tp' ? 'ON_CHAIN_TP_FILL' : (smartStatus === 'closed_sl' ? 'ON_CHAIN_SL_HIT' : 'ON_CHAIN_DEX_CLOSE');
            logger.info(`🔔 [RECONCILE] Position ${trade.symbol} confirmed no longer active on-chain after ${missed} checks (${Math.round(durationMissingMs / 1000)}s) — marking as ${smartStatus} (${smartReason})`);
            trade.status = smartStatus;
            trade.closedAt = Date.now();
            trade.exitReason = smartReason;
            this.missingOnChainCount.delete(symNorm);
            this.missingFirstSeenAt.delete(symNorm);
            this.saveTrades();
            this.notifyTradeClosed(trade);
            modified = true;
          } else {
            logger.debug(`[RECONCILE] Position ${trade.symbol} not in latest report (strike ${missed}/6, ${Math.round(durationMissingMs / 1000)}s) — holding open`);
          }
        } else {
          this.missingOnChainCount.set(symNorm, 0);
          this.missingFirstSeenAt.delete(symNorm);
        }
      }

      if (modified) {
        this.saveTrades();
      }
    } catch (err: any) {
      logger.debug(`[RECONCILE] On-chain position sync skipped: ${err.message}`);
    }

    return this.getOpenTrades();
  }

  public getStats() {
    if (!isClientConfigured()) {
      return {
        totalTrades: 0,
        closedTradesCount: 0,
        openTradesCount: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalPnlUsd: 0,
        budgetUsedUsd: 0,
        budgetAvailableUsd: 0,
      };
    }
    this.loadTrades();
    const closed = this.getClosedTrades();
    const open = this.getOpenTrades();
    const wins = closed.filter((t) => (t.netPnlUsd ?? t.pnlUsd ?? 0) > 0);
    const losses = closed.filter((t) => (t.netPnlUsd ?? t.pnlUsd ?? 0) <= 0);
    const grossPnlUsd = Math.round(closed.reduce((acc, t) => acc + (t.grossPnlUsd ?? ((t.pnlUsd ?? 0) + (t.feeUsd ?? 0))), 0) * 100) / 100;
    const totalFeesUsd = Math.round(closed.reduce((acc, t) => acc + (t.feeUsd ?? 0), 0) * 100) / 100;
    const netPnlUsd = Math.round((grossPnlUsd - totalFeesUsd) * 100) / 100;
    const totalVolumeUsd = closed.reduce((acc, t) => {
      const sz = Number(t.sizeBase || (t as any).size || 0);
      const en = Number(t.entryPrice || (t as any).entry_price || 0);
      const ex = Number(t.exitPrice || (t as any).exit_price || en);
      return acc + (sz * en) + (sz * ex);
    }, 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
    const budgetUsedUsd = open.reduce((acc, t) => acc + (t.allocatedUsd ?? 0), 0);

    // Use ONLY the authoritative DB flag — 'closed_manual' status just means
    // the position was closed via an on-chain action, NOT that it is a human trade.
    const isManualTrade = (t: any) => Boolean(t.isManual === true || t.is_manual === 1);

    const autoOpen = open.filter((t) => !isManualTrade(t)).length;
    const manualOpen = open.filter((t) => isManualTrade(t)).length;

    const autoClosed = closed.filter((t) => !isManualTrade(t));
    const manualClosed = closed.filter((t) => isManualTrade(t));

    const autoWins = autoClosed.filter((t) => (t.netPnlUsd ?? t.pnlUsd ?? 0) > 0).length;
    const autoLosses = autoClosed.filter((t) => (t.netPnlUsd ?? t.pnlUsd ?? 0) <= 0).length;
    const autoPnlUsd = Number(autoClosed.reduce((acc, t) => acc + (t.netPnlUsd ?? t.pnlUsd ?? 0), 0).toFixed(2));

    const manualWins = manualClosed.filter((t) => (t.netPnlUsd ?? t.pnlUsd ?? 0) > 0).length;
    const manualLosses = manualClosed.filter((t) => (t.netPnlUsd ?? t.pnlUsd ?? 0) <= 0).length;
    const manualPnlUsd = Number(manualClosed.reduce((acc, t) => acc + (t.netPnlUsd ?? t.pnlUsd ?? 0), 0).toFixed(2));

    const allPnlValues = closed.map((t) => t.netPnlUsd ?? t.pnlUsd ?? 0);
    const bestTradePnl = allPnlValues.length > 0 ? Math.max(...allPnlValues) : 0;
    const worstTradePnl = allPnlValues.length > 0 ? Math.min(...allPnlValues) : 0;

    const strategyPerformance: Record<string, { wins: number; losses: number; closedTrades: number; winRatePct: number; netPnlUsd: number }> = {};
    for (const t of closed) {
      const sName = t.strategyName || 'Autonomous Engine';
      if (!strategyPerformance[sName]) {
        strategyPerformance[sName] = { wins: 0, losses: 0, closedTrades: 0, winRatePct: 0, netPnlUsd: 0 };
      }
      strategyPerformance[sName].closedTrades++;
      const p = t.netPnlUsd ?? t.pnlUsd ?? 0;
      if (p > 0) strategyPerformance[sName].wins++;
      else strategyPerformance[sName].losses++;
      strategyPerformance[sName].netPnlUsd = Number((strategyPerformance[sName].netPnlUsd + p).toFixed(2));
      strategyPerformance[sName].winRatePct = Number(((strategyPerformance[sName].wins / strategyPerformance[sName].closedTrades) * 100).toFixed(1));
    }

    return {
      totalTrades: this.tradesCache.length,
      closedTradesCount: closed.length,
      openTradesCount: open.length,
      openTrades: open.length,
      autoOpenTrades: autoOpen,
      manualOpenTrades: manualOpen,
      wins: wins.length,
      losses: losses.length,
      winRate: Number(winRate.toFixed(1)),
      totalPnlUsd: Number(netPnlUsd.toFixed(2)), // Authoritative on-chain Net Realized PnL (matches Decibel)
      netPnlUsd: Number(netPnlUsd.toFixed(2)),
      grossPnlUsd: Number(grossPnlUsd.toFixed(2)),
      totalFeesUsd: Number(totalFeesUsd.toFixed(2)),
      totalVolumeUsd: Number(totalVolumeUsd.toFixed(2)),
      autoWins,
      autoLosses,
      autoPnlUsd,
      manualWins,
      manualLosses,
      manualPnlUsd,
      bestTradePnl: Number(bestTradePnl.toFixed(2)),
      worstTradePnl: Number(worstTradePnl.toFixed(2)),
      budgetUsedUsd: Number(budgetUsedUsd.toFixed(2)),
      budgetAvailableUsd: Math.max(0, config.BUDGET_USD - budgetUsedUsd),
      strategyPerformance,
    };
  }

  public clearAllTrades(): void {
    this.tradesCache = [];
    this.shadowTradesCache = [];
    this.saveTrades();
    logger.info('🧹 [EXECUTOR] All live and shadow trade history cleared.');
  }

  private isPaused: boolean = false;

  public setPaused(paused: boolean): void {
    this.isPaused = paused;
    logger.info(`[EXECUTOR] Trading paused state updated: isPaused=${paused}`);
  }

  public getIsPaused(): boolean {
    return this.isPaused;
  }

  // ── Order Execution ─────────────────────────────────────────────────────────

  public async executeTrade(
    signal: StandaloneSignal,
    aiEval: AIBrainEvaluation,
  ): Promise<{ success: boolean; trade?: TradeRecord; error?: string }> {
    if (!isClientConfigured()) {
      return { success: false, error: 'Agent setup not completed. Please configure credentials on onboarding card.' };
    }

    if (this.isPaused) {
      return { success: false, error: 'Trading is currently PAUSED by operator' };
    }

    const symKey = signal.symbol.replace('-', '/').toUpperCase();
    if (this.isExecutionInFlight(symKey)) {
      return { success: false, error: `Execution already in-flight for ${signal.symbol}` };
    }

    // Check if duplicate open trade exists for symbol or execution is already in flight
    const openTrades = this.getOpenTrades();
    const maxOpenPositions = (config as any).MAX_OPEN_POSITIONS || 3;
    if (openTrades.length >= maxOpenPositions) {
      const reason = `🛑 Max Concurrent Positions Reached: Active open positions (${openTrades.length}) >= configured limit (${maxOpenPositions}). Order rejected.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return { success: false, error: reason };
    }

    const existing = openTrades.find((t) => t.symbol.replace('-', '/').toUpperCase() === symKey);
    if (existing || this.isExecutionInFlight(symKey)) {
      return { success: false, error: `Position already open or order execution in flight for ${signal.symbol}` };
    }

    // Real-time on-chain position & resting order checks: guarantee we don't open duplicate or stack orders
    let liveOnChainPositions: any[] = [];
    if (!config.PAPER_TRADING && this.aptosAccount) {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('EXCHANGE_TELEMETRY_TIMEOUT_6S')), 6000)
        );

        liveOnChainPositions = (await Promise.race([mcpClient.getPositions(), timeoutPromise])) as any[];
        const hasOnChain = liveOnChainPositions.some((p) => p.symbol.replace('-', '/').toUpperCase() === symKey && ((p.sizeBase && p.sizeBase > 0) || (p.sizeUsd && p.sizeUsd > 0)));
        if (hasOnChain) {
          logger.warn(`🛡️ [DUPLICATE GUARD] On-chain position already exists for ${signal.symbol} on Decibel DEX. Order aborted.`);
          return { success: false, error: `On-chain position already exists on Decibel DEX for ${signal.symbol}` };
        }

        // Check if resting uncancelled orders exist on DEX book for this symbol:
        const liveOrders = (await Promise.race([mcpClient.getOrders(signal.symbol), timeoutPromise])) as any[];
        const hasResting = liveOrders.some((o: any) => {
          const oSym = (o.market || o.symbol || '').replace('-', '/').toUpperCase();
          return oSym === symKey || oSym.includes(symKey.split('/')[0]);
        });
        if (hasResting) {
          logger.warn(`🛡️ [RESTING ORDER GUARD] Resting order already pending on Decibel DEX for ${signal.symbol} (${liveOrders.length} orders). Aborting new entry to prevent order stacking.`);
          return { success: false, error: `Resting limit order already pending on Decibel DEX for ${signal.symbol}` };
        }
      } catch (preCheckErr: any) {
        // FAIL CLOSED: If telemetry cannot be verified, NEVER proceed with opening new exposure!
        logger.error(`🚨 [PRE-TRADE BLOCKED] Cannot verify exchange telemetry for ${signal.symbol}: ${preCheckErr.message}. Aborting trade.`);
        return { success: false, error: `EXCHANGE_TELEMETRY_UNVERIFIED: ${preCheckErr.message}` };
      }
    }

    this.markExecutionInFlight(symKey);
    try {
      const onChainAllocated = liveOnChainPositions.reduce((sum, p) => sum + (p.allocatedUsd || 0), 0);
      const localAllocated = openTrades.reduce((sum, t) => sum + (t.allocatedUsd || 0), 0);
      const currentAllocated = Math.max(onChainAllocated, localAllocated);
      const onChainBal = this.cachedOnChainBalance?.balanceUsd || 0;
      // Real effective budget is capped by config.BUDGET_USD, but cannot exceed real on-chain equity when live
      const liveEquity = (onChainBal > 0 && !config.PAPER_TRADING) ? onChainBal : config.BUDGET_USD;
      const effectiveBudget = Math.min(config.BUDGET_USD, liveEquity);
      const accountEquity = effectiveBudget;
      const availableMargin = Math.max(0, effectiveBudget - currentAllocated);

      // 1. Run Pre-Trade Risk Guard
      const risk = riskGuard.validateSignal(signal, aiEval, accountEquity, availableMargin, currentAllocated, openTrades.length);
      if (!risk.approved) {
        return { success: false, error: risk.reason };
      }

      const side = signal.action === 'LONG' ? 'buy' : 'sell';
      const isPaper = config.PAPER_TRADING || !this.aptosAccount;
      const tradeId = `decibel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      logger.info(
        `🚀 [EXECUTING] ${isPaper ? 'PAPER' : 'LIVE'} ${signal.symbol} ${signal.action} | ` +
        `Entry: $${signal.entryPrice} | TP: $${signal.takeProfit.toFixed(4)} | ` +
        `SL: $${signal.stopLoss.toFixed(4)} | Size: $${risk.positionSizeUsd.toFixed(2)} (${risk.leverage}x)`,
      );

      let orderId = tradeId;
      let txHash = isPaper ? `paper_tx_${Date.now()}` : '';
      let liveResult: { filled: boolean; orderId: string; txHash: string; isMaker?: boolean; actualEntryPrice?: number; actualSize?: number; cancelledReason?: string } | null = null;
      let tpSlSecured = false;

      if (!isPaper && this.aptos && this.aptosAccount && config.DECIBEL_SUBACCOUNT_ADDRESS) {
        if (this.cachedOnChainBalance.lastChecked > 0 && this.cachedOnChainBalance.aptBalance < 0.002) {
          const addr = this.aptosAccount?.accountAddress?.toString() || 'delegate wallet';
          logger.warn(
            `⛽ [NO GAS] ${signal.symbol} ${signal.action} blocked — delegate wallet (${addr}) ` +
            `has ${this.cachedOnChainBalance.aptBalance.toFixed(4)} APT. Top up with 0.05+ APT on Aptos Mainnet to enable live trading.`
          );
          return { success: false, error: `Delegate gas wallet (${addr}) has 0 APT` };
        }
        try {
          // Ensure on-chain leverage is explicitly configured on Decibel DEX before opening
          const actualLev = await this.ensureLeverageConfigured(signal.symbol, risk.leverage);
          if (actualLev > risk.leverage) {
            logger.error(`🚨 [LEVERAGE GUARD] Bot requested ${risk.leverage}x, but on-chain leverage is ${actualLev}x. Aborting trade.`);
            return { success: false, error: `LEVERAGE_EXCEEDS_BOT_REQUEST: On-chain ${actualLev}x > Bot ${risk.leverage}x` };
          }
          if (actualLev && actualLev !== risk.leverage) {
            logger.info(`⚙️ [EXECUTOR] Adjusting order leverage from ${risk.leverage}x to exchange maximum ${actualLev}x for ${signal.symbol}`);
            risk.leverage = actualLev;
            const recalculatedMargin = risk.positionSizeUsd / actualLev;
            if (recalculatedMargin > effectiveBudget) {
              logger.warn(`🛑 [LEVERAGE SIZING VETO] ${signal.symbol} at ${actualLev}x requires $${recalculatedMargin.toFixed(2)} margin, exceeding budget ($${effectiveBudget.toFixed(2)}). Trade aborted.`);
              return { success: false, error: `MARGIN_EXCEEDS_BUDGET_AT_${actualLev}X` };
            }
          }

          const directivesAny = risk.directivesUsed as any;
          const regime = directivesAny?.regime || 'IDIOSYNCRATIC_CRYPTO';
          const scoreFloor = directivesAny?.scoreFloor || 70;

          // Adaptive Maker-First Routing with Conviction Taker Fallback:
          const postOnly = signal.postOnly;
          const limitPrice = signal.limitPrice;
          const allowTakerFallback = directivesAny?.layer5?.allowTakerFallback === true || signal.confidence >= 75;

          // Dynamic maker fill timeout: adaptive by regime (30s trending/high-vol, 60s range, default 45s)
          let defaultTimeoutMs = 45000;
          if (regime === 'HIGH_VOLATILITY' || regime === 'TRENDING_BREAKOUT') {
            defaultTimeoutMs = 30000;
          } else if (regime === 'RANGE_BOUND' || regime === 'COMPRESSION') {
            defaultTimeoutMs = 60000;
          }

          const makerTimeoutMs = directivesAny?.makerFillTimeoutMs 
            || (directivesAny?.optimalEntry?.ttlSeconds ? Math.min(60000, directivesAny.optimalEntry.ttlSeconds * 1000) : defaultTimeoutMs);

          liveResult = await this.executeOnChain(
            signal.symbol,
            side,
            risk.positionSizeBase,
            signal.entryPrice,
            risk.leverage,
            limitPrice,
            postOnly,
            allowTakerFallback,
            makerTimeoutMs,
            signal.confidence,
            scoreFloor,
            regime,
          );

          if (!liveResult.filled) {
            logger.warn(`🛡️ [PILLAR 1 ROUTING] ${signal.symbol} maker order unfilled: ${liveResult.cancelledReason || 'Cancelled'}. Zero fee incurred, capital preserved.`);
            return { success: false, error: liveResult.cancelledReason || 'Maker order unfilled' };
          }

          orderId = liveResult.orderId;
          txHash = liveResult.txHash;
          if (liveResult.actualEntryPrice && liveResult.actualEntryPrice > 0) {
            const oldEntry = signal.entryPrice;
            signal.entryPrice = liveResult.actualEntryPrice;
            // If entry price shifted from stale signal candle close, adjust TP and SL proportionally
            if (oldEntry > 0 && Math.abs(signal.entryPrice - oldEntry) / oldEntry > 0.002) {
              const priceRatio = signal.entryPrice / oldEntry;
              if (signal.takeProfit > 0) {
                signal.takeProfit = Number((signal.takeProfit * priceRatio).toFixed(4));
              }
              if (signal.stopLoss > 0) {
                signal.stopLoss = Number((signal.stopLoss * priceRatio).toFixed(4));
              }
            }
          }
          if (liveResult.actualSize && liveResult.actualSize > 0) {
            risk.positionSizeBase = liveResult.actualSize;
            risk.positionSizeUsd = liveResult.actualSize * signal.entryPrice;
          }

          // Strict Take-Profit Directional Invariant: Ensure TP is mathematically sound before on-chain DEX arming
          const isLongEntry = signal.action === 'LONG';
          if (isLongEntry) {
            if (!signal.takeProfit || signal.takeProfit <= signal.entryPrice) {
              const oldTp = signal.takeProfit;
              signal.takeProfit = Number((signal.entryPrice * 1.018).toFixed(4));
              logger.warn(`🛡️ [TP INVARIANT HEALED] Invalid initial TP on ${signal.symbol} LONG ($${oldTp} <= Entry $${signal.entryPrice}). Calibrated to $${signal.takeProfit}`);
            }
            if (signal.takeProfit1 && signal.takeProfit1 <= signal.entryPrice) {
              signal.takeProfit1 = Number((signal.entryPrice * 1.018).toFixed(4));
            }
            if (signal.takeProfit2 && signal.takeProfit2 <= signal.entryPrice) {
              signal.takeProfit2 = Number((signal.entryPrice * 1.032).toFixed(4));
            }
          } else {
            if (!signal.takeProfit || signal.takeProfit >= signal.entryPrice) {
              const oldTp = signal.takeProfit;
              signal.takeProfit = Number((signal.entryPrice * 0.982).toFixed(4));
              logger.warn(`🛡️ [TP INVARIANT HEALED] Invalid initial TP on ${signal.symbol} SHORT ($${oldTp} >= Entry $${signal.entryPrice}). Calibrated to $${signal.takeProfit}`);
            }
            if (signal.takeProfit1 && signal.takeProfit1 >= signal.entryPrice) {
              signal.takeProfit1 = Number((signal.entryPrice * 0.982).toFixed(4));
            }
            if (signal.takeProfit2 && signal.takeProfit2 >= signal.entryPrice) {
              signal.takeProfit2 = Number((signal.entryPrice * 0.968).toFixed(4));
            }
          }

          // Hard Stop Loss barrier (15% margin max risk catastrophic circuit breaker for on-chain DEX order book)
          const hardSlPrice = signal.action === 'LONG'
            ? Number((signal.entryPrice * (1 - 0.15 / Math.max(1, risk.leverage))).toFixed(4))
            : Number((signal.entryPrice * (1 + 0.15 / Math.max(1, risk.leverage))).toFixed(4));

          // Attach on-chain TP/SL directly onto Decibel DEX order book (position is guaranteed filled!)
          // On-chain SL is strictly the HARD SL. Soft SL / Ratchet SL is managed off-chain inside our software system.
          if (signal.takeProfit > 0 || hardSlPrice > 0) {
            logger.info(`🎯 [ON-CHAIN TP/SL] Arming TP: $${signal.takeProfit} | Hard SL (On-Chain): $${hardSlPrice} on ${signal.symbol} (Soft Ratchet SL: $${signal.stopLoss} in-system)...`);
            // Brief 1.5s propagation window to guarantee matching engine has finalized position settlement on-chain
            await new Promise((r) => setTimeout(r, 1500));

            let slAttempts = 0;
            const maxSlAttempts = 3;
            while (slAttempts < maxSlAttempts && !tpSlSecured) {
              slAttempts++;
              try {
                await mcpClient.setTpSl({
                  symbol: signal.symbol,
                  tpTrigger: signal.takeProfit > 0 ? signal.takeProfit : undefined,
                  slTrigger: hardSlPrice > 0 ? hardSlPrice : undefined,
                });
                tpSlSecured = true;
                logger.info(`✅ [ON-CHAIN TP/SL] Confirmed Hard TP/SL placement for ${signal.symbol} (attempt ${slAttempts})`);
              } catch (tpErr: any) {
                logger.warn(`⚠️ [ON-CHAIN TP/SL] Placement attempt ${slAttempts}/${maxSlAttempts} failed: ${tpErr?.message || tpErr}`);
                if (slAttempts < maxSlAttempts) await new Promise((r) => setTimeout(r, 1000 * slAttempts));
              }
            }

            // CRITICAL DEFENSE: If hard on-chain stop loss could NOT be placed after 3 attempts, IMMEDIATELY UNWIND!
            if (!tpSlSecured && liveResult?.filled) {
              logger.error(`🚨 [NAKED POSITION UNWIND] ${signal.symbol} filled without stop loss armor! Initiating immediate market close to protect capital...`);
              try {
                await mcpClient.closePosition(signal.symbol, 1.0);
                logger.info(`🛡️ [EMERGENCY UNWIND] Unwound unprotected position for ${signal.symbol}. Zero capital left exposed.`);
              } catch (closeErr: any) {
                logger.error(`💥 [CATASTROPHIC] Unwind failed for ${signal.symbol}: ${closeErr.message}. Halting bot trading!`);
                this.setPaused(true);
              }
              return { success: false, error: 'STOP_ARMOR_FAILED_POSITION_UNWOUND' };
            }
          }
        } catch (err: any) {
          const isGasFee = err.message?.includes('INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE') || err.message?.includes('INSUFFICIENT_BALANCE');
          const isMktNotFound = err.message?.includes('Market details not found') || err.message?.includes('Not connected');
          if (isGasFee) {
            const addr = this.aptosAccount?.accountAddress?.toString() || 'delegate wallet';
            logger.warn(
              `⛽ [NO GAS] ${signal.symbol} ${signal.action} blocked — delegate wallet (${addr}) ` +
              `has 0 APT. Fund it with APT on Aptos Mainnet to enable live trading.`
            );
          } else if (isMktNotFound) {
            logger.warn(`⚠️ [TRADE BLOCKED] ${signal.symbol}: ${err.message}. Check DEX connection or pair availability.`);
          } else {
            logger.error(`❌ [EXECUTOR] On-chain Decibel transaction failed: ${err.message}`);
          }
          return { success: false, error: err.message };
        }
      }

      // Hard Stop Loss barrier (15% margin max risk)
      const hardSlPrice = signal.action === 'LONG'
        ? Number((signal.entryPrice * (1 - 0.15 / Math.max(1, risk.leverage))).toFixed(4))
        : Number((signal.entryPrice * (1 + 0.15 / Math.max(1, risk.leverage))).toFixed(4));

      const hardSlDistPct = signal.entryPrice > 0 ? (Math.abs(signal.entryPrice - hardSlPrice) / signal.entryPrice * 100).toFixed(2) : '5.00';
      const marginRiskPct = (Number(hardSlDistPct) * risk.leverage).toFixed(1);
      const coinSym = signal.symbol.split('/')[0] || signal.symbol;

      const initialLifecycleEvent: TradeLifecycleEvent = {
        timestamp: Date.now(),
        stage: 'ENTRY',
        title: `Entry: ${signal.action === 'LONG' ? 'Bought' : 'Sold short'} ${risk.positionSizeBase || ''} ${coinSym} @ $${signal.entryPrice.toFixed(2)} (${risk.leverage}x leverage)`,
        description: `Initial Hard SL armed on-chain at $${hardSlPrice.toFixed(2)} (-${hardSlDistPct}% price / -${marginRiskPct}% margin). Soft Ratchet SL: $${(signal.stopLoss || hardSlPrice).toFixed(2)}. Target TP1: $${(signal.takeProfit1 || signal.takeProfit || 0).toFixed(2)} | Target TP2: $${(signal.takeProfit2 || 0) > 0 ? '$' + signal.takeProfit2!.toFixed(2) : 'Dynamic Runner'}`,
        price: signal.entryPrice,
        details: [
          `Initial Hard SL armed on-chain at $${hardSlPrice.toFixed(2)} (-${hardSlDistPct}% price / -${marginRiskPct}% margin).`,
          `Initial Soft Ratchet SL in-system at $${(signal.stopLoss || hardSlPrice).toFixed(2)}.`,
          `Target TP1: $${(signal.takeProfit1 || signal.takeProfit || 0).toFixed(2)} | Target TP2: $${(signal.takeProfit2 || 0) > 0 ? '$' + signal.takeProfit2!.toFixed(2) : 'Dynamic Runner'}`,
          `Capital allocated: $${risk.allocatedUsd.toFixed(2)} (${risk.leverage}x cross-margin)`
        ]
      };

      // Invariant: Soft SL must ALWAYS stay strictly between entryPrice and hardStopLoss at entry
      const isLongTrade = signal.action === 'LONG';
      let safeSoftSl = signal.stopLoss;
      if (isLongTrade) {
        // LONG: hardSlPrice < softSL < entryPrice
        const maxSoftSl = Number((signal.entryPrice * 0.997).toFixed(4));
        const minSoftSl = Number((hardSlPrice * 1.002).toFixed(4));
        if (!safeSoftSl || safeSoftSl <= hardSlPrice || safeSoftSl >= signal.entryPrice) {
          safeSoftSl = Number(Math.max(minSoftSl, Math.min(maxSoftSl, safeSoftSl || (signal.entryPrice * 0.985))).toFixed(4));
        }
      } else {
        // SHORT: entryPrice < softSL < hardSlPrice
        const minSoftSl = Number((signal.entryPrice * 1.003).toFixed(4));
        const maxSoftSl = Number((hardSlPrice * 0.998).toFixed(4));
        if (!safeSoftSl || safeSoftSl >= hardSlPrice || safeSoftSl <= signal.entryPrice) {
          safeSoftSl = Number(Math.min(maxSoftSl, Math.max(minSoftSl, safeSoftSl || (signal.entryPrice * 1.015))).toFixed(4));
        }
      }

      // Record trade
      const trade: TradeRecord = {
        id: tradeId,
        symbol: signal.symbol,
        side,
        action: signal.action as 'LONG' | 'SHORT',
        entryPrice: signal.entryPrice,
        takeProfit: signal.takeProfit,
        takeProfit1: signal.takeProfit1,
        takeProfit2: signal.takeProfit2,
        isDualTp: signal.isDualTp,
        stopLoss: safeSoftSl,
        sizeUsd: risk.positionSizeUsd,
        sizeBase: risk.positionSizeBase,
        leverage: risk.leverage,
        allocatedUsd: risk.allocatedUsd,
        confidence: aiEval.confidenceScore,
        executionProfile: signal.executionProfile,
        microTargetProfitUsd: signal.microTargetProfitUsd,
        orderId,
        txHash,
        status: 'open',
        isPaper,
        openedAt: Date.now(),
        strategyName: signal.strategyName || risk.directivesUsed.activeStrategy,
        regime: risk.directivesUsed.regime,
        strategyAttribution: signal.strategyAttribution,
        notes: aiEval.reasoning,
        hardStopLoss: hardSlPrice,
        softRatchetPrice: safeSoftSl,
        estimatedProfitPct: signal.takeProfit && signal.entryPrice ? Number((Math.abs((signal.takeProfit - signal.entryPrice) / signal.entryPrice) * 100 * risk.leverage).toFixed(1)) : 15.0,
        estimatedLossPct: (signal.stopLoss || hardSlPrice) && signal.entryPrice ? Number((Math.abs((signal.entryPrice - (signal.stopLoss || hardSlPrice)) / signal.entryPrice) * 100 * risk.leverage).toFixed(1)) : 15.0,
        estimatedWinRatePct: aiEval.confidenceScore || 78,
        atr: signal.indicators.atr14,
        lifecycleEvents: [initialLifecycleEvent],
        isMaker: liveResult?.isMaker ?? false,
        routing: liveResult?.isMaker ? 'MAKER_POST_ONLY' : (isPaper ? 'PAPER' : 'TAKER_IOC'),
        onChainTpSlSecured: isPaper ? true : tpSlSecured,
      };

      const existingIdx = this.tradesCache.findIndex((t) => t.symbol.replace('-', '/').toUpperCase() === symKey && t.status === 'open');
      if (existingIdx >= 0) {
        this.tradesCache[existingIdx] = {
          ...this.tradesCache[existingIdx],
          ...trade,
          id: this.tradesCache[existingIdx].id || trade.id,
          txHash: txHash || this.tradesCache[existingIdx].txHash,
        };
      } else {
        this.tradesCache.push(trade);
      }
      this.saveTrades();

      logger.info(
        `✅ [TRADE OPENED] ${trade.symbol} ${trade.action} logged to data/trades.json (Order ID: ${orderId})`,
      );

      // Send real-time Telegram alert
      telegramNotifier.notifyTradeOpened(trade).catch(() => { });

      return { success: true, trade };
    } finally {
      this.clearExecutionInFlight(symKey);
    }
  }

  /**
   * Directly sign & submit transaction to Decibel DEX subaccount contracts via Aptos SDK
   * with Pillar 1 Maker-First PostOnly fill verification and resting order cancellation.
   */
  private async executeOnChain(
    symbol: string,
    side: 'buy' | 'sell',
    size: number,
    entryPrice: number,
    targetLeverage?: number,
    targetLimitPrice?: number,
    preferPostOnly = false,
    allowTakerFallback = false,
    makerTimeoutMs?: number,
    initialConfidence?: number,
    confidenceFloor?: number,
    regime?: string,
  ): Promise<{
    orderId: string;
    txHash: string;
    filled: boolean;
    isMaker?: boolean;
    actualEntryPrice?: number;
    actualSize?: number;
    cancelledReason?: string;
  }> {
    if (!this.aptos || !this.aptosAccount) {
      throw new Error('Aptos SDK signer uninitialized');
    }

    const subaccount = (config.DECIBEL_SUBACCOUNT_ADDRESS || '').trim();
    const signer = this.aptosAccount.accountAddress.toString().toLowerCase();
    if (!subaccount || subaccount.toLowerCase() === signer) {
      throw new Error(`CRITICAL GUARD: Decibel subaccount (${subaccount}) cannot be the gas signer address (${signer}). On-chain order aborted.`);
    }

    const market = await mcpClient.getMarketDetail(symbol);
    if (!market) {
      throw new Error(`Market details not found for ${symbol} on Decibel DEX`);
    }

    const isBuy = side === 'buy';
    // Always fetch fresh live mark/last price from Decibel DEX right before on-chain execution.
    // Stale signal prices (e.g. from candle closes or slow analysis) guarantee IOC violations
    // because the limit price will be placed behind current best ask (for buy) or bid (for sell).
    let livePrice = 0;
    try {
      const p = await mcpClient.getPrice(symbol);
      livePrice = p.markPrice || p.lastPrice || 0;
    } catch (e: any) {
      logger.warn(`⚠️ Failed to fetch fresh live price for ${symbol} before on-chain execution: ${e?.message || e}`);
    }
    const refPrice = livePrice > 0 ? livePrice : entryPrice;

    // Determine Maker Post-Only Limit Price vs Taker IOC Price
    // Decibel TimeInForce enum: 0 = GTC, 1 = PostOnly (Maker), 2 = ImmediateOrCancel (IOC)
    const isMakerPostOnly = Boolean(preferPostOnly && targetLimitPrice && targetLimitPrice > 0);
    const timeInForce = isMakerPostOnly ? 1 : 2; // 1 = PostOnly Maker, 2 = IOC Taker
    const reduceOnly = false; // Decibel param 7 is reduce_only: bool! MUST be false for opening new positions.

    // 0.02 (2.0%) slippage buffer for IOC Taker execution.
    // Crypto altcoins on Decibel order book can experience wide top-of-book spreads (20-60 bps) and thin depth.
    // 2.0% guarantees aggressive fill capability while strictly preventing catastrophic execution.
    const takerSlippage = 0.02;
    let limitPrice = 0;
    if (isMakerPostOnly && targetLimitPrice) {
      // Dynamic Maker Offset: Driven by Sim Lab Pair Directives and active Market Regime
      const pairDir = getSimPairDirective(symbol);
      const simRegime = standaloneEngine.getDirectives()?.regime;
      const isChop = simRegime === 'RANGING_CHOP';
      const isHighVol = simRegime === 'HIGH_VOLATILITY';
      const offset = typeof pairDir?.makerOffsetPct === 'number'
        ? pairDir.makerOffsetPct
        : (isChop ? 0.0006 : isHighVol ? 0.0010 : 0.0008);

      // Strict Anti-Spread Cross Invariant:
      // A Maker Post-Only order MUST sit strictly inside the book to avoid matching immediately as a taker.
      // If live mark/ask price has moved lower (for BUY) or higher (for SELL), clamp targetLimitPrice
      // so it NEVER crosses the best bid/ask and never triggers Decibel "Post Only violation".
      if (isBuy) {
        const maxMakerPrice = refPrice > 0 ? refPrice * (1 - offset) : targetLimitPrice;
        limitPrice = Math.min(targetLimitPrice, maxMakerPrice);
      } else {
        const minMakerPrice = refPrice > 0 ? refPrice * (1 + offset) : targetLimitPrice;
        limitPrice = Math.max(targetLimitPrice, minMakerPrice);
      }
    } else {
      // Dynamic Taker Slippage Buffer:
      // In CLOB execution, 0.002 (0.20%) or stale refPrice causes Decibel on-chain "IOC Violation" cancels.
      // 0.02 (2.00%) with live refPrice ensures immediate execution against resting liquidity.
      limitPrice = refPrice > 0
        ? (isBuy ? refPrice * (1 + takerSlippage) : refPrice * (1 - takerSlippage))
        : 0;
    }

    const { chainPrice, chainSize, effectiveBaseSize: effectiveBase } = quantizeOrderParameters(
      market,
      limitPrice,
      size,
      isBuy,
    );
    const effectiveNotional = effectiveBase * (refPrice > 0 ? refPrice : entryPrice);
    const maxAllowedNotional = Math.max(config.BUDGET_USD * (targetLeverage || config.MAX_LEVERAGE) * 1.5, 200);

    if (effectiveNotional > maxAllowedNotional) {
      const err = `CRITICAL ON-CHAIN GUARD: Order notional ($${effectiveNotional.toFixed(2)}) exceeds safety cap ($${maxAllowedNotional.toFixed(2)})! Base size=${effectiveBase} ${symbol}, sizeDecimals=${market.sizeDecimals}. Order aborted.`;
      logger.error(`🛑 ${err}`);
      throw new Error(err);
    }

    // PRE-FLIGHT DOUBLE ORDER SHIELD:
    // Query Decibel DEX to ensure no resting order exists for this market before placing a new one.
    // If a resting limit order exists (e.g. from an orphaned container run or previous cycle), cancel it first.
    try {
      const restingOrders = await mcpClient.getOrders(symbol);
      if (restingOrders && restingOrders.length > 0) {
        logger.warn(`🛡️ [DOUBLE ORDER SHIELD] Found ${restingOrders.length} existing resting order(s) for ${symbol} on Decibel DEX. Sweeping before placing new order...`);
        for (const ord of restingOrders) {
          const cid = ord.clientOrderId || ord.client_order_id;
          if (cid) {
            await mcpClient.cancelClientOrder(symbol, cid).catch(() => {});
          }
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (orderCheckErr: any) {
      logger.debug(`[PRE-FLIGHT DOUBLE ORDER SHIELD] Notice: ${orderCheckErr.message}`);
    }

    const clientOrderId = `decibel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    if (isMakerPostOnly) {
      logger.info(`🏛️ [MAKER POST-ONLY] Routing resting FVG limit order on Decibel DEX: ${symbol} ${side.toUpperCase()} sizeUnits=${chainSize} priceLimit=${chainPrice} (0% Taker Fee)`);
    } else {
      logger.info(`⚡ [ON-CHAIN IOC] Signing Decibel order: ${symbol} ${side.toUpperCase()} sizeUnits=${chainSize} priceLimit=${chainPrice} (IOC Market Execution, slippageCap=${(takerSlippage * 100).toFixed(1)}%)`);
    }

    const sendTx = async (): Promise<{ txHash: string; isCancelledByEngine: boolean; cancelReason: string }> => {
      const client = this.getAptos();
      const tx = await client.transaction.build.simple({
        sender: this.aptosAccount!.accountAddress,
        data: {
          function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::place_order_to_subaccount',
          typeArguments: [],
          functionArguments: [
            config.DECIBEL_SUBACCOUNT_ADDRESS,
            market.address,
            chainPrice,
            chainSize,
            isBuy,
            timeInForce,
            reduceOnly,
            clientOrderId,
            null, // stop_price
            null, // tp_trigger_price
            null, // tp_limit_price
            null, // sl_trigger_price
            null, // sl_limit_price
            null, // builder_address
            null, // builder_fees
          ],
        },
      });

      const senderAuth = client.transaction.sign({
        signer: this.aptosAccount!,
        transaction: tx,
      });

      const committed = await client.transaction.submit.simple({
        transaction: tx,
        senderAuthenticator: senderAuth,
      });

      const executed = await client.waitForTransaction({
        transactionHash: committed.hash,
      });

      if (!executed.success) {
        throw new Error(`On-chain transaction failed: ${executed.vm_status}`);
      }

      // Verify if matching engine immediately cancelled the PostOnly order
      let isCancelledByEngine = false;
      let cancelReason = '';
      if (Array.isArray((executed as any).events)) {
        for (const ev of (executed as any).events) {
          if (ev.type?.includes('market_types::OrderEvent')) {
            const evData = ev.data;
            const status = evData?.status?.__variant__ || evData?.status;
            if (status === 'CANCELLED') {
              isCancelledByEngine = true;
              cancelReason = evData?.details || 'Order rejected by matching engine';
              break;
            }
          }
        }
      }

      return { txHash: committed.hash, isCancelledByEngine, cancelReason };
    };

    let txRes: { txHash: string; isCancelledByEngine: boolean; cancelReason: string };
    try {
      txRes = await sendTx();
    } catch (err: any) {
      if (isNodeRateLimitOrAuthError(err)) {
        logger.warn(`⚠️ [ON-CHAIN] Gateway rate-limit/auth error (${err.message}). Instant 0s failover to Builder Proxy...`);
        triggerNodeKeyFailover(undefined, err.message);
        this.reinitAptos();
        txRes = await sendTx();
      } else {
        throw err;
      }
    }

    if (txRes.isCancelledByEngine) {
      if (isMakerPostOnly) {
        logger.warn(`⚠️ [MAKER ROUTING] Decibel matching engine rejected PostOnly order for ${symbol}: ${txRes.cancelReason}`);
        if (allowTakerFallback) {
          logger.info(`⚡ [MAKER FALLBACK] Falling back to urgent IOC Taker execution for ${symbol}...`);
          return this.executeOnChain(symbol, side, size, entryPrice, targetLeverage, targetLimitPrice, false, false);
        }
      } else {
        logger.warn(`⚠️ [IOC TAKER ROUTING] Decibel matching engine rejected IOC order for ${symbol}: ${txRes.cancelReason}`);
      }
      return {
        orderId: clientOrderId,
        txHash: txRes.txHash,
        filled: false,
        isMaker: isMakerPostOnly,
        cancelledReason: txRes.cancelReason,
      };
    }

    if (isMakerPostOnly) {
      // Regime-Adaptive Dynamic Timeout (calibrated to 30s-60s to allow healthy pullbacks)
      let adaptiveTimeoutMs = makerTimeoutMs ?? 45000;
      if (regime === 'HIGH_VOLATILITY' || regime === 'TRENDING_BREAKOUT') {
        adaptiveTimeoutMs = Math.min(adaptiveTimeoutMs, 30000);
      } else if (regime === 'RANGE_BOUND' || regime === 'COMPRESSION') {
        adaptiveTimeoutMs = Math.max(adaptiveTimeoutMs, 60000);
      }
      const timeoutMs = Math.max(25000, Math.min(90000, adaptiveTimeoutMs));
      const symUpper = symbol.replace('-', '/').toUpperCase();
      const baseConfidence = initialConfidence || 72;
      const minConfidenceGate = confidenceFloor || 68;

      logger.info(
        `⏳ [DYNAMIC MAKER POST-ONLY] Resting order active at $${limitPrice.toFixed(4)} | ` +
        `Initial Conf: ${baseConfidence.toFixed(1)}% (Floor: ${minConfidenceGate}%) | ` +
        `Regime: ${regime || 'STANDARD'} (Max Window: ${timeoutMs / 1000}s)...`
      );

      const pollIntervalMs = 1500;
      const maxPolls = Math.max(1, Math.floor(timeoutMs / pollIntervalMs));
      let fillConfirmed = false;
      let actualFillPrice = limitPrice > 0 ? limitPrice : refPrice;
      let actualFillSize = 0;
      let earlyCancelReason: string | null = null;
      let shouldUpgradeToMarket = false;

      for (let poll = 1; poll <= maxPolls; poll++) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));

        // 1. Check Fill Confirmation on Decibel DEX
        try {
          const positions = await mcpClient.getPositions();
          const pos = positions.find((p) => p.symbol.replace('-', '/').toUpperCase() === symUpper);
          const posSize = Number(pos?.sizeBase || (pos as any)?.size || 0);

          if (posSize > 0) {
            actualFillPrice = pos?.entryPrice || actualFillPrice;
            actualFillSize = posSize;
            const fillPct = (posSize / effectiveBase) * 100;

            // Fully or substantially filled (>= 90% of target order size)
            if (posSize >= effectiveBase * 0.90) {
              fillConfirmed = true;
              logger.info(`⚡ [MAKER FILLED] Confirmed Maker execution on Decibel DEX! Symbol=${symbol} Entry=$${actualFillPrice} Size=${actualFillSize} (${fillPct.toFixed(1)}% complete fill, Zero Taker Fee Captured)`);
              break;
            } else {
              // Partial fill: keep resting on book so the remaining order size has time to fill!
              logger.info(`⏳ [MAKER PARTIAL FILL] ${symbol}: Filled ${posSize.toFixed(4)} / ${effectiveBase.toFixed(4)} (${fillPct.toFixed(1)}%). Continuing to rest on book (poll ${poll}/${maxPolls})...`);
            }
          }
        } catch (pollErr: any) {
          logger.debug(`Fill poll ${poll} notice: ${pollErr?.message || pollErr}`);
        }

        // 2. Dynamic In-Flight Alpha Thesis & Confidence Evaluation
        try {
          const currentPriceData = await mcpClient.getPrice(symbol);
          const currentPrice = currentPriceData?.markPrice || currentPriceData?.lastPrice || 0;
          if (currentPrice > 0 && refPrice > 0) {
            // Price drift relative to trade direction
            // Positive drift = price is moving favorably (running away from resting maker order)
            // Negative drift = price is moving adversely against trade thesis
            const pctChange = isBuy
              ? ((currentPrice - refPrice) / refPrice) * 100
              : ((refPrice - currentPrice) / refPrice) * 100;

            // Calibrate sensitivity: require real structural move (~0.5%-1.0%), not normal bid-ask jitter
            const dynamicConfDelta = pctChange * 10;
            const currentLiveConfidence = Math.max(0, Math.min(100, baseConfidence + dynamicConfDelta));

            // THESIS DEGRADATION (Adverse Selection Protection):
            // Cancel only if live confidence drops significantly below floor or drops by >= 12%
            if (currentLiveConfidence < (minConfidenceGate - 3) || (baseConfidence - currentLiveConfidence) >= 12) {
              logger.warn(
                `🛑 [ADVERSE SELECTION SHIELD] Thesis degraded during resting window! ` +
                `Live Conf: ${currentLiveConfidence.toFixed(1)}% (Initial: ${baseConfidence.toFixed(1)}%, Floor: ${minConfidenceGate}%, Drift: ${pctChange.toFixed(2)}%). ` +
                `Cancelling resting maker order ${clientOrderId} to prevent toxic fill!`
              );
              earlyCancelReason = `ADVERSE_SELECTION_CANCEL: Live confidence (${currentLiveConfidence.toFixed(1)}%) dropped >=12% or below floor`;
              break;
            }

            // THESIS ACCELERATION (Urgency Surge / Breakout Chaser):
            // If live confidence surges by +15% (e.g. 72% -> 87%+) or reaches >= 85%,
            // market is ripping with high EV. Upgrade to IOC Market Order immediately!
            if (allowTakerFallback && (currentLiveConfidence >= 85 || (currentLiveConfidence - baseConfidence) >= 15)) {
              logger.info(
                `🚀 [ALPHA ACCELERATION] High-conviction breakout surge detected! ` +
                `Live Conf: ${currentLiveConfidence.toFixed(1)}% (+${(currentLiveConfidence - baseConfidence).toFixed(1)}% drift). ` +
                `Cancelling resting maker and upgrading to IOC Market Order at $${currentPrice.toFixed(4)}!`
              );
              shouldUpgradeToMarket = true;
              break;
            }
          }
        } catch (dynErr: any) {
          logger.debug(`Dynamic confidence check notice: ${dynErr?.message || dynErr}`);
        }
      }

      // Check if position reached at least 90% by end of window
      if (!fillConfirmed && actualFillSize >= effectiveBase * 0.90) {
        fillConfirmed = true;
      }

      if (!fillConfirmed) {
        if (shouldUpgradeToMarket) {
          try {
            await mcpClient.cancelClientOrder(symbol, clientOrderId);
          } catch {}
          logger.info(`⚡ [URGENCY UPGRADE] Executing immediate IOC Market Taker for ${symbol} due to confidence surge...`);
          return this.executeOnChain(symbol, side, size, refPrice, targetLeverage, 0, false, false);
        }

        const cancelLog = earlyCancelReason || `Order unfilled after ${timeoutMs / 1000}s`;
        logger.warn(`⏳ [MAKER CANCEL] ${cancelLog}. Sweeping resting order ${clientOrderId}...`);
        try {
          await mcpClient.cancelClientOrder(symbol, clientOrderId);
        } catch (cErr: any) {
          logger.warn(`[MAKER CANCEL] order cancellation notice: ${cErr?.message || cErr}`);
        }
        // Post-Timeout DEX Shield: If cancelled without fill and no fallback, cool off pair for 3m (180s)
        // to prevent immediate re-entry loop churn on the DEX
        this.markExecutionInFlight(symUpper, allowTakerFallback ? 45000 : 180000);

        // Post-cancellation check: verify if the order filled right before/during the cancel window
        try {
          const finalPositions = await mcpClient.getPositions();
          const finalPos = finalPositions.find((p) => p.symbol.replace('-', '/').toUpperCase() === symUpper);
          const finalPosSize = Number(finalPos?.sizeBase || (finalPos as any)?.size || 0);
          if (finalPosSize > 0) {
            actualFillSize = Math.max(actualFillSize, finalPosSize);
            actualFillPrice = finalPos?.entryPrice || actualFillPrice;
          }
        } catch {}

        // Partial Fill Resolution: If a partial fill occurred (< 90%), guarantee position reaches minimum size
        if (actualFillSize > 0) {
          const remainingBase = Number((effectiveBase - actualFillSize).toFixed(market.sizeDecimals));
          const filledNotional = actualFillSize * actualFillPrice;
          const minLotBase = market.minSize ? market.minSize / Math.pow(10, market.sizeDecimals) : 0;

          // If filled portion is below $18 notional OR fallback is allowed, sweep remaining unfilled size
          if (remainingBase > minLotBase && (filledNotional < 18 || allowTakerFallback)) {
            logger.info(`⚡ [PARTIAL FILL SWEEP] ${symbol}: Maker window ended with partial fill of ${actualFillSize.toFixed(4)} / ${effectiveBase.toFixed(4)} ($${filledNotional.toFixed(2)} notional). Sweeping remaining ${remainingBase.toFixed(4)} via IOC Taker to guarantee full minimum margin requirement...`);
            try {
              const sweepRes = await this.executeOnChain(symbol, side, remainingBase, actualFillPrice, targetLeverage, 0, false, false);
              if (sweepRes && sweepRes.filled) {
                try {
                  const updatedPositions = await mcpClient.getPositions();
                  const updatedPos = updatedPositions.find((p) => p.symbol.replace('-', '/').toUpperCase() === symUpper);
                  actualFillSize = Number(updatedPos?.sizeBase || (actualFillSize + (sweepRes.actualSize || remainingBase)));
                  actualFillPrice = Number(updatedPos?.entryPrice || sweepRes.actualEntryPrice || actualFillPrice);
                } catch {
                  actualFillSize = actualFillSize + (sweepRes.actualSize || remainingBase);
                }
                logger.info(`✅ [SWEEP COMPLETED] Position brought to full size: ${actualFillSize} ${symbol} at avg entry $${actualFillPrice}`);
              }
            } catch (sweepErr: any) {
              logger.warn(`Sweep of remaining partial size failed: ${sweepErr?.message || sweepErr}`);
            }
          }

          return {
            orderId: clientOrderId,
            txHash: txRes.txHash,
            filled: true,
            isMaker: true,
            actualEntryPrice: actualFillPrice,
            actualSize: actualFillSize,
          };
        }

        // If it was cancelled due to thesis degradation (adverse selection), do NOT execute taker fallback
        if (!earlyCancelReason && allowTakerFallback) {
          logger.info(`⚡ [MAKER TIMEOUT] Fallback allowed — executing urgent IOC Taker order for ${symbol}...`);
          return this.executeOnChain(symbol, side, size, entryPrice, targetLeverage, targetLimitPrice, false, false);
        }

        return {
          orderId: clientOrderId,
          txHash: txRes.txHash,
          filled: false,
          isMaker: true,
          cancelledReason: earlyCancelReason || 'Maker post-only order unfilled within window; resting order cancelled',
        };
      }

      return {
        orderId: clientOrderId,
        txHash: txRes.txHash,
        filled: true,
        isMaker: true,
        actualEntryPrice: actualFillPrice,
        actualSize: actualFillSize || effectiveBase,
      };
    }

    logger.info(`🎯 [ON-CHAIN FILLED] Tx: ${txRes.txHash}`);
    return {
      orderId: clientOrderId,
      txHash: txRes.txHash,
      filled: true,
      isMaker: false,
      actualEntryPrice: refPrice,
      actualSize: effectiveBase,
    };
  }

  /**
   * Monitor open positions against live market price to enforce dynamic TP and SL,
   * and monitor active shadow trades to calculate counterfactual wins/losses (capital saved).
   */
  public monitorOpenTrades(livePrices: Record<string, number>): void {
    let modified = false;

    // 1. Monitor real open trades
    for (const trade of this.getOpenTrades()) {
      const sym = trade.symbol;
      const symSlash = sym.replace('-', '/');
      const symDash = sym.replace('/', '-');
      const currentPrice = livePrices[sym] || livePrices[symSlash] || livePrices[symDash] || (trade.currentPrice && trade.currentPrice > 0 ? trade.currentPrice : 0);
      if (!currentPrice || currentPrice <= 0) continue;

      const isLong = trade.action === 'LONG';
      let hitTp = false;
      let hitSl = false;

      if (isLong) {
        if (trade.takeProfit > trade.entryPrice && currentPrice >= trade.takeProfit) {
          hitTp = true;
        } else if (trade.stopLoss > 0 && currentPrice <= trade.stopLoss) {
          hitSl = true;
        } else if (trade.takeProfit > 0 && trade.takeProfit <= trade.entryPrice) {
          // Self-heal inverted TP: reset to standard +1.8% ATR target
          trade.takeProfit = Number((trade.entryPrice * 1.018).toFixed(4));
          modified = true;
          logger.warn(`🛡️ [TP INVARIANT HEALED] Inverted TP on ${trade.symbol} LONG auto-corrected: $${trade.takeProfit}`);
        }
      } else {
        if (trade.takeProfit > 0 && trade.takeProfit < trade.entryPrice && currentPrice <= trade.takeProfit) {
          hitTp = true;
        } else if (trade.stopLoss > 0 && currentPrice >= trade.stopLoss) {
          hitSl = true;
        } else if (trade.takeProfit >= trade.entryPrice) {
          // Self-heal inverted TP: reset to standard -1.8% ATR target
          trade.takeProfit = Number((trade.entryPrice * 0.982).toFixed(4));
          modified = true;
          logger.warn(`🛡️ [TP INVARIANT HEALED] Inverted TP on ${trade.symbol} SHORT auto-corrected: $${trade.takeProfit}`);
        }
      }

      if (hitTp || hitSl) {
        const priceDiff = isLong ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
        const pnlPct = (priceDiff / trade.entryPrice) * 100 * trade.leverage;
        const pnlUsd = (trade.allocatedUsd * pnlPct) / 100;
        const isProfitable = (isLong ? currentPrice >= trade.entryPrice : currentPrice <= trade.entryPrice) || (pnlUsd >= 0);
        let exitStatus: 'closed_tp' | 'closed_sl' = 'closed_sl';
        let exitReasonStr = 'ON_CHAIN_SL';

        if (pnlUsd > 0.05) {
          exitStatus = 'closed_tp';
          exitReasonStr = hitTp ? 'ON_CHAIN_TP' : ((trade.breakevenMoved || isProfitable) ? 'TRAILING_TP' : 'DEX_TP_EXTERNAL');
        } else if (pnlUsd >= 0 && (trade.breakevenMoved || isProfitable)) {
          exitStatus = 'closed_tp';
          exitReasonStr = 'BREAKEVEN';
        } else {
          exitStatus = 'closed_sl';
          exitReasonStr = 'ON_CHAIN_SL';
        }

        trade.status = exitStatus;
        trade.exitReason = exitReasonStr;
        trade.exitPrice = currentPrice;
        trade.closedAt = Date.now();
        trade.pnlPct = Number(pnlPct.toFixed(2));
        trade.pnlUsd = Number(pnlUsd.toFixed(2));

        // Lifecycle event & summary
        if (!trade.lifecycleEvents) trade.lifecycleEvents = [];
        const durationSec = Math.max(1, Math.round(((trade.closedAt || Date.now()) - trade.openedAt) / 1000));
        const durationText = durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
        const pnlSign = pnlUsd >= 0 ? '+' : '';

        let exitTitle = '';
        let exitDesc = '';
        let exitDetails: string[] = [];
        let summaryReason = '';

        if (exitReasonStr === 'BREAKEVEN' || (trade.breakevenMoved && isProfitable)) {
          exitTitle = `📉 Price pulled back to $${currentPrice.toFixed(2)} (${durationText} hold): 🛡️ BREAKEVEN PROTECTED EXIT`;
          exitDesc = `Market touched the Breakeven Stop ($${currentPrice.toFixed(2)} vs stop $${trade.stopLoss.toFixed(2)}). Runner exited on-chain at $${currentPrice.toFixed(2)}, banking ${pnlSign}$${pnlUsd.toFixed(4)} net profit.`;
          exitDetails = [
            `Market touched the Breakeven Stop ($${currentPrice.toFixed(2)} vs stop $${trade.stopLoss.toFixed(2)}).`,
            `Runner exited cleanly on-chain at $${currentPrice.toFixed(2)}.`,
            `Runner banked ${pnlSign}$${pnlUsd.toFixed(4)} net profit (above entry $${trade.entryPrice.toFixed(2)}).`,
            `Zero downside capital risk incurred.`
          ];
          summaryReason = `Trade reached scale-out and advanced stop loss to breakeven ($${trade.stopLoss.toFixed(2)}). Market pullback cleanly exited the position in net profit (${pnlSign}$${pnlUsd.toFixed(4)}) with capital preserved.`;
        } else if (exitStatus === 'closed_tp') {
          exitTitle = `🎯 Target Take Profit Filled @ $${currentPrice.toFixed(2)} (${durationText} hold)`;
          exitDesc = `Target objective reached. Position exited at $${currentPrice.toFixed(2)}, banking +$${pnlUsd.toFixed(4)} (+${trade.pnlPct}%).`;
          exitDetails = [
            `Price reached Take Profit target @ $${currentPrice.toFixed(2)}.`,
            `Position closed on-chain with full profit captured.`,
            `Banked +$${pnlUsd.toFixed(4)} net profit.`
          ];
          summaryReason = `Trade reached its target Take Profit at $${currentPrice.toFixed(2)}. Momentum continued in trade direction until target liquidity was filled.`;
        } else {
          exitTitle = `🛑 Initial Stop Loss Triggered @ $${currentPrice.toFixed(2)} (${durationText} hold)`;
          exitDesc = `Price moved against position and hit initial hard stop level ($${trade.stopLoss.toFixed(2)}).`;
          exitDetails = [
            `Market moved adversely to invalidation level ($${currentPrice.toFixed(2)}).`,
            `Hard stop loss triggered on-chain to protect account capital.`,
            `Drawdown capped at -$${Math.abs(pnlUsd).toFixed(4)} (${trade.pnlPct}% margin loss).`
          ];
          summaryReason = `Market moved adversely against the entry thesis and reached the predetermined stop loss price of $${trade.stopLoss.toFixed(2)}. On-chain market close executed to cap maximum loss and preserve trading capital.`;
        }

        trade.lifecycleEvents.push({
          timestamp: trade.closedAt,
          stage: 'EXIT',
          title: exitTitle,
          description: exitDesc,
          price: currentPrice,
          pnlUsd: pnlUsd,
          details: exitDetails
        });
        trade.exitSummary = summaryReason;
        modified = true;

        logger.info(
          `🔔 [POSITION CLOSED] ${trade.symbol} ${trade.action} reached ${hitTp ? 'TAKE PROFIT' : 'STOP LOSS'} ` +
          `@ $${currentPrice.toFixed(4)} | PnL: ${pnlPct > 0 ? '+' : ''}${trade.pnlPct}% ($${trade.pnlUsd})`,
        );

        // Execute real on-chain close on Decibel DEX so trade does not become a ghost zombie position
        if (!trade.isPaper) {
          const symKey = trade.symbol.replace('-', '/').toUpperCase();
          this.markExecutionInFlight(symKey);
          mcpClient.closePosition(trade.symbol).catch((err: any) => {
            logger.warn(`Could not close on-chain position for ${trade.symbol} on ${hitTp ? 'TP' : 'SL'}: ${err.message}`);
          }).finally(() => {
            setTimeout(() => this.clearExecutionInFlight(symKey), 8000);
          });
        }

        // Commit trade state immediately to SQLite and disk before firing telemetry and alerts
        this.saveTrades();

        // Send real-time Telegram alert
        telegramNotifier.notifyTradeClosed(trade).catch(() => { });
        this.notifyTradeClosed(trade);
      }
    }

    // 2. Monitor active tracking shadow trades (Counterfactual simulations)
    const now = Date.now();
    for (const st of this.shadowTradesCache.filter((s) => s.status === 'tracking')) {
      const currentPrice = livePrices[st.symbol];
      if (!currentPrice || currentPrice <= 0) continue;

      const isLong = st.action === 'LONG';
      let hitTp = false;
      let hitSl = false;

      if (isLong) {
        if (st.takeProfit > st.entryPrice && currentPrice >= st.takeProfit) hitTp = true;
        else if (st.stopLoss > 0 && currentPrice <= st.stopLoss) hitSl = true;
      } else {
        if (st.takeProfit > 0 && st.takeProfit < st.entryPrice && currentPrice <= st.takeProfit) hitTp = true;
        else if (st.stopLoss > 0 && currentPrice >= st.stopLoss) hitSl = true;
      }

      if (hitTp) {
        st.status = 'counterfactual_win';
        st.closedAt = now;
        const diff = isLong ? st.takeProfit - st.entryPrice : st.entryPrice - st.takeProfit;
        st.hypotheticalPnlPct = Number(((diff / st.entryPrice) * 100 * 3).toFixed(2));
        modified = true;
        logger.info(
          `⚠️ [SHADOW OUTCOME: MISSED WINNER] ${st.symbol} ${st.action} hit Take Profit @ $${currentPrice.toFixed(4)} ` +
          `(+${st.hypotheticalPnlPct}%). Veto was: ${st.vetoCategory}`,
        );
        this.notifyShadowTradeResolved(st);
      } else if (hitSl) {
        st.status = 'counterfactual_loss';
        st.closedAt = now;
        const diff = isLong ? st.stopLoss - st.entryPrice : st.entryPrice - st.stopLoss;
        st.hypotheticalPnlPct = Number(((diff / st.entryPrice) * 100 * 3).toFixed(2));
        modified = true;
        logger.info(
          `🛡️ [SHADOW OUTCOME: SAVED CAPITAL] ${st.symbol} ${st.action} hit Stop Loss @ $${currentPrice.toFixed(4)} ` +
          `(${st.hypotheticalPnlPct}%). Shield protected capital! Veto was: ${st.vetoCategory}`,
        );
        this.notifyShadowTradeResolved(st);
      } else {
        // Update live tracking hypothetical PnL
        const diff = isLong ? currentPrice - st.entryPrice : st.entryPrice - currentPrice;
        st.hypotheticalPnlPct = Number(((diff / st.entryPrice) * 100 * 3).toFixed(2));
        // Auto-resolve tracking trades older than 48 hours
        if (now - st.openedAt > 172800000) {
          st.status = st.hypotheticalPnlPct >= 0 ? 'counterfactual_win' : 'counterfactual_loss';
          st.closedAt = now;
          modified = true;
          this.notifyShadowTradeResolved(st);
        }
      }
    }

    if (modified) {
      this.saveTrades();
    }
  }

  public recordShadowTrade(params: {
    symbol: string;
    action: 'LONG' | 'SHORT';
    entryPrice: number;
    takeProfit: number;
    stopLoss: number;
    confidence: number;
    vetoCategory: ShadowTrade['vetoCategory'];
    vetoReason: string;
  }): ShadowTrade {
    // Avoid spamming duplicate shadow trades for same symbol & action within 2 minutes
    const existing = this.shadowTradesCache.find(
      (st) => st.symbol === params.symbol && st.action === params.action && st.status === 'tracking' && Date.now() - st.openedAt < 120000,
    );
    if (existing) return existing;

    const shadow: ShadowTrade = {
      id: `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      symbol: params.symbol,
      action: params.action,
      entryPrice: params.entryPrice,
      takeProfit: params.takeProfit,
      stopLoss: params.stopLoss,
      confidence: params.confidence,
      vetoCategory: params.vetoCategory,
      vetoReason: params.vetoReason,
      status: 'tracking',
      hypotheticalPnlPct: 0,
      openedAt: Date.now(),
    };

    this.shadowTradesCache.push(shadow);
    if (this.shadowTradesCache.length > 200) {
      this.shadowTradesCache = this.shadowTradesCache.slice(-200);
    }
    this.saveTrades();
    logger.info(`👻 [SHADOW RECORDED] ${shadow.symbol} ${shadow.action} | Veto: ${shadow.vetoCategory} (${shadow.vetoReason})`);
    return shadow;
  }

  public getShadowTrades(): ShadowTrade[] {
    return this.shadowTradesCache;
  }

  public getShadowStats() {
    const total = this.shadowTradesCache.length;
    const tracking = this.shadowTradesCache.filter((s) => s.status === 'tracking').length;
    const wins = this.shadowTradesCache.filter((s) => s.status === 'counterfactual_win').length;
    const losses = this.shadowTradesCache.filter((s) => s.status === 'counterfactual_loss').length;

    const baseBudget = Math.max(10, (config.BUDGET_USD || 30) * (config.MAX_ALLOC_PCT / 100));
    const estimatedSavedUsd = Number((losses * baseBudget * 0.05).toFixed(2));
    const estimatedMissedUsd = Number((wins * baseBudget * 0.08).toFixed(2));
    const resolvedCount = wins + losses;
    const precisionPct = resolvedCount > 0 ? Number(((losses / resolvedCount) * 100).toFixed(1)) : 100;

    return {
      totalVetoed: total,
      totalShadowTrades: total,
      activeTracking: tracking,
      counterfactualWins: wins,
      counterfactualLosses: losses,
      trueTrapsSaved: losses,
      precisionPct,
      estimatedSavedUsd,
      estimatedMissedUsd,
    };
  }

  /**
   * Reset all trades to clean state ($0 allocation used)
   */
  public resetTrades(): void {
    this.tradesCache = [];
    this.shadowTradesCache = [];
    this.saveTrades();
    try {
      dbClient.clearAllTrades();
    } catch { }
    logger.info('🧹 [EXECUTOR] All trades and positions reset to empty. Budget allocation is now $0.');
  }

  /**
   * Close all currently open positions with verified on-chain execution
   */
  public async closeAllOpenTradesAsync(reason: 'closed_manual' | 'closed_tp' | 'closed_sl' = 'closed_manual'): Promise<{ closed: number; failed: number }> {
    const open = this.getOpenTrades();
    let closedCount = 0;
    let failedCount = 0;

    // 1. Cancel all resting limit and trigger orders on-chain
    try {
      await mcpClient.cancelAllOrders();
      logger.info('🛡️ [EMERGENCY DRAIN] Cancelled all resting orders on Decibel DEX.');
    } catch (err: any) {
      logger.warn(`⚠️ [EMERGENCY DRAIN] Cancel orders notice: ${err.message}`);
    }

    // 2. Liquidate each open position on-chain
    for (const trade of open) {
      try {
        if (!trade.isPaper && this.aptos && this.aptosAccount) {
          logger.info(`⚡ [EMERGENCY DRAIN] Closing on-chain position for ${trade.symbol}...`);
          const res = (await mcpClient.closePosition(trade.symbol, 1.0)) as any;
          if (res && res.error) {
            throw new Error(res.error);
          }
        }
        trade.status = reason;
        trade.closedAt = Date.now();
        closedCount++;
        this.notifyTradeClosed(trade);
      } catch (closeErr: any) {
        trade.status = 'close_failed' as any;
        failedCount++;
        logger.error(`🚨 [EMERGENCY DRAIN FAILED] Could not close ${trade.symbol} on-chain: ${closeErr.message}`);
      }
    }

    // 3. Confirm on-chain that positions are zero
    try {
      const remaining = await mcpClient.getPositions();
      const stillOpen = remaining.filter((p: any) => (p.sizeBase && p.sizeBase > 0) || (p.sizeUsd && p.sizeUsd > 0.1));
      if (stillOpen.length > 0) {
        logger.error(`🚨 [EMERGENCY DRAIN] ${stillOpen.length} positions still exist on Decibel DEX!`);
      }
    } catch {}

    this.saveTrades();
    return { closed: closedCount, failed: failedCount };
  }

  public closeAllOpenTrades(reason: 'closed_manual' | 'closed_tp' | 'closed_sl' = 'closed_manual'): number {
    this.closeAllOpenTradesAsync(reason).catch((err) => {
      logger.error(`closeAllOpenTradesAsync error: ${err.message}`);
    });
    return this.getOpenTrades().length;
  }

  /**
   * Close a specific trade by ID or symbol with on-chain verification
   */
  public async closeTradeAsync(idOrSymbol: string): Promise<boolean> {
    const trade = this.tradesCache.find(
      (t) => t.status === 'open' && (t.id === idOrSymbol || t.symbol === idOrSymbol),
    );
    if (!trade) return false;

    if (!trade.isPaper && this.aptos && this.aptosAccount) {
      try {
        logger.info(`⚡ [EXECUTOR] Executing on-chain close for ${trade.symbol}...`);
        const res = (await mcpClient.closePosition(trade.symbol, 1.0)) as any;
        if (res && res.error) {
          throw new Error(res.error);
        }
      } catch (err: any) {
        trade.status = 'close_failed' as any;
        this.saveTrades();
        logger.error(`🚨 [CLOSE FAILED] Could not close on-chain position for ${trade.symbol}: ${err.message}. Retaining allocation.`);
        return false;
      }
    }

    trade.status = 'closed_manual';
    trade.closedAt = Date.now();
    this.saveTrades();
    logger.info(`🧹 [EXECUTOR] Confirmed on-chain close for ${trade.symbol} (${trade.id}). Allocation released.`);
    this.notifyTradeClosed(trade);
    return true;
  }

  public closeTrade(idOrSymbol: string): boolean {
    const trade = this.tradesCache.find(
      (t) => t.status === 'open' && (t.id === idOrSymbol || t.symbol === idOrSymbol),
    );
    if (!trade) return false;
    this.closeTradeAsync(idOrSymbol).catch((err) => {
      logger.error(`closeTradeAsync error: ${err.message}`);
    });
    return true;
  }

  private cachedOnChainBalance: { balanceUsd: number; aptBalance: number; lastChecked: number } = {
    balanceUsd: 0,
    aptBalance: 0,
    lastChecked: 0,
  };

  /**
   * Fetch live on-chain balance (in USD equivalent) from Aptos / Decibel.
   * Returns 0 if credentials are not configured or placeholder.
   */
  public async fetchOnChainBalance(): Promise<{ balanceUsd: number; aptBalance: number }> {
    if (!isClientConfigured()) {
      return { balanceUsd: 0, aptBalance: 0 };
    }

    // Cache for 15 seconds to avoid RPC spam
    const now = Date.now();
    if (now - this.cachedOnChainBalance.lastChecked < 15000 && this.cachedOnChainBalance.lastChecked > 0) {
      return {
        balanceUsd: this.cachedOnChainBalance.balanceUsd,
        aptBalance: this.cachedOnChainBalance.aptBalance,
      };
    }

    const sub = config.DECIBEL_SUBACCOUNT_ADDRESS || config.DECIBEL_OWNER_ADDRESS;
    if (!sub || sub.includes('your_') || sub.length < 10) {
      return { balanceUsd: 0, aptBalance: 0 };
    }

    try {
      if (!this.aptos) {
        const net = config.NETWORK === 'testnet' ? Network.TESTNET : Network.MAINNET;
        this.aptos = createAptosClient(net);
      }

      // Option B (100% Non-Custodial): Monitor APT gas fuel strictly on client's derived signer address
      let aptBalance = 0;
      const signerAddr = this.getSignerAddress() || getDerivedSignerAddress();
      const gasFeeTarget = (signerAddr && !signerAddr.includes('your_') && signerAddr.startsWith('0x'))
        ? signerAddr
        : sub;

      try {
        const coinAmount = await this.aptos.getAccountCoinAmount({
          accountAddress: gasFeeTarget,
          coinType: '0x1::aptos_coin::AptosCoin',
        });
        aptBalance = Number(coinAmount) / 1e8;
      } catch (err: any) {
        logger.debug(`Could not fetch APT gas balance for ${gasFeeTarget}: ${err.message}`);
      }

      // Check subaccount margin collateral: First directly on-chain from Decibel DEX smart contract
      let balanceUsd = 0;
      const decibelContract = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
      const candidates: string[] = [sub];
      if (config.DECIBEL_OWNER_ADDRESS && !candidates.includes(config.DECIBEL_OWNER_ADDRESS)) {
        candidates.push(config.DECIBEL_OWNER_ADDRESS);
      }

      // If user passed primary account, resolve its primary subaccount
      try {
        const primaryRes = await this.aptos.view({
          payload: {
            function: `${decibelContract}::dex_accounts::primary_subaccount`,
            typeArguments: [],
            functionArguments: [sub],
          },
        });
        if (primaryRes?.[0] && typeof primaryRes[0] === 'string' && !candidates.includes(primaryRes[0])) {
          candidates.push(primaryRes[0]);
        }
      } catch { }

      // Query on-chain collateral & margin across candidate addresses
      for (const targetAddr of candidates) {
        try {
          const collRes = await this.aptos.view({
            payload: {
              function: `${decibelContract}::perp_engine::get_cross_total_collateral_value`,
              typeArguments: [],
              functionArguments: [targetAddr],
            },
          });
          if (collRes?.[0] !== undefined) {
            const rawVal = Number(collRes[0]);
            if (rawVal > 0) {
              balanceUsd = Math.max(balanceUsd, rawVal / 1e6);
            }
          }
        } catch { }

        try {
          const marginRes = await this.aptos.view({
            payload: {
              function: `${decibelContract}::accounts_collateral::available_order_margin`,
              typeArguments: [],
              functionArguments: [targetAddr],
            },
          });
          if (marginRes?.[0] !== undefined) {
            const rawVal = Number(marginRes[0]);
            if (rawVal > 0) {
              balanceUsd = Math.max(balanceUsd, rawVal / 1e6);
            }
          }
        } catch { }
      }

      // Fallback: If on-chain balance was 0 and REST API URL is configured, query REST API
      if (balanceUsd === 0 && config.DECIBEL_API_BASE_URL) {
        try {
          const res = await fetch(`${config.DECIBEL_API_BASE_URL}/subaccount?address=${sub}`, {
            headers: config.DECIBEL_NODE_API_KEY ? { Authorization: `Bearer ${config.DECIBEL_NODE_API_KEY}` } : {},
          });
          if (res.ok) {
            const data = (await res.json()) as any;
            if (data?.equity !== undefined) balanceUsd = Number(data.equity);
            else if (data?.freeCollateral !== undefined) balanceUsd = Number(data.freeCollateral);
            else if (data?.balance !== undefined) balanceUsd = Number(data.balance);
          }
        } catch { }
      }

      // Trading balance strictly reflects verified Decibel subaccount USD collateral.
      // APT balance is reserved strictly for on-chain transaction gas fees.
      // Preserve previous non-zero cached balance if a transient RPC poll returns 0.
      const finalBalanceUsd = balanceUsd > 0
        ? Number(balanceUsd.toFixed(2))
        : (this.cachedOnChainBalance.balanceUsd || 0);

      const finalAptBalance = aptBalance > 0
        ? Number(aptBalance.toFixed(4))
        : (this.cachedOnChainBalance.aptBalance || 0);

      this.cachedOnChainBalance = {
        balanceUsd: finalBalanceUsd,
        aptBalance: finalAptBalance,
        lastChecked: now,
      };

      return this.cachedOnChainBalance;
    } catch (err: any) {
      if (isNodeRateLimitOrAuthError(err)) {
        logger.warn(`⚠️ [BALANCE] Gateway rate-limit/auth error detected: ${err.message}. Triggering instant failover to Builder Proxy...`);
        triggerNodeKeyFailover(undefined, err.message);
        this.reinitAptos();
      }
      logger.debug(`fetchOnChainBalance failed: ${err.message}`);
      return {
        balanceUsd: this.cachedOnChainBalance.balanceUsd || 0,
        aptBalance: this.cachedOnChainBalance.aptBalance || 0,
      };
    }
  }

  public getCachedOnChainBalance(): { balanceUsd: number; aptBalance: number } {
    return {
      balanceUsd: this.cachedOnChainBalance.balanceUsd,
      aptBalance: this.cachedOnChainBalance.aptBalance,
    };
  }
}

export const tradeExecutor = new TradeExecutor();
