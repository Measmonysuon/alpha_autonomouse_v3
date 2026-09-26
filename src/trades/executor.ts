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
import { StandaloneSignal } from '../engine/standalone-engine';
import { AIBrainEvaluation } from '../ai/brain';
import { riskGuard, RiskValidationResult } from '../risk/guard';
import { mcpClient } from '../mcp/client';
import { telegramNotifier } from '../notify/telegram';
import type { StrategyAttribution } from '../strategy/types';
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
  isDualTp?: boolean;
  stopLoss: number;
  sizeUsd: number;
  sizeBase: number;
  leverage: number;
  allocatedUsd: number;
  confidence: number;
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

  constructor() {
    this.ensureDataDirectory();
    this.loadTrades();
    this.initAptosSigner();
  }

  public markExecutionInFlight(symbol: string): void {
    this.inFlightSymbols.add(symbol.replace('-', '/').toUpperCase());
  }

  public clearExecutionInFlight(symbol: string): void {
    this.inFlightSymbols.delete(symbol.replace('-', '/').toUpperCase());
  }

  public isExecutionInFlight(symbol: string): boolean {
    return this.inFlightSymbols.has(symbol.replace('-', '/').toUpperCase());
  }

  /**
   * Ensure leverage is configured on Decibel DEX subaccount for the market before trading
   */
  public async ensureLeverageConfigured(symbol: string, targetLeverage: number): Promise<void> {
    const symKey = symbol.replace('-', '/').toUpperCase();
    const desired = Math.max(1, Math.min(100, Math.round(targetLeverage)));
    if (this.configuredLeverages.get(symKey) === desired) {
      return;
    }

    try {
      logger.info(`⚙️ [EXECUTOR] Configuring on-chain leverage for ${symKey} to ${desired}x (cross margin)...`);
      await mcpClient.setLeverage(symKey, desired, 'cross');
      this.configuredLeverages.set(symKey, desired);
      logger.info(`✅ [EXECUTOR] On-chain leverage successfully set to ${desired}x for ${symKey}`);
    } catch (err: any) {
      logger.warn(`⚠️ [EXECUTOR] Failed to set leverage for ${symKey}: ${err.message}. Proceeding with trade.`);
    }
  }

  public onTradeClosed(listener: (trade: TradeRecord) => void): void {
    this.onTradeClosedListeners.push(listener);
  }

  public onShadowTradeResolved(listener: (shadow: ShadowTrade) => void): void {
    this.onShadowTradeResolvedListeners.push(listener);
  }

  public notifyTradeClosed(trade: TradeRecord): void {
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
          const rawStatus = (st.status || 'closed').toLowerCase();
          const status: 'open' | 'closed_tp' | 'closed_sl' | 'closed_manual' =
            rawStatus.includes('open') ? 'open' :
              rawStatus.includes('tp') ? 'closed_tp' :
                rawStatus.includes('sl') ? 'closed_sl' : 'closed_manual';

          const grossPnl = Number(st.realized_pnl || 0);
          const feeUsd = Number(st.fee_usd || 0);
          // Authoritative on-chain Net Realized PnL = Gross PnL minus on-chain protocol fees
          const netPnl = grossPnl - feeUsd;
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
              exitReason: st.exit_reason ?? undefined,
              notes: st.exit_reason ?? undefined,
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

        const lev = Math.max(1, pos.leverage || 1);
        const isLong = pos.action === 'LONG' || pos.side === 'buy';
        const defaultHardSl = isLong
          ? Number((pos.entryPrice * (1 - 0.15 / lev)).toFixed(4))
          : Number((pos.entryPrice * (1 + 0.15 / lev)).toFixed(4));
        const hardSl = pos.stopLoss && pos.stopLoss > 0 ? pos.stopLoss : defaultHardSl;
        // In loss / initial state, softRatchetPrice MUST equal hardSl to protect capital
        const softRatchet = hardSl;

        let existing = this.tradesCache.find(
          (t) => t.symbol.replace('-', '/').toUpperCase() === symNorm && t.status === 'open',
        );

        // If not found open, check if a recent closed trade can be revived (only if un-intentional RPC dropout)
        if (!existing) {
          const recentClosed = this.tradesCache.find(
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
                recentClosed.stopLoss = hardSl;
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

        if (!existing) {
          const newTrade: TradeRecord = {
            id: `decibel-onchain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            symbol: pos.symbol,
            side: isLong ? 'buy' : 'sell',
            action: isLong ? 'LONG' : 'SHORT',
            entryPrice: pos.entryPrice || 0,
            takeProfit: pos.takeProfit || 0,
            stopLoss: pos.stopLoss || 0,
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
            strategyName: 'Decibel On-Chain Position',
            notes: 'Reconciled directly from Aptos on-chain DEX state',
            estimatedProfitPct: (pos.takeProfit && pos.entryPrice) ? Math.abs((pos.takeProfit - pos.entryPrice) / pos.entryPrice) * 100 * (pos.leverage || 1) : 15.0,
            estimatedLossPct: hardSl && pos.entryPrice ? Math.abs((pos.entryPrice - hardSl) / pos.entryPrice) * 100 * (pos.leverage || 1) : 15.0,
            estimatedWinRatePct: 85,
          };
          this.tradesCache.push(newTrade);
          modified = true;
          logger.info(`🔄 [RECONCILE] Ingested live on-chain position: ${newTrade.symbol} ${newTrade.action} (${newTrade.sizeBase} units @ $${newTrade.entryPrice}, ${newTrade.leverage}x) [Hard SL: $${hardSl} | Soft Ratchet: $${softRatchet}]`);
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
          if (pos.takeProfit && pos.takeProfit !== existing.takeProfit) {
            existing.takeProfit = pos.takeProfit;
            modified = true;
          }
          if (pos.stopLoss && pos.stopLoss > 0) {
            const localSl = existing.stopLoss || 0;
            const isLong = existing.action === 'LONG';
            // Protect ratcheted / trailing SL:
            // Only adopt on-chain SL if local SL is unset (0),
            // OR if on-chain SL is strictly MORE protective than local ratcheted SL
            const isMoreProtective = localSl === 0 ||
              (isLong ? pos.stopLoss > localSl : pos.stopLoss < localSl);
            if (isMoreProtective && pos.stopLoss !== existing.stopLoss) {
              logger.info(`🛡️ [RECONCILE] Updating ${existing.symbol} SL from DEX: $${existing.stopLoss} → $${pos.stopLoss} (more protective)`);
              existing.stopLoss = pos.stopLoss;
              modified = true;
            }
          }
          if (pos.entryPrice && Math.abs(pos.entryPrice - existing.entryPrice) > 0.0001) {
            existing.entryPrice = pos.entryPrice;
            modified = true;
          }
          existing.hardStopLoss = hardSl;
          // Protect softRatchetPrice from being regressed backward (strict monotonic ratchet invariant)
          if (!existing.softRatchetPrice || existing.softRatchetPrice === 0) {
            existing.softRatchetPrice = existing.stopLoss && existing.stopLoss > 0 ? existing.stopLoss : hardSl;
          } else {
            const isLong = existing.action === 'LONG';
            // Ratchet can ONLY improve in favor of trade (up for Long, down for Short), never backward
            existing.softRatchetPrice = isLong
              ? Math.max(existing.softRatchetPrice, existing.stopLoss || 0, hardSl)
              : Math.min(existing.softRatchetPrice, existing.stopLoss || Infinity, hardSl);
          }
          if (pos.liquidationPrice) existing.estimatedLiquidationPrice = pos.liquidationPrice;

          const curLev = existing.leverage || pos.leverage || 1;
          const curTp = existing.takeProfit || pos.takeProfit || 0;
          const curEntry = existing.entryPrice || pos.entryPrice || 0;
          existing.estimatedProfitPct = (curTp > 0 && curEntry > 0)
            ? Math.abs((curTp - curEntry) / curEntry) * 100 * curLev
            : (existing.estimatedProfitPct || 15.0);
          existing.estimatedLossPct = (hardSl > 0 && curEntry > 0)
            ? Math.abs((curEntry - hardSl) / curEntry) * 100 * curLev
            : (existing.estimatedLossPct || 15.0);
          existing.estimatedWinRatePct = existing.confidence || existing.estimatedWinRatePct || 85;
          modified = true;
        }

        // Auto-arm on-chain hard SL if position is open without an active stop order
        if ((!pos.stopLoss || pos.stopLoss <= 0) && hardSl > 0 && isClientConfigured() && !config.PAPER_TRADING) {
          mcpClient.setTpSl({ symbol: pos.symbol, slTrigger: hardSl }).catch((err: any) => {
            logger.debug(`[ON-CHAIN HARD SL] Auto-arm notice for ${pos.symbol}: ${err.message}`);
          });
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
    const existing = this.getOpenTrades().find((t) => t.symbol.replace('-', '/').toUpperCase() === symKey);
    if (existing || this.isExecutionInFlight(symKey)) {
      return { success: false, error: `Position already open or order execution in flight for ${signal.symbol}` };
    }

    this.markExecutionInFlight(symKey);
    try {
      const currentAllocated = this.getOpenTrades().reduce((sum, t) => sum + (t.allocatedUsd || 0), 0);
      const accountEquity = config.BUDGET_USD; // or live margin balance
      const availableMargin = Math.max(0, config.BUDGET_USD - currentAllocated);

      // 1. Run Pre-Trade Risk Guard
      const risk = riskGuard.validateSignal(signal, aiEval, accountEquity, availableMargin, currentAllocated);
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
          await this.ensureLeverageConfigured(signal.symbol, risk.leverage);

          const liveResult = await this.executeOnChain(
            signal.symbol,
            side,
            risk.positionSizeBase,
            signal.entryPrice,
            risk.leverage,
            signal.limitPrice,
            signal.postOnly,
          );
          orderId = liveResult.orderId;
          txHash = liveResult.txHash;

          // Attach on-chain TP/SL directly onto Decibel DEX order book
          if (signal.takeProfit > 0 || signal.stopLoss > 0) {
            logger.info(`🎯 [ON-CHAIN TP/SL] Arming TP: $${signal.takeProfit} | SL: $${signal.stopLoss} on ${signal.symbol}...`);
            try {
              await mcpClient.setTpSl({
                symbol: signal.symbol,
                tpTrigger: signal.takeProfit,
                slTrigger: signal.stopLoss,
              });
              logger.info(`✅ [ON-CHAIN TP/SL] Confirmed TP/SL placement for ${signal.symbol}`);
            } catch (tpErr: any) {
              logger.warn(`⚠️ [ON-CHAIN TP/SL] Failed to immediately attach TP/SL: ${tpErr.message}`);
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
        ? signal.entryPrice * (1 - 0.15 / Math.max(1, risk.leverage))
        : signal.entryPrice * (1 + 0.15 / Math.max(1, risk.leverage));

      const slDistPct = signal.entryPrice > 0 ? (Math.abs(signal.entryPrice - (signal.stopLoss || hardSlPrice)) / signal.entryPrice * 100).toFixed(2) : '1.66';
      const marginRiskPct = (Number(slDistPct) * risk.leverage).toFixed(1);
      const coinSym = signal.symbol.split('/')[0] || signal.symbol;

      const initialLifecycleEvent: TradeLifecycleEvent = {
        timestamp: Date.now(),
        stage: 'ENTRY',
        title: `Entry: ${signal.action === 'LONG' ? 'Bought' : 'Sold short'} ${risk.positionSizeBase || ''} ${coinSym} @ $${signal.entryPrice.toFixed(2)} (${risk.leverage}x leverage)`,
        description: `Initial Hard SL armed on-chain at $${(signal.stopLoss || hardSlPrice).toFixed(2)} (-${slDistPct}% price / -${marginRiskPct}% margin). Target TP1: $${(signal.takeProfit1 || signal.takeProfit || 0).toFixed(2)} | Target TP2: $${(signal.takeProfit2 || 0) > 0 ? '$' + signal.takeProfit2!.toFixed(2) : 'Dynamic Runner'}`,
        price: signal.entryPrice,
        details: [
          `Initial Hard SL armed on-chain at $${(signal.stopLoss || hardSlPrice).toFixed(2)} (-${slDistPct}% price / -${marginRiskPct}% margin).`,
          `Target TP1: $${(signal.takeProfit1 || signal.takeProfit || 0).toFixed(2)} | Target TP2: $${(signal.takeProfit2 || 0) > 0 ? '$' + signal.takeProfit2!.toFixed(2) : 'Dynamic Runner'}`,
          `Capital allocated: $${risk.allocatedUsd.toFixed(2)} (${risk.leverage}x cross-margin)`
        ]
      };

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
        stopLoss: signal.stopLoss,
        sizeUsd: risk.positionSizeUsd,
        sizeBase: risk.positionSizeBase,
        leverage: risk.leverage,
        allocatedUsd: risk.allocatedUsd,
        confidence: aiEval.confidenceScore,
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
        softRatchetPrice: signal.stopLoss || hardSlPrice,
        estimatedProfitPct: signal.takeProfit && signal.entryPrice ? Math.abs((signal.takeProfit - signal.entryPrice) / signal.entryPrice) * 100 * risk.leverage : 15.0,
        estimatedLossPct: hardSlPrice && signal.entryPrice ? Math.abs((signal.entryPrice - hardSlPrice) / signal.entryPrice) * 100 * risk.leverage : 15.0,
        estimatedWinRatePct: aiEval.confidenceScore || 78,
        atr: signal.indicators.atr14,
        lifecycleEvents: [initialLifecycleEvent],
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
   */
  private async executeOnChain(
    symbol: string,
    side: 'buy' | 'sell',
    size: number,
    entryPrice: number,
    targetLeverage?: number,
    targetLimitPrice?: number,
    preferPostOnly = false,
  ): Promise<{ orderId: string; txHash: string }> {
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
    // If entryPrice <= 0, fetch current mark price
    let refPrice = entryPrice;
    if (refPrice <= 0) {
      try {
        const p = await mcpClient.getPrice(symbol);
        refPrice = p.markPrice || p.lastPrice || 0;
      } catch { }
    }

    // Determine Maker Post-Only Limit Price vs Taker IOC Price
    const isMakerPostOnly = Boolean(preferPostOnly && targetLimitPrice && targetLimitPrice > 0);
    const timeInForce = isMakerPostOnly ? 0 : 2; // 0 = GTC PostOnly, 2 = ImmediateOrCancel (IOC)
    const isPostOnly = isMakerPostOnly;

    let limitPrice = 0;
    if (isMakerPostOnly && targetLimitPrice) {
      limitPrice = targetLimitPrice;
    } else {
      const takerSlippage = 0.002;
      limitPrice = refPrice > 0
        ? (isBuy ? refPrice * (1 + takerSlippage) : refPrice * (1 - takerSlippage))
        : 0;
    }

    const chainPrice = limitPrice > 0
      ? Math.round((limitPrice * Math.pow(10, market.priceDecimals)) / market.tickSize) * market.tickSize
      : (isBuy ? 999999999999 : 1);

    let chainSize = Math.round(size * Math.pow(10, market.sizeDecimals));
    if (market.lotSize && market.lotSize > 0) {
      chainSize = Math.round(chainSize / market.lotSize) * market.lotSize;
    }
    if (market.minSize && chainSize < market.minSize) {
      chainSize = market.minSize;
    }

    // Double-check effective notional to prevent decimal misconfigurations from inflating positions
    const effectiveBase = chainSize / Math.pow(10, market.sizeDecimals);
    const effectiveNotional = effectiveBase * (refPrice > 0 ? refPrice : entryPrice);
    const maxAllowedNotional = Math.max(config.BUDGET_USD * (targetLeverage || config.MAX_LEVERAGE) * 1.5, 200);

    if (effectiveNotional > maxAllowedNotional) {
      const err = `CRITICAL ON-CHAIN GUARD: Order notional ($${effectiveNotional.toFixed(2)}) exceeds safety cap ($${maxAllowedNotional.toFixed(2)})! Base size=${effectiveBase} ${symbol}, sizeDecimals=${market.sizeDecimals}. Order aborted.`;
      logger.error(`🛑 ${err}`);
      throw new Error(err);
    }

    const clientOrderId = `decibel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    if (isMakerPostOnly) {
      logger.info(`🏛️ [MAKER POST-ONLY] Routing resting FVG limit order on Decibel DEX: ${symbol} ${side.toUpperCase()} sizeUnits=${chainSize} priceLimit=${chainPrice} (0% Taker Fee)`);
    } else {
      logger.info(`⚡ [ON-CHAIN IOC] Signing Decibel order: ${symbol} ${side.toUpperCase()} sizeUnits=${chainSize} priceLimit=${chainPrice} (IOC Market Execution)`);
    }

    const sendTx = async (): Promise<string> => {
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
            isPostOnly,
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

      return committed.hash;
    };

    let txHash: string;
    try {
      txHash = await sendTx();
    } catch (err: any) {
      if (isNodeRateLimitOrAuthError(err)) {
        logger.warn(`⚠️ [ON-CHAIN] Gateway rate-limit/auth error (${err.message}). Instant 0s failover to Builder Proxy...`);
        triggerNodeKeyFailover(undefined, err.message);
        this.reinitAptos();
        txHash = await sendTx();
      } else {
        throw err;
      }
    }

    logger.info(`🎯 [ON-CHAIN FILLED] Tx: ${txHash}`);

    // Set TP/SL via MCP or on-chain helper
    return { orderId: clientOrderId, txHash };
  }

  /**
   * Monitor open positions against live market price to enforce dynamic TP and SL,
   * and monitor active shadow trades to calculate counterfactual wins/losses (capital saved).
   */
  public monitorOpenTrades(livePrices: Record<string, number>): void {
    let modified = false;

    // 1. Monitor real open trades
    for (const trade of this.getOpenTrades()) {
      const currentPrice = livePrices[trade.symbol];
      if (!currentPrice || currentPrice <= 0) continue;

      const isLong = trade.action === 'LONG';
      let hitTp = false;
      let hitSl = false;

      if (isLong) {
        if (trade.takeProfit > 0 && currentPrice >= trade.takeProfit) hitTp = true;
        else if (trade.stopLoss > 0 && currentPrice <= trade.stopLoss) hitSl = true;
      } else {
        if (trade.takeProfit > 0 && currentPrice <= trade.takeProfit) hitTp = true;
        else if (trade.stopLoss > 0 && currentPrice >= trade.stopLoss) hitSl = true;
      }

      if (hitTp || hitSl) {
        const priceDiff = isLong ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
        const pnlPct = (priceDiff / trade.entryPrice) * 100 * trade.leverage;
        const pnlUsd = (trade.allocatedUsd * pnlPct) / 100;
        const isProfitable = (isLong ? currentPrice >= trade.entryPrice : currentPrice <= trade.entryPrice) || (pnlUsd >= 0);
        let exitStatus: 'closed_tp' | 'closed_sl' = 'closed_sl';
        let exitReasonStr = 'ON_CHAIN_SL';

        if (hitTp || pnlUsd > 0.05) {
          exitStatus = 'closed_tp';
          exitReasonStr = hitTp ? 'ON_CHAIN_TP' : ((trade.breakevenMoved || isProfitable) ? 'TRAILING_TP' : 'DEX_TP_EXTERNAL');
        } else if (trade.breakevenMoved || isProfitable) {
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
        if (st.takeProfit > 0 && currentPrice >= st.takeProfit) hitTp = true;
        else if (st.stopLoss > 0 && currentPrice <= st.stopLoss) hitSl = true;
      } else {
        if (st.takeProfit > 0 && currentPrice <= st.takeProfit) hitTp = true;
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
   * Close all currently open positions
   */
  public closeAllOpenTrades(reason: 'closed_manual' | 'closed_tp' | 'closed_sl' = 'closed_manual'): number {
    const open = this.getOpenTrades();
    const count = open.length;
    for (const trade of open) {
      trade.status = reason;
      trade.closedAt = Date.now();
    }
    if (count > 0) {
      this.saveTrades();
      logger.info(`🧹 [EXECUTOR] Closed ${count} open positions. Budget allocation released.`);
      for (const trade of open) {
        this.notifyTradeClosed(trade);
      }
    }
    return count;
  }

  /**
   * Close a specific trade by ID or symbol
   */
  public closeTrade(idOrSymbol: string): boolean {
    const trade = this.tradesCache.find(
      (t) => t.status === 'open' && (t.id === idOrSymbol || t.symbol === idOrSymbol),
    );
    if (!trade) return false;
    trade.status = 'closed_manual';
    trade.closedAt = Date.now();
    this.saveTrades();
    logger.info(`🧹 [EXECUTOR] Manually closed position for ${trade.symbol} (${trade.id}).`);
    if (!trade.isPaper && this.aptos && this.aptosAccount) {
      mcpClient.closePosition(trade.symbol).catch((err: any) => {
        logger.warn(`Could not close on-chain position for ${trade.symbol}: ${err.message}`);
      });
    }
    this.notifyTradeClosed(trade);
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
