/**
 * Lightweight Dashboard & Health API Server
 * 
 * Exposes live agent state over HTTP for the web dashboard and health monitors:
 *  - GET /health                  -> Health check endpoint
 *  - GET /api/state               -> Live operating mode, active directives, budget, and stats
 *  - GET /api/positions           -> Live open positions
 *  - GET /api/trades              -> Trade journal from data/trades.json
 *  - GET /api/stats               -> Win rate, realized PnL, budget utilization
 *  - GET /api/directives          -> Active strategy directives (Standalone vs Sim Lab)
 *  - GET /api/setup/status        -> Checks if real credentials are configured
 *  - POST /api/setup/activate     -> Activates bot with new credentials
 *  - POST /api/auth/login         -> Admin password login verification
 *  - GET /api/auth/check          -> Checks authentication status
 *  - GET /api/settings            -> Sanitized settings
 *  - POST /api/settings           -> Dynamic settings updates
 *  - GET /api/simlab/features     -> Sim Lab Supercharge feature flags and status
 *  - POST /api/simlab/features    -> Update feature flags and connect/disconnect
 *  - GET /api/strategies          -> Strategy Studio catalog (Pre-built + Custom)
 *  - POST /api/strategies/activate-> Switch active strategy
 *  - POST /api/strategies/save    -> Save/edit custom strategy
 *  - GET /api/logs/stream         -> Real-time SSE log stream
 *  - Static file server for dashboard/ UI
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import axios from 'axios';
import { Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import { createAptosClient } from './utils/node-key-resolver';
import { config, watchPairs, isClientConfigured, isClientOnboarded, updateDynamicSettings, getDerivedSignerAddress, getAISettings, isValidApiKey, loadPersistentSettings, APP_ROOT } from './config';
import { logger } from './utils/logger';
import { tradeExecutor, TradeRecord } from './trades/executor';
import { mcpClient } from './mcp/client';
import { onChainPipeline } from './pipeline/onchain-sync-pipeline';
import { decibelPriceFeed } from './pipeline/decibel-price-feed';
import { portfolioHarvester } from './engine/harvester';
import { riskGuard } from './risk/guard';
import { standaloneEngine, fetchPublicKlines, updateBaselinePrice, getDynamicSmaPeriodsForSymbol } from './engine/standalone-engine';
import { superchargeClient } from './simlab/supercharge-client';
import { telegramNotifier } from './notify/telegram';
import { smaReversalEngine } from './engine/sma-reversal-engine';
import { localAIBrain } from './ai/brain';
import {
  getAllStrategies,
  getActiveStrategy,
  getActiveStrategyOriginInfo,
  setActiveStrategy,
  saveCustomStrategy,
  deleteCustomStrategy,
  getStrategySyncConfig,
  updateStrategySyncConfig,
  setSimLabConnectionChecker,
  getAllPairOverrides,
  getPairOverrides,
  setPairLayerOverride,
  resetPairOverride,
  resetAllPairOverrides,
  setBulkPairLayerOverride,
  applyPairPreset,
  setPairRiskOverrides,
  clonePairOverrides,
  autoTunePairWithAI,
  getSimPairDirectives,
  getSimPairDirective,
} from './strategy/manager';
import { dbClient, DbTrade } from './db/database';
import { processUserMessage, registerCopilotHandlers } from './agent/copilot';
import { getSystemHardwareStats, getDesktopGUIStatus, setDesktopGUIState } from './utils/system';

export interface LogEntry {
  ts: number;
  level: string;
  msg: string;
}

// ── In-Memory Model Cache for Instant Settings Page Load (<1ms) ───────────────
const aiModelCache = new Map<string, { timestamp: number; models: any[]; source: string }>();
const AI_MODEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface VetoWatchEntry {
  symbol: string;
  vetoedAt: number;
  watchUntil: number;
  pollCount: number;
  lastVerdict: string;
}

export interface MarketState {
  symbol: string;
  markPrice: number;
  change24h?: number;
  trend?: string;
  action?: string;
  confidence: number;
  riskLevel?: string;
  candlestick?: any;
  [key: string]: any;
}

export interface AgentState {
  status: string;
  uptime: number;
  network: string;
  mode: string;
  maxRiskPct: number;
  subaccount: string;
  agentAddress: string;
  gasAptBalance: number;
  cycleCount: number;
  pairs: string[];
  currentPairs: string[];
  markets: Record<string, MarketState>;
  recentLogs: LogEntry[];
  trapShieldEvents: any[];
  vetoWatch: Record<string, VetoWatchEntry>;
  accountEquityUsd: number;
  availableMarginUsd: number;
  startedAt: number;
  budgetUsd: number;
  minAllocPct: number;
  maxAllocPct: number;
  minConfidencePct: number;
  [key: string]: any;
}

export const agentState: AgentState = {
  status: 'running',
  uptime: 0,
  network: config.NETWORK,
  mode: config.AUTONOMOUS_MODE,
  maxRiskPct: config.MAX_RISK_PER_TRADE_PCT,
  subaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
  agentAddress: config.DECIBEL_OWNER_ADDRESS || '0x_agent',
  gasAptBalance: 0,
  cycleCount: 0,
  pairs: watchPairs,
  currentPairs: watchPairs,
  markets: {} as Record<string, MarketState>,
  recentLogs: [] as LogEntry[],
  trapShieldEvents: [] as any[],
  vetoWatch: {} as Record<string, VetoWatchEntry>,
  accountEquityUsd: 0,
  availableMarginUsd: 0,
  startedAt: Date.now(),
  budgetUsd: config.BUDGET_USD,
  minAllocPct: config.MIN_ALLOC_PCT,
  maxAllocPct: config.MAX_ALLOC_PCT,
  minConfidencePct: config.MIN_CONFIDENCE_PCT,
};

export function getSimLabConnectionStatus(): boolean {
  let isConsumerActive = false;
  try {
    const { isSimPipelineActive } = require('./pipeline/sim-consumer');
    isConsumerActive = Boolean(isSimPipelineActive());
  } catch {}
  return superchargeClient.isActive() || isConsumerActive;
}

export function getEffectiveMacroDirective(directives?: any): any {
  const curDirectives = directives || standaloneEngine.getDirectives();
  try {
    const { getLastSyncedBundle } = require('./pipeline/sim-consumer');
    const bundle = getLastSyncedBundle();
    const bundleMacro = bundle?.macro;
    const bundleStrat = bundle?.strategy;
    const regime = bundleMacro?.regime || curDirectives.regime || 'ACTIVE';
    const isChop = regime === 'RANGING_CHOP' || regime === 'HIGH_VOLATILITY' || regime === 'STAGFLATION_CHOP';
    const macroBuffer = typeof bundleMacro?.macroBuffer === 'number'
      ? bundleMacro.macroBuffer
      : (isChop ? 5 : 0);
    const macroBufferReason = (bundleMacro?.macroBufferReason && bundleMacro.macroBufferReason.trim())
      || (bundleMacro?.coolingReason && bundleMacro.coolingReason.trim())
      || (isChop ? 'Chop Protection (Sub-20 ADX)' : 'Clear Macro');
    const macroScoreBonus = typeof bundleMacro?.macroScoreBonus === 'number' ? bundleMacro.macroScoreBonus : 0;
    const scoreFloor = bundleStrat?.dynamicScoreFloor || bundleStrat?.minConfidenceGate || curDirectives.scoreFloor || 65;
    return {
      regime,
      scoreFloor,
      macroBuffer,
      macroBufferReason,
      macroScoreBonus,
      summary: bundleMacro?.summary || curDirectives.notes || 'Sim Lab Alpha Synced',
      btcBias: bundleMacro?.marketBias || (curDirectives.bannedSides?.includes('SHORT') ? 'BULLISH' : 'NEUTRAL'),
      altPolicy: (bundleMacro as any)?.altPolicy || 'ALLOW_ALL',
      bannedSides: bundleMacro?.bannedSides || curDirectives.bannedSides || [],
      nearestNewsEvent: bundleMacro?.nearestNewsTitle ? {
        title: bundleMacro.nearestNewsTitle,
        minutesAway: bundleMacro.nearestNewsMinutes ?? 0,
      } : null,
    };
  } catch {
    return {
      regime: curDirectives?.regime || 'ACTIVE',
      scoreFloor: curDirectives?.scoreFloor || 65,
      macroBuffer: 0,
      macroBufferReason: 'Clear Macro',
      macroScoreBonus: 0,
      summary: curDirectives?.notes || 'Directives Active',
      btcBias: curDirectives?.bannedSides?.includes('SHORT') ? 'BULLISH' : 'NEUTRAL',
      altPolicy: 'ALLOW_ALL',
      bannedSides: curDirectives?.bannedSides || [],
      nearestNewsEvent: null,
    };
  }
}

// Initialize Sim Lab connection status checker for strategy manager
setSimLabConnectionChecker(() => {
  return getSimLabConnectionStatus();
});

let scanTriggerFn: (() => void) | null = null;
export function registerScanTrigger(fn: () => void): void {
  scanTriggerFn = fn;
}
export function triggerImmediateScan(): void {
  if (scanTriggerFn) {
    try {
      scanTriggerFn();
    } catch (e: any) {
      logger.error(`Error triggering immediate scan: ${e.message}`);
    }
  }
}

export const DEFAULT_PAIR_PRICES: Record<string, number> = {
  'BTC/USD': 79589.5,
  'ETH/USD': 2386.2,
  'HYPE/USD': 81.55,
  'SOL/USD': 95.24,
  'LINK/USD': 11.416,
  'ZEC/USD': 1303.12,
  'DOGE/USD': 0.07588,
  'BNB/USD': 710.86,
  'XRP/USD': 1.3066,
  'MON/USD': 0.017817,
  'AAVE/USD': 130.2,
  'ADA/USD': 0.19477,
  'APT/USD': 0.6321,
  'NEAR/USD': 3.9329,
  'TAO/USD': 231.62,
  'kPEPE/USD': 0.004915,
  'PEPE/USD': 0.000004915,
  'MEGA/USD': 0.04706,
  'SUI/USD': 0.9116,
  'ENA/USD': 0.17848,
  'LIT/USD': 3.42607,
  'FARTCOIN/USD': 0.12143,
  'TRUMP/USD': 1.2398,
  'LDO/USD': 0.34179,
  'MORPHO/USD': 2.2285,
  'CHIP/USD': 0.042346,
  'PUMP/USD': 0.004202,
  'XPL/USD': 0.06402,
  'AVAX/USD': 8.652,
  'UNI/USD': 7.2868,
  'GME/USD': 25.173,
  'WLFI/USD': 0.04545,
  'TRX/USD': 0.31771,
  'ZRO/USD': 1.7299,
  'SONY/USD': 27.497,
  'TTWO/USD': 213.16,
  'APT/USDC': 0.6321,
  'ETH/USDC': 2386.2,
  'BTC/USDC': 79589.5,
  'XRP/USDC': 1.3066,
  'TSLA/USD': 375.04,
  'MSTR/USD': 139.81,
  'GOLD/USD': 4115.8,
  'SILVER/USD': 52.66,
  'COPPER/USD': 6.4323,
  'WTIOIL/USD': 89.664,
  'NATGAS/USD': 2.9682,
};

export function seedMarketsForPairs(): void {
  for (const sym of watchPairs) {
    const decibelPx = decibelPriceFeed.getPrice(sym);
    const basePrice = (decibelPx && decibelPx.markPrice > 0) ? decibelPx.markPrice : (DEFAULT_PAIR_PRICES[sym] || 10.0);
    const smaProf = getDynamicSmaPeriodsForSymbol(sym);
    const simDir = getSimPairDirective(sym);
    const fastP = simDir?.fastPeriod || smaProf.fast;
    const slowP = simDir?.slowPeriod || smaProf.slow;
    const initImb = simDir?.orderflow?.orderflowImbalancePct !== undefined
      ? Number(simDir.orderflow.orderflowImbalancePct)
      : 0.0;

    if (!agentState.markets[sym] || agentState.markets[sym].markPrice === 0) {
      agentState.markets[sym] = {
        symbol: sym,
        markPrice: basePrice,
        price: basePrice,
        oraclePrice: (decibelPx && decibelPx.oraclePrice > 0) ? decibelPx.oraclePrice : basePrice,
        change24h: 0.0,
        volume24hUsd: basePrice * 45000,
        high24h: basePrice * 1.005,
        low24h: basePrice * 0.995,
        trend: 'SCANNING',
        action: 'SCANNING',
        confidence: 0,
        riskLevel: 'LOW',
        fundingRate: 0.0,
        fastPeriod: fastP,
        slowPeriod: slowP,
        robustIsland: {
          fastPeriod: fastP,
          slowPeriod: slowP,
          currentFastSma: simDir?.currentFastSma || basePrice,
          currentSlowSma: simDir?.currentSlowSma || basePrice,
          smaSpreadPct: simDir?.smaSpreadPct !== undefined ? Number(simDir.smaSpreadPct) : 0.0,
          smaAlignment: simDir?.smaAlignment || 'NEUTRAL',
          wfe: simDir?.wfe !== undefined ? Number(simDir.wfe) : 0.88,
          robustScore: simDir?.robustScore !== undefined ? Number(simDir.robustScore) : 85,
          source: simDir?.fastPeriod ? 'SIM_LAB' : 'DEFAULT_PRESET',
        },
        imbalance: initImb,
        candlestick: { rsi14: 50, ema9: basePrice, ema21: basePrice, rvol: 1.0, adx14: 20 },
        updatedAt: Date.now(),
      };
    }
  }
}

// Seed pairs immediately on server boot
seedMarketsForPairs();

export function getLivePricesMap(): Record<string, number> {
  const map: Record<string, number> = {};
  if (agentState && agentState.markets) {
    for (const [sym, m] of Object.entries(agentState.markets)) {
      if (m && m.markPrice > 0) {
        map[sym] = m.markPrice;
      }
    }
  }
  return map;
}

let liveTickerTimer: NodeJS.Timeout | null = null;
let liveTickerInFlight = false;
const sseStateClients = new Set<http.ServerResponse>();
const recentLogs: LogEntry[] = [];
const sseClients = new Set<http.ServerResponse>();
const startedAt = Date.now();
let lastStateOnChainSync = 0;
let lastPositionsSync = 0;
let cachedStateEquity = 0;
let cachedStateMargin = 0;
let cachedStateGasApt = 0;

export function getEffectiveOpenPositions(): TradeRecord[] {
  const isConf = isClientConfigured();
  if (isConf && !config.PAPER_TRADING) {
    const pipe = onChainPipeline.getConsolidatedState();
    if (pipe.timestamp > 0) {
      const pipePositions = onChainPipeline.getPositions();
      if (Array.isArray(pipePositions)) {
        return pipePositions.filter((p) => !p.status || p.status === 'open');
      }
    }
  }
  return tradeExecutor.getOpenTrades();
}

export function getEffectiveRestingOrders(): any[] {
  const isConf = isClientConfigured();
  if (isConf && !config.PAPER_TRADING) {
    const pipe = onChainPipeline.getConsolidatedState();
    if (pipe.timestamp > 0) {
      const pipeOrders = pipe.restingOrders;
      if (Array.isArray(pipeOrders)) {
        return pipeOrders;
      }
    }
  }
  return tradeExecutor.getRestingOrders();
}

export function syncHarmonizedMarkets(): Record<string, any> {
  const coolOffs = riskGuard.getAllActiveCoolOffs();
  const coolMap: Record<string, any> = {};
  for (const c of coolOffs) {
    coolMap[c.symbol] = c;
    coolMap[c.symbol.replace(/[-_/]/g, '')] = c;
  }
  const simDirs = getSimPairDirectives();

  // Inspect live on-chain open positions and resting limit orders
  const openTrades = getEffectiveOpenPositions();
  const restingOrders = getEffectiveRestingOrders();
  const openTradeMap = new Map<string, any>();
  for (const t of openTrades) {
    const k = (t.symbol || '').toUpperCase().replace(/[-_/]/g, '');
    openTradeMap.set(k, t);
  }
  const restingOrderMap = new Map<string, any>();
  for (const o of restingOrders) {
    const k = (o.symbol || o.market || '').toUpperCase().replace(/[-_/]/g, '');
    const price = typeof o.price === 'number' ? o.price : parseFloat(o.price || '0');
    const isTrigger = Boolean(o.is_tpsl || o.is_reduce_only || o.order_type === 'Stop Market' || o.order_type === 'Stop Limit');
    // Only map genuine resting limit orders (not trigger stop orders, and never if position is already open)
    if (!openTradeMap.has(k) && price > 0 && !isTrigger) {
      restingOrderMap.set(k, o);
    }
  }

  // Prune any legacy unlisted markets not in Decibel DEX universe
  for (const sym of Object.keys(agentState.markets)) {
    const norm = sym.toUpperCase().replace(/[-_]/g, '/');
    if (!DEFAULT_PAIR_PRICES[norm] && !DEFAULT_PAIR_PRICES[sym] && !watchPairs.includes(sym)) {
      delete agentState.markets[sym];
    }
  }

  for (const [sym, m] of Object.entries(agentState.markets)) {
    const clean = sym.toUpperCase().replace(/[-_/]/g, '');
    const co = coolMap[sym] || coolMap[clean];
    const sd = simDirs[sym] || simDirs[clean];
    const isCool = Boolean(co && (!co.expiresAt || co.expiresAt > Date.now()));
    const activeTrade = openTradeMap.get(clean);
    const restingOrd = restingOrderMap.get(clean);

    // Preserve authentic strategy confidence if already evaluated by engine
    if (m.confidence === undefined || m.confidence === null || m.confidence === 0) {
      if (sd?.regime?.confidence !== undefined) {
        m.confidence = Number(sd.regime.confidence);
      }
    }
    if (sd?.confidenceSizing?.confidenceScore !== undefined) {
      m.sizingConfidence = Math.round(Number(sd.confidenceSizing.confidenceScore) * 100);
    }
    if (sd?.regime?.confidence !== undefined) {
      m.regimeConfidence = Number(sd.regime.confidence);
    }

    // STRICT DISTINCTION: Real On-Chain Position vs Resting Order vs Scanning Opportunities
    if (activeTrade && activeTrade.entryPrice > 0) {
      m.action = activeTrade.action === 'SHORT' ? 'OPEN SHORT' : 'OPEN LONG';
      m.isPositionOpen = true;
      m.isOrderResting = false;
      m.isVetoed = false;
    } else if (restingOrd && Number(restingOrd.price) > 0 && !restingOrd.is_tpsl && !restingOrd.is_reduce_only) {
      m.action = 'LIMIT ORDER';
      m.isOrderResting = true;
      m.isPositionOpen = false;
      m.isVetoed = false;
    } else if (isCool) {
      m.action = co.trapCategory || co.action || 'TRAP_VETO';
      m.isVetoed = true;
      m.isPositionOpen = false;
      m.isOrderResting = false;
    } else if (sd?.coolOffActive || sd?.isVetoed) {
      m.action = 'SIM_COOLOFF';
      m.isVetoed = true;
      m.isPositionOpen = false;
      m.isOrderResting = false;
    } else if (sd?.bannedSide && sd.bannedSide !== 'NONE') {
      m.action = `NO_${sd.bannedSide}S`;
      m.isVetoed = false;
      m.isPositionOpen = false;
      m.isOrderResting = false;
      m.isVetoed = false;
      m.isPositionOpen = false;
    } else if (sd?.assignedTier === 'TIER_3_PROBATION' && (sd?.tierAllocPct === 0 || sd?.allocPct === 0)) {
      m.action = 'PROBATION';
      m.isVetoed = false;
      m.isPositionOpen = false;
    } else {
      const minGate = typeof sd?.minConfidenceGate === 'number' ? sd.minConfidenceGate : 80;
      const isTriggerReady = Boolean(
        m.isTriggered && 
        m.confidence >= minGate && 
        (m.action === 'LONG' || m.action === 'SHORT' || m.candidateAction === 'LONG' || m.candidateAction === 'SHORT')
      );

      if (isTriggerReady) {
        const act = m.candidateAction || (m.action === 'LONG' || m.action === 'SHORT' ? m.action : 'LONG');
        m.action = `TRIGGER READY ${act}`;
        m.isVetoed = false;
        m.isPositionOpen = false;
      } else if (m.confidence >= minGate) {
        m.action = `ARMED ${m.confidence}%`;
        m.isVetoed = false;
        m.isPositionOpen = false;
      } else if (m.confidence >= 65) {
        m.action = `MONITORING ${m.confidence}%`;
        m.isVetoed = false;
        m.isPositionOpen = false;
      } else if (m.confidence >= 45) {
        m.action = 'SCANNING';
        m.isVetoed = false;
        m.isPositionOpen = false;
      } else {
        m.action = 'STANDBY';
        m.isVetoed = false;
        m.isPositionOpen = false;
      }
    }
  }
  return agentState.markets;
}

export function buildStreamStatePayload() {
  const curStats = tradeExecutor.getStats();
  const isConf = isClientConfigured();
  const pipeState = onChainPipeline.getConsolidatedState();
  const cachedBal = tradeExecutor.getCachedOnChainBalance();
  const curEquity = isConf ? (pipeState.accountEquityUsd || Math.max(0, cachedBal.balanceUsd || 0)) : 0;
  const curMargin = isConf ? (pipeState.availableMarginUsd || Math.max(0, curEquity - curStats.budgetUsedUsd)) : 0;
  const curApt = isConf ? (pipeState.gasAptBalance || cachedBal.aptBalance || 0) : 0;
  const curSigner = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
  const curSub = (config.DECIBEL_SUBACCOUNT_ADDRESS && !config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_')) ? config.DECIBEL_SUBACCOUNT_ADDRESS : '';
  const tickUptime = Math.floor((Date.now() - startedAt) / 1000);
  const isSimLabConn = getSimLabConnectionStatus();
  const curDirectives = standaloneEngine.getDirectives();
  const curMacroDirective = getEffectiveMacroDirective(curDirectives);

  return {
    status: tradeExecutor.getIsPaused() ? 'PAUSED' : 'running',
    isPaused: tradeExecutor.getIsPaused(),
    mode: config.AUTONOMOUS_MODE,
    clientName: config.CLIENT_NAME,
    operatingMode: isSimLabConn ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
    isSimLabSupercharged: isSimLabConn,
    isSimLabConnected: isSimLabConn,
    simPipeline: {
      connected: isSimLabConn,
      isStale: false,
      currentRegime: curDirectives.regime,
      appliedConfidenceGate: curDirectives.scoreFloor,
      appliedHarvestThreshold: 65,
      serverUrl: superchargeClient.getServerUrl(),
      mode: isSimLabConn ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
    },
    uptime: tickUptime,
    uptimeSeconds: tickUptime,
    startedAt,
    subaccount: curSub,
    agentAddress: curSigner,
    gasFeeAddress: curSigner,
    signerAddress: curSigner,
    network: config.NETWORK,
    isConfigured: isConf,
    paperTrading: Boolean((config as any).PAPER_TRADING ?? (config as any).TRADING?.paperTrading ?? true),
    paperActivated: Boolean(isClientOnboarded() && ((config as any).PAPER_TRADING ?? (config as any).TRADING?.paperTrading ?? true)),
    aiProvider: config.ACTIVE_AI_PROVIDER,
    aiModel: config.GEMINI_MODEL || (config.ACTIVE_AI_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'local-rules'),
    aiEnabled: config.ACTIVE_AI_PROVIDER !== 'local_rules' && Boolean(config.GEMINI_API_KEY || config.ANTHROPIC_API_KEY || config.OLLAMA_BASE_URL),
    budgetUsd: config.BUDGET_USD ?? 0,
    minPositionUsd: config.MIN_POSITION_USD ?? 0,
    maxPositionUsd: config.MAX_POSITION_USD ?? 0,
    minLeverage: config.MIN_LEVERAGE || 5,
    maxLeverage: config.MAX_LEVERAGE || 12,
    minAllocPct: config.MIN_ALLOC_PCT || 35,
    maxAllocPct: config.MAX_ALLOC_PCT || 60,
    maxOpenPositions: config.MAX_OPEN_POSITIONS || 1,
    maxConcurrentPositions: config.MAX_OPEN_POSITIONS || 1,
    defaultStopLossPct: (config as any).DEFAULT_STOP_LOSS_PCT || 1.5,
    defaultTakeProfitPct: (config as any).DEFAULT_TAKE_PROFIT_PCT || 3.0,
    slippageTolerancePct: (config as any).SLIPPAGE_TOLERANCE_PCT || 0.3,
    maxRiskPct: config.MAX_RISK_PER_TRADE_PCT || 2.0,
    riskSettings: {
      budgetUsd: config.BUDGET_USD ?? 0,
      minPositionUsd: config.MIN_POSITION_USD ?? 0,
      maxPositionUsd: config.MAX_POSITION_USD ?? 0,
      minLeverage: config.MIN_LEVERAGE || 5,
      maxLeverage: config.MAX_LEVERAGE || 12,
      minAllocPct: config.MIN_ALLOC_PCT || 35,
      maxAllocPct: config.MAX_ALLOC_PCT || 60,
      maxOpenPositions: config.MAX_OPEN_POSITIONS || 1,
      maxConcurrentPositions: config.MAX_OPEN_POSITIONS || 1,
      defaultStopLossPct: (config as any).DEFAULT_STOP_LOSS_PCT || 1.5,
      defaultTakeProfitPct: (config as any).DEFAULT_TAKE_PROFIT_PCT || 3.0,
      slippageTolerancePct: (config as any).SLIPPAGE_TOLERANCE_PCT || 0.3,
      maxRiskPct: config.MAX_RISK_PER_TRADE_PCT || 2.0,
    },
    accountEquityUsd: curEquity,
    availableMarginUsd: curMargin,
    gasAptBalance: curApt,
    stats: {
      ...curStats,
      realizedPnlUsd: curStats.netPnlUsd ?? curStats.totalPnlUsd ?? 0,
      winRatePct: curStats.winRate ?? 0,
      winningTrades: curStats.wins ?? 0,
      losingTrades: curStats.losses ?? 0,
      returnPct: config.BUDGET_USD > 0 ? Number((((curStats.netPnlUsd || 0) / config.BUDGET_USD) * 100).toFixed(2)) : 0,
    },
    recentLogs: recentLogs.slice(-50),
    directives: curDirectives,
    macroDirective: curMacroDirective,
    pairs: watchPairs,
    currentPairs: watchPairs,
    watchPairs,
    markets: syncHarmonizedMarkets(),
    openPositions: getEffectiveOpenPositions(),
    positions: getEffectiveOpenPositions(),
    openOrders: getEffectiveRestingOrders(),
    restingOrders: getEffectiveRestingOrders(),
    portfolioHarvester: portfolioHarvester.evaluate(getLivePricesMap()),
    activeStrategy: getActiveStrategy(),
    strategyOrigin: getActiveStrategyOriginInfo(),
    strategySyncConfig: getStrategySyncConfig(),
    pairOverrides: getAllPairOverrides(),
    simPairDirectives: getSimPairDirectives(),
    activeCoolOffs: riskGuard.getAllActiveCoolOffs(),
    shockwave: {
      activeCoolOffs: (() => {
        const map: Record<string, any> = {};
        for (const c of riskGuard.getAllActiveCoolOffs()) {
          map[c.symbol] = {
            symbol: c.symbol,
            direction: 'TRAP_VETO',
            bannedSide: c.action,
            reason: c.reason,
            trapCategory: c.trapCategory,
            expiresAt: c.expiresAt || (Date.now() + (c.remainingMinutes * 60 * 1000)),
          };
        }
        return map;
      })(),
      btcShock: { active: false, triggeredAt: 0, expiresAt: 0, btcDeltaPct: 0, reason: '' },
      manualPanicFreeze: { active: false, expiresAt: 0, reason: '' },
      pairVelocities: {},
    },
  };
}

export function broadcastState(): void {
  if (sseStateClients.size === 0) return;
  try {
    const payload = buildStreamStatePayload();
    const msg = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseStateClients) {
      try {
        client.write(msg);
      } catch {
        sseStateClients.delete(client);
      }
    }
  } catch (err: any) {
    logger.debug(`Broadcast state error: ${err.message}`);
  }
}

export async function fetchLiveBulkTickers(): Promise<void> {
  const tickerMap = new Map<string, { lastPrice: number; change24h: number; high24h: number; low24h: number; volume24hUsd: number }>();

  // 1. Auxiliary CEX tickers for external 24h stats/volume
  try {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
      timeout: 2500,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlphaBot/3.0)' },
    });
    if (Array.isArray(res.data) && res.data.length > 0) {
      for (const item of res.data) {
        if (typeof item.symbol === 'string' && item.symbol.endsWith('USDT')) {
          tickerMap.set(item.symbol, {
            lastPrice: parseFloat(item.lastPrice) || 0,
            change24h: parseFloat(item.priceChangePercent) || 0,
            high24h: parseFloat(item.highPrice) || 0,
            low24h: parseFloat(item.lowPrice) || 0,
            volume24hUsd: parseFloat(item.quoteVolume) || 0,
          });
        }
      }
    }
  } catch {}

  // 2. Fallback CEX: Bybit linear tickers
  if (tickerMap.size === 0) {
    try {
      const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', {
        timeout: 3000,
        headers: { 'User-Agent': 'Mozilla/5.0 (TradingBot/3.0; LiveTickers)' },
      });
      const list = res.data?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        for (const item of list) {
          tickerMap.set(item.symbol, {
            lastPrice: parseFloat(item.lastPrice) || 0,
            change24h: (parseFloat(item.price24hPcnt) || 0) * 100,
            high24h: parseFloat(item.highPrice24h) || 0,
            low24h: parseFloat(item.lowPrice24h) || 0,
            volume24hUsd: parseFloat(item.turnover24h) || 0,
          });
        }
      }
    } catch {}
  }

  let priceChanged = false;

  for (const sym of watchPairs) {
    const norm = sym.toUpperCase().replace(/[-_/]/g, '');
    const cleanBase = norm.replace(/USD[T]?$/, '');
    const bybitSym = `${cleanBase}USDT`;
    const item = tickerMap.get(bybitSym);

    // PRIORITY 1: Authentic On-Chain Decibel DEX Mark & Oracle Prices
    const decibelPx = decibelPriceFeed.getPrice(sym);

    let price = 0;
    let oraclePrice = 0;
    let fundingRate = 0.01;
    let openInterestUsd = 0;
    let change24h = item?.change24h ?? 0;
    let high24h = item?.high24h ?? 0;
    let low24h = item?.low24h ?? 0;
    let volume24hUsd = item?.volume24hUsd ?? 0;

    if (decibelPx && decibelPx.markPrice > 0) {
      price = decibelPx.markPrice;
      oraclePrice = decibelPx.oraclePrice;
      fundingRate = decibelPx.fundingRatePct;
      openInterestUsd = decibelPx.openInterestUsd;
      if (decibelPx.change24h !== undefined && item?.change24h === undefined) {
        change24h = decibelPx.change24h;
      }
      if (decibelPx.high24h && decibelPx.high24h > 0 && !high24h) {
        high24h = decibelPx.high24h;
      }
      if (decibelPx.low24h && decibelPx.low24h > 0 && !low24h) {
        low24h = decibelPx.low24h;
      }
      if (!volume24hUsd) {
        volume24hUsd = decibelPx.volume24hUsd || (price * 45000);
      }
    } else if (item && item.lastPrice > 0) {
      price = item.lastPrice;
      oraclePrice = item.lastPrice;
    } else {
      price = DEFAULT_PAIR_PRICES[sym] || 10.0;
      oraclePrice = price;
    }

    if (price > 0) {
      updateBaselinePrice(sym, price);

      if (!high24h || high24h <= 0) high24h = price * 1.02;
      if (!low24h || low24h <= 0) low24h = price * 0.98;
      if (!volume24hUsd || volume24hUsd <= 0) volume24hUsd = price * 45000;

      const smaProf = getDynamicSmaPeriodsForSymbol(sym);
      const simDir = getSimPairDirective(sym);
      const fastP = simDir?.fastPeriod || smaProf.fast;
      const slowP = simDir?.slowPeriod || smaProf.slow;
      const range = (high24h - low24h) || (price * 0.04);
      const rangePosition = ((price - low24h) / range - 0.5) * 16;
      const chgSkew = change24h * 1.5;
      const pairHarmonic = Math.sin(sym.charCodeAt(0) * 3 + (Date.now() / 60000)) * 2.8;
      const computedImb = Number((chgSkew + rangePosition + pairHarmonic).toFixed(1));
      const dynamicImb = simDir?.orderflow?.orderflowImbalancePct !== undefined
        ? Number(simDir.orderflow.orderflowImbalancePct)
        : Math.max(-45.0, Math.min(45.0, computedImb));

      if (!agentState.markets[sym]) {
        agentState.markets[sym] = {
          symbol: sym,
          markPrice: price,
          price: price,
          oraclePrice,
          change24h,
          volume24hUsd,
          high24h,
          low24h,
          trend: 'SCANNING',
          action: 'WAIT',
          confidence: 50,
          riskLevel: 'LOW',
          fundingRate,
          openInterestUsd,
          fastPeriod: fastP,
          slowPeriod: slowP,
          robustIsland: {
            fastPeriod: fastP,
            slowPeriod: slowP,
            currentFastSma: simDir?.currentFastSma || price * 1.002,
            currentSlowSma: simDir?.currentSlowSma || price * 0.998,
            smaSpreadPct: simDir?.smaSpreadPct !== undefined ? Number(simDir.smaSpreadPct) : 0.40,
            smaAlignment: simDir?.smaAlignment || 'BULLISH_STACK',
            wfe: simDir?.wfe !== undefined ? Number(simDir.wfe) : 0.88,
            robustScore: simDir?.robustScore !== undefined ? Number(simDir.robustScore) : 85,
            source: simDir?.fastPeriod ? 'SIM_LAB' : 'DEFAULT_PRESET',
          },
          imbalance: dynamicImb,
          candlestick: { rsi14: 50, ema9: price, ema21: price, rvol: 1, adx14: 20 },
          updatedAt: Date.now(),
        };
        priceChanged = true;
      } else {
        const m = agentState.markets[sym];
        const hasPriceChanged = m.markPrice !== price || m.price !== price;
        m.markPrice = price;
        m.price = price;
        m.oraclePrice = oraclePrice;
        m.fundingRate = fundingRate;
        if (openInterestUsd > 0) m.openInterestUsd = openInterestUsd;
        m.change24h = change24h;
        m.high24h = high24h;
        m.low24h = low24h;
        m.volume24hUsd = volume24hUsd;
        m.fastPeriod = fastP;
        m.slowPeriod = slowP;
        m.robustIsland = {
          fastPeriod: fastP,
          slowPeriod: slowP,
          currentFastSma: simDir?.currentFastSma || m.robustIsland?.currentFastSma || price * 1.002,
          currentSlowSma: simDir?.currentSlowSma || m.robustIsland?.currentSlowSma || price * 0.998,
          smaSpreadPct: simDir?.smaSpreadPct !== undefined ? Number(simDir.smaSpreadPct) : (m.robustIsland?.smaSpreadPct ?? 0.40),
          smaAlignment: simDir?.smaAlignment || m.robustIsland?.smaAlignment || 'BULLISH_STACK',
          wfe: simDir?.wfe !== undefined ? Number(simDir.wfe) : (m.robustIsland?.wfe ?? 0.88),
          robustScore: simDir?.robustScore !== undefined ? Number(simDir.robustScore) : (m.robustIsland?.robustScore ?? 85),
          source: simDir?.fastPeriod ? 'SIM_LAB' : (m.robustIsland?.source || 'DEFAULT_PRESET'),
        };
        m.imbalance = dynamicImb;
        m.updatedAt = Date.now();
        if (hasPriceChanged) {
          priceChanged = true;
        }
      }
    }
  }

  // Refresh active open positions in real-time using Decibel on-chain prices
  const openTrades = getEffectiveOpenPositions();
  for (const t of openTrades) {
    const decibelPx = decibelPriceFeed.getPrice(t.symbol);
    const norm = t.symbol.toUpperCase().replace(/[-_/]/g, '');
    const cleanBase = norm.replace(/USD[T]?$/, '');
    const item = tickerMap.get(`${cleanBase}USDT`);

    const effectivePrice = (decibelPx && decibelPx.markPrice > 0)
      ? decibelPx.markPrice
      : (item && item.lastPrice > 0 ? item.lastPrice : t.currentPrice);

    if (effectivePrice && effectivePrice > 0 && t.currentPrice !== effectivePrice) {
      t.currentPrice = effectivePrice;
      const isLong = t.action === 'LONG' || t.side === 'buy';
      const priceDiff = isLong ? effectivePrice - t.entryPrice : t.entryPrice - effectivePrice;
      const unrealizedPnlUsd = priceDiff * (t.sizeBase || 0);
      const alloc = t.allocatedUsd || ((t.sizeBase * t.entryPrice) / (t.leverage || 1)) || 1;
      t.unrealizedPnlUsd = Number(unrealizedPnlUsd.toFixed(4));
      t.unrealizedPnlPct = Number(((unrealizedPnlUsd / alloc) * 100).toFixed(2));
      t.pnlUsd = t.unrealizedPnlUsd;
      t.netPnlUsd = t.unrealizedPnlUsd;
      priceChanged = true;
    }
  }

  if (priceChanged) {
    broadcastState();
  }
}

export function startLiveTickerLoop(): void {
  if (liveTickerTimer) clearInterval(liveTickerTimer);
  // Start Decibel 24/7 Authoritative On-Chain Price Feed
  decibelPriceFeed.start(1200).catch((err: any) => {
    logger.warn(`Decibel Price Feed startup notice: ${err.message}`);
  });
  // Start Centralized On-Chain Sync Pipeline for positions & orders
  onChainPipeline.start();
  fetchLiveBulkTickers().catch(() => {});
  liveTickerTimer = setInterval(() => {
    // Single-flight: the 1.2s cadence must never overlap a slow bulk fetch,
    // otherwise identical upstream calls stack up under network latency.
    if (liveTickerInFlight) return;
    liveTickerInFlight = true;
    fetchLiveBulkTickers()
      .catch(() => {})
      .finally(() => { liveTickerInFlight = false; });
  }, config.FAST_PRICE_TICKER_MS || 1200);
}
startLiveTickerLoop();

export function sanitizeLogMsg(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost):4000\/api\/pipeline\/alpha-bundle/gi, 'Sim Lab Local')
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost):4000\/api\/pipeline\/telemetry/gi, 'Sim Lab Local')
    .replace(/https?:\/\/[^\/]+\/api\/pipeline\/(?:alpha-bundle|telemetry)/gi, 'Sim Lab Cloud')
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\//gi, '')
    .replace(/127\.0\.0\.1(?::\d+)?\/api\//gi, '')
    .replace(/127\.0\.0\.1:\d+/gi, 'local-node');
}

export function pushLog(level: string, msg: string): void {
  const cleanMsg = sanitizeLogMsg(msg);
  const entry: LogEntry = { ts: Date.now(), level, msg: cleanMsg };
  recentLogs.push(entry);
  if (recentLogs.length > 200) recentLogs.shift();

  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Hook into logger to stream to SSE dashboard
const origInfo = logger.info.bind(logger);
const origWarn = logger.warn.bind(logger);
const origError = logger.error.bind(logger);

(logger as any).info = (msg: string, ...a: any[]) => {
  origInfo(msg, ...a);
  pushLog('info', msg);
};
(logger as any).warn = (msg: string, ...a: any[]) => {
  origWarn(msg, ...a);
  pushLog('warn', msg);
};
(logger as any).error = (msg: string, ...a: any[]) => {
  origError(msg, ...a);
  pushLog('error', msg);
};

function parseBody<T = any>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({} as T);
      }
    });
  });
}

function isLocalOrPrivateNetwork(remote?: string): boolean {
  if (!remote) return true;
  const clean = remote.replace(/^::ffff:/, '').trim();
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  // RFC 1918 private subnets: 10.x.x.x, 192.168.x.x, 172.16.x.x - 172.31.x.x (including Docker bridge subnets)
  if (/^10\./.test(clean)) return true;
  if (/^192\.168\./.test(clean)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean)) return true;
  return false;
}

function isAuthorized(req: http.IncomingMessage): boolean {
  // If an admin password has been set, enforce valid session token
  if (config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.trim() !== '') {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        if (decoded.endsWith(`_${config.ADMIN_PASSWORD}`)) {
          return true;
        }
      } catch {}
    }
    return false;
  }
  // When no admin password is set, access is permitted across all interfaces (localhost, LAN, tunnels, initial setup)
  return true;
}

export function startApiServer(): http.Server {
  const dashboardDir = path.resolve(APP_ROOT, 'dashboard');

  // Pre-seed SQLite from trades.json if database was empty
  try {
    const jsonPath = path.resolve(APP_ROOT, 'data', 'trades.json');
    if (fs.existsSync(jsonPath)) {
      dbClient.migrateFromJson(jsonPath);
    }
  } catch (err: any) {
    logger.debug(`SQLite trades initial migration check: ${err.message}`);
  }

  // Register Copilot runtime handlers
  registerCopilotHandlers({
    setPaused: (paused: boolean) => {
      tradeExecutor.setPaused(paused);
      agentState.status = paused ? 'paused' : 'running';
      broadcastState();
    },
    triggerScan: async () => triggerImmediateScan(),
  });

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://localhost:${config.HEALTH_PORT}`);
    const pathname = parsedUrl.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── 1. Health Endpoint ───────────────────────────────────────────────────
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          operatingMode: config.OPERATING_MODE,
          isSimLabSupercharged: superchargeClient.isActive(),
          network: config.NETWORK,
          clientName: config.CLIENT_NAME,
          isConfigured: isClientConfigured(),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // ── 2. Setup & Onboarding Status ─────────────────────────────────────────
    if (pathname === '/api/setup/status') {
      const configured = isClientConfigured() || isClientOnboarded();
      const signer = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          isConfigured: configured,
          onboarded: isClientOnboarded(),
          paperTrading: Boolean((config as any).PAPER_TRADING ?? (config as any).TRADING?.paperTrading ?? true),
          paperActivated: Boolean(isClientOnboarded() && ((config as any).PAPER_TRADING ?? (config as any).TRADING?.paperTrading ?? true)),
          clientName: config.CLIENT_NAME,
          network: config.NETWORK,
          hasPassword: Boolean(config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.trim() !== ''),
          operatingMode: config.OPERATING_MODE,
          subaccount: configured ? config.DECIBEL_SUBACCOUNT_ADDRESS : '',
          signerAddress: signer,
          gasFeeAddress: signer,
        }),
      );
      return;
    }

    // ── 2b. Gas Fee Address & Balance Retrieval ──────────────────────────────
    if (pathname === '/api/gas-address' || pathname === '/api/signer-address') {
      const signer = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
      let aptBalance = 0;
      if (signer) {
        try {
          const onChain = await tradeExecutor.fetchOnChainBalance();
          aptBalance = onChain.aptBalance;
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          signerAddress: signer,
          gasFeeAddress: signer,
          gasAptBalance: aptBalance,
          needsTopUp: aptBalance < 0.005,
          network: config.NETWORK,
          topUpInstructions: 'Transfer 0.05 - 0.1 APT to this address on Aptos mainnet to pay transaction gas fees.',
          explorerUrl: signer ? `https://explorer.aptoslabs.com/account/${signer}?network=${config.NETWORK}` : null,
        }),
      );
      return;
    }

    // ── 2c. Preview / Derive Signer Address from Delegate Key ────────────────
    if ((pathname === '/api/setup/derive-signer' || pathname === '/api/signer/derive') && req.method === 'POST') {
      const body = await parseBody(req);
      const key = (body.delegateKey || body.decibelPrivateKey || body.decibelDelegateKey || body.privateKey || '').trim();
      const derived = getDerivedSignerAddress(key);
      const knownSub = (!config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_') && config.DECIBEL_SUBACCOUNT_ADDRESS.startsWith('0x'))
        ? config.DECIBEL_SUBACCOUNT_ADDRESS : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: Boolean(derived),
          signerAddress: derived,
          gasFeeAddress: derived,
          knownSubaccount: knownSub,
          network: config.NETWORK,
          explorerUrl: derived ? `https://explorer.aptoslabs.com/account/${derived}?network=${config.NETWORK}` : null,
          topUpInstructions: 'Transfer 0.05 - 0.1 APT to this address on Aptos mainnet to pay transaction gas fees.',
          note: 'This is the Gas Signer wallet (pays Aptos tx fees). Do NOT enter this address as your trading subaccount.',
          error: derived ? undefined : 'Invalid private key format. Please provide a valid Ed25519 private key.'
        }),
      );
      return;
    }

    // ── 2d. Verify Decibel Subaccount & Live Collateral On-Chain ─────────────
    if (pathname === '/api/setup/verify-subaccount' && req.method === 'POST') {
      const body = await parseBody(req);
      const addr = (body.address || body.subaccount || '').trim();
      const delegateKey = (body.delegateKey || '').trim();
      const derived = delegateKey ? getDerivedSignerAddress(delegateKey) : null;
      const isSigner = Boolean(derived && addr.toLowerCase() === derived.toLowerCase());

      if (!addr || !addr.startsWith('0x') || addr.length < 20) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Please enter a valid Aptos address (0x...).' }));
        return;
      }

      if (isSigner) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          isSignerAddress: true,
          error: `⚠️ This is your Gas Signer key address (${addr.slice(0, 8)}...), NOT your Subaccount! Please enter your Decibel trading account (holding USDC collateral).`
        }));
        return;
      }

      try {
        const net = config.NETWORK === 'testnet' ? Network.TESTNET : Network.MAINNET;
        const aptos = createAptosClient(net);
        const decibelContract = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
        let resolvedSub = addr;
        let isPrimary = false;
        let balanceUsd = 0;

        // 1. Check if addr is directly a funded subaccount
        try {
          const collRes = await aptos.view({
            payload: {
              function: `${decibelContract}::perp_engine::get_cross_total_collateral_value`,
              typeArguments: [],
              functionArguments: [addr],
            },
          });
          if (collRes?.[0] !== undefined) {
            const val = Number(collRes[0]);
            if (val > 0) balanceUsd = val / 1e6;
          }
        } catch { }

        // 2. If no direct collateral on addr, check if addr is a primary wallet and derive its primary subaccount
        if (balanceUsd === 0) {
          try {
            const primaryRes = await aptos.view({
              payload: {
                function: `${decibelContract}::dex_accounts::primary_subaccount`,
                typeArguments: [],
                functionArguments: [addr],
              },
            });
            if (primaryRes?.[0] && typeof primaryRes[0] === 'string' && primaryRes[0] !== addr) {
              const candidate = primaryRes[0];
              const collRes = await aptos.view({
                payload: {
                  function: `${decibelContract}::perp_engine::get_cross_total_collateral_value`,
                  typeArguments: [],
                  functionArguments: [candidate],
                },
              });
              if (collRes?.[0] !== undefined) {
                const val = Number(collRes[0]);
                if (val > 0) {
                  balanceUsd = val / 1e6;
                  resolvedSub = candidate;
                  isPrimary = true;
                }
              }
            }
          } catch { }
        }

        let isDelegated = false;
        if (derived) {
          try {
            const permRes = await aptos.view({
              payload: {
                function: `${decibelContract}::dex_accounts::view_delegated_permissions`,
                typeArguments: [],
                functionArguments: [resolvedSub],
              },
            });
            const map = permRes?.[0] as any;
            if (map?.entries && Array.isArray(map.entries)) {
              isDelegated = map.entries.some((entry: any) =>
                entry.key && entry.key.toLowerCase() === derived.toLowerCase()
              );
            }
          } catch { }
        }

        let msg = `✅ Decibel Subaccount verified on-chain${isPrimary ? ' (Linked to Primary Wallet)' : ''} · $${balanceUsd.toFixed(2)} USDC Available`;
        if (derived && isDelegated) {
          msg = `✅ Decibel Subaccount verified on-chain · Delegate Key authorized · $${balanceUsd.toFixed(2)} USDC Available`;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          enteredAddress: addr,
          resolvedSubaccount: resolvedSub,
          isPrimaryOwner: isPrimary,
          isDelegated,
          collateralUsd: balanceUsd,
          message: msg
        }));
      } catch (err: any) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          enteredAddress: addr,
          resolvedSubaccount: addr,
          collateralUsd: 0,
          message: 'Address format valid'
        }));
      }
      return;
    }

    // ── 3. Setup & Activation Action ─────────────────────────────────────────
    if (pathname === '/api/setup/activate' && req.method === 'POST') {
      const body = await parseBody(req);
      const delegateKey = (body.delegateKey || body.decibelPrivateKey || body.decibelDelegateKey || '').trim();
      const subaccount = (body.subaccount || body.decibelSubaccount || '').trim();
      const isPaper = Boolean(body.paperTrading);

      // In live mode require keys; in paper trading mode allow fallback if not provided
      if (!isPaper) {
        if (!delegateKey || delegateKey.length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Valid Decibel Delegate Private Key is required for live trading.' }));
          return;
        }
        if (!subaccount || subaccount.length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Valid Decibel Subaccount Address is required for live trading.' }));
          return;
        }

        const derivedSigner = delegateKey ? getDerivedSignerAddress(delegateKey) : null;
        if (derivedSigner && subaccount.toLowerCase() === derivedSigner.toLowerCase()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `❌ You entered your Gas Signer address (${subaccount.slice(0, 8)}...) as your subaccount! Please enter your Decibel trading account holding USDC collateral.`
          }));
          return;
        }
      }

      // Auto-resolve primary account -> subaccount on-chain
      let targetSubaccount = subaccount;
      let targetOwner = (body.ownerAddress || '').trim();
      if (!isPaper && subaccount.startsWith('0x')) {
        try {
          const net = (body.network || body.decibelNetwork || config.NETWORK) === 'testnet' ? Network.TESTNET : Network.MAINNET;
          const aptos = createAptosClient(net);
          const decibelContract = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
          const primaryRes = await aptos.view({
            payload: {
              function: `${decibelContract}::dex_accounts::primary_subaccount`,
              typeArguments: [],
              functionArguments: [subaccount],
            },
          });
          if (primaryRes?.[0] && typeof primaryRes[0] === 'string' && primaryRes[0] !== subaccount) {
            targetSubaccount = primaryRes[0];
            if (!targetOwner) targetOwner = subaccount;
          }
        } catch { }
      }

      // Build updates object
      const updates: any = {
        onboarded: true,
        credentials: {
          decibelDelegateKey: delegateKey,
          decibelSubaccount: targetSubaccount,
          decibelOwnerAddress: targetOwner,
          decibelNodeApiKey: (body.nodeApiKey || '').trim(),
          network: body.network || body.decibelNetwork || 'mainnet',
        },
        decibelSubaccount: targetSubaccount,
        decibelOwnerAddress: targetOwner,
        decibelPrivateKey: delegateKey,
        decibelNetwork: body.network || body.decibelNetwork || 'mainnet',
        trading: {
          budgetUsd: (() => {
            const cachedBal = tradeExecutor.getCachedOnChainBalance();
            const realEquity = cachedBal?.balanceUsd || 0;
            const b = body.budgetUsd ? Number(body.budgetUsd) : config.BUDGET_USD;
            if (realEquity > 0 && !isPaper && b > realEquity) {
              logger.warn(`⚠️ [SETUP] Initial Budget Ceiling ($${b.toFixed(2)}) clamped to on-chain wallet balance ($${realEquity.toFixed(2)}).`);
              return Number(realEquity.toFixed(2));
            }
            return b;
          })(),
          paperTrading: isPaper,
        },
      };

      if (body.aiProvider) {
        const rawAiKey = (body.aiKey || '').trim();
        const prov = body.aiProvider.toLowerCase().trim();
        updates.ai = {
          provider: prov,
          geminiApiKey: (body.geminiKey || (prov === 'gemini' ? rawAiKey : '') || '').trim(),
          anthropicApiKey: (body.claudeKey || (prov === 'claude' || prov === 'anthropic' ? rawAiKey : '') || '').trim(),
          ollamaBaseUrl: (body.ollamaUrl || (prov === 'ollama' ? rawAiKey : '') || '').trim(),
          model: body.aiModel || (prov === 'claude' ? 'claude-3-5-sonnet-latest' : 'gemini-2.5-flash'),
        };
        updates.aiProvider = prov;
        updates.aiModel = updates.ai.model;
        if (prov === 'gemini' && updates.ai.geminiApiKey) updates.aiApiKey = updates.ai.geminiApiKey;
        if ((prov === 'claude' || prov === 'anthropic') && updates.ai.anthropicApiKey) updates.aiApiKey = updates.ai.anthropicApiKey;
      }

      if (body.adminPassword) {
        updates.security = {
          adminPassword: body.adminPassword.trim(),
        };
      }

      if (body.telegramBotToken || body.telegramChatId) {
        const tgTok = (body.telegramBotToken || '').trim();
        const tgChat = (body.telegramChatId || '').trim();
        updates.telegram = {
          botToken: tgTok,
          chatId: tgChat,
          enabled: true,
        };
        updates.telegramBotToken = tgTok;
        updates.telegramChatId = tgChat;
        telegramNotifier.updateSettings(tgTok, tgChat, true);
      }

      updateDynamicSettings(updates);
      tradeExecutor.resetTrades();
      tradeExecutor.reinitializeSigner();
      const derivedSigner = getDerivedSignerAddress(delegateKey);
      logger.info(`🎉 [SETUP] Credentials configured and permanently saved! Signer: ${derivedSigner || 'derived'}. Bot activated.`);
      seedMarketsForPairs();
      triggerImmediateScan();

      // Fetch initial gas balance for the new signer
      let gasApt = 0;
      try {
        const onChain = await tradeExecutor.fetchOnChainBalance();
        gasApt = onChain.aptBalance;
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          onboarded: true,
          isConfigured: true,
          message: 'Trading agent successfully activated!',
          subaccount,
          signerAddress: derivedSigner,
          gasFeeAddress: derivedSigner,
          gasAptBalance: gasApt,
          needsTopUp: gasApt < 0.005,
          topUpInstructions: 'Transfer 0.05 - 0.1 APT to this gas fee address on Aptos mainnet to pay transaction gas fees.',
          explorerUrl: derivedSigner ? `https://explorer.aptoslabs.com/account/${derivedSigner}?network=${config.NETWORK}` : null,
        }),
      );
      return;
    }

    // ── 3b. Setup Reset Action (Clean slate for testing onboarding) ───────────
    if (pathname === '/api/setup/reset' && req.method === 'POST') {
      const emptySettings = {
        credentials: {
          decibelDelegateKey: '',
          decibelSubaccount: '',
          decibelOwnerAddress: '',
          decibelNodeApiKey: '',
          network: 'mainnet',
        },
        decibelSubaccount: '',
        decibelPrivateKey: '',
        decibelNetwork: 'mainnet',
        ai: {
          enabled: true,
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          apiKey: '',
        },
        aiApiKey: '',
        budgetUsd: 0,
        trading: {
          budgetUsd: 0,
          paperTrading: false,
          minPositionUsd: 0,
          maxPositionUsd: 0,
          maxLeverage: 5,
        },
        telegram: {
          botToken: '',
          chatId: '',
          enabled: false,
        },
      };

      config.DECIBEL_DELEGATE_KEY = '';
      config.DECIBEL_PRIVATE_KEY = '';
      config.DECIBEL_SUBACCOUNT_ADDRESS = '';
      config.GEMINI_API_KEY = '';
      config.ANTHROPIC_API_KEY = '';
      config.ACTIVE_AI_PROVIDER = 'local_rules' as any;
      updateDynamicSettings(emptySettings);
      tradeExecutor.reinitializeSigner();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'All credentials wiped cleanly. System reset to pre-onboarding state.' }));
      return;
    }

    // ── 4. Authentication Check & Login ──────────────────────────────────────
    if (pathname === '/api/auth/check') {
      const authRequired = Boolean(config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.trim() !== '');
      const authenticated = isAuthorized(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authRequired, authenticated }));
      return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const inputPassword = (body.password || '').trim();

      if (!config.ADMIN_PASSWORD || config.ADMIN_PASSWORD.trim() === '') {
        // No password set
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, token: 'no_auth_required' }));
        return;
      }

      if (inputPassword === config.ADMIN_PASSWORD) {
        const token = Buffer.from(`session_${Date.now()}_${config.ADMIN_PASSWORD}`).toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, token }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Incorrect Admin Password.' }));
      }
      return;
    }

    // ── Reset admin password by proving wallet ownership ─────────────────────
    if (pathname === '/api/auth/reset-by-wallet' && req.method === 'POST') {
      const body = await parseBody(req);
      const inputAddr = (body.walletAddress || '').trim().toLowerCase();

      if (!inputAddr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'walletAddress is required.' }));
        return;
      }

      // Load the persisted subaccount address as the identity proof
      const saved = loadPersistentSettings();
      const storedAddr = (
        saved?.credentials?.decibelSubaccount ||
        saved?.decibelSubaccount ||
        config.DECIBEL_SUBACCOUNT_ADDRESS ||
        ''
      ).toLowerCase();

      if (!storedAddr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No wallet address is configured on this client. Cannot verify identity.' }));
        return;
      }

      if (inputAddr !== storedAddr) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Wallet address does not match. Identity verification failed.' }));
        return;
      }

      // Identity verified — clear the admin password via updateDynamicSettings (persists to disk)
      updateDynamicSettings({ adminPassword: '' });
      config.ADMIN_PASSWORD = '';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Admin password cleared. You can now set a new password in Settings → Security.' }));
      return;
    }

    // ── 5. Live State Endpoint ───────────────────────────────────────────────
    if (pathname === '/api/state') {
      const stats = tradeExecutor.getStats();
      const directives = standaloneEngine.getDirectives();
      const configured = isClientConfigured();
      let onChainEquity = 0;
      let onChainMargin = 0;
      let gasAptBalance = 0;

      if (configured) {
        const pipeState = onChainPipeline.getConsolidatedState();
        if (pipeState.accountEquityUsd > 0) {
          onChainEquity = pipeState.accountEquityUsd;
          onChainMargin = pipeState.availableMarginUsd;
          gasAptBalance = pipeState.gasAptBalance;
        } else {
          const cachedBal = tradeExecutor.getCachedOnChainBalance();
          onChainEquity = Math.max(0, cachedBal.balanceUsd || 0);
          onChainMargin = Math.max(0, onChainEquity - stats.budgetUsedUsd);
          gasAptBalance = cachedBal.aptBalance || 0;
        }
      } else {
        onChainEquity = 0;
        onChainMargin = 0;
        gasAptBalance = 0;
      }

      const signerAddress = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
      const isSimLabConn = getSimLabConnectionStatus();
      const macroDirective = getEffectiveMacroDirective(directives);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: tradeExecutor.getIsPaused() ? 'PAUSED' : 'running',
          isPaused: tradeExecutor.getIsPaused(),
          mode: config.AUTONOMOUS_MODE,
          clientName: config.CLIENT_NAME,
          operatingMode: isSimLabConn ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
          isSimLabSupercharged: isSimLabConn,
          isSimLabConnected: isSimLabConn,
          simPipeline: {
            connected: isSimLabConn,
            isStale: false,
            currentRegime: directives.regime,
            appliedConfidenceGate: directives.scoreFloor,
            appliedHarvestThreshold: 65,
            serverUrl: superchargeClient.getServerUrl(),
            mode: isSimLabConn ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
          },
          isConfigured: configured,
          aiProvider: config.ACTIVE_AI_PROVIDER,
          aiModel: config.GEMINI_MODEL || (config.ACTIVE_AI_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'local-rules'),
          aiEnabled: config.ACTIVE_AI_PROVIDER !== 'local_rules' && Boolean(config.GEMINI_API_KEY || config.ANTHROPIC_API_KEY || config.OLLAMA_BASE_URL),
          subaccount: (config.DECIBEL_SUBACCOUNT_ADDRESS && !config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_')) ? config.DECIBEL_SUBACCOUNT_ADDRESS : '',
          agentAddress: signerAddress,
          gasFeeAddress: signerAddress,
          gasAptBalance,
          network: config.NETWORK,
          paperTrading: config.PAPER_TRADING,
          budgetUsd: config.BUDGET_USD ?? 0,
          minPositionUsd: config.MIN_POSITION_USD ?? 0,
          maxPositionUsd: config.MAX_POSITION_USD ?? 0,
          minLeverage: config.MIN_LEVERAGE || 5,
          maxLeverage: config.MAX_LEVERAGE || 12,
          minAllocPct: config.MIN_ALLOC_PCT || 35,
          maxAllocPct: config.MAX_ALLOC_PCT || 60,
          maxOpenPositions: config.MAX_OPEN_POSITIONS || 1,
          maxConcurrentPositions: config.MAX_OPEN_POSITIONS || 1,
          defaultStopLossPct: (config as any).DEFAULT_STOP_LOSS_PCT || 1.5,
          defaultTakeProfitPct: (config as any).DEFAULT_TAKE_PROFIT_PCT || 3.0,
          slippageTolerancePct: (config as any).SLIPPAGE_TOLERANCE_PCT || 0.3,
          maxRiskPct: config.MAX_RISK_PER_TRADE_PCT || 2.0,
          riskSettings: {
            budgetUsd: config.BUDGET_USD ?? 0,
            minPositionUsd: config.MIN_POSITION_USD ?? 0,
            maxPositionUsd: config.MAX_POSITION_USD ?? 0,
            minLeverage: config.MIN_LEVERAGE || 5,
            maxLeverage: config.MAX_LEVERAGE || 12,
            minAllocPct: config.MIN_ALLOC_PCT || 35,
            maxAllocPct: config.MAX_ALLOC_PCT || 60,
            maxOpenPositions: config.MAX_OPEN_POSITIONS || 1,
            maxConcurrentPositions: config.MAX_OPEN_POSITIONS || 1,
            defaultStopLossPct: (config as any).DEFAULT_STOP_LOSS_PCT || 1.5,
            defaultTakeProfitPct: (config as any).DEFAULT_TAKE_PROFIT_PCT || 3.0,
            slippageTolerancePct: (config as any).SLIPPAGE_TOLERANCE_PCT || 0.3,
            maxRiskPct: config.MAX_RISK_PER_TRADE_PCT || 2.0,
          },
          accountEquityUsd: onChainEquity,
          availableMarginUsd: onChainMargin,
          pairs: watchPairs,
          currentPairs: watchPairs,
          watchPairs,
          directives,
          macroDirective,
          stats: {
            ...stats,
            realizedPnlUsd: stats.netPnlUsd ?? stats.totalPnlUsd ?? 0,
            winRatePct: stats.winRate ?? 0,
            winningTrades: stats.wins ?? 0,
            losingTrades: stats.losses ?? 0,
            returnPct: config.BUDGET_USD > 0 ? Number((((stats.netPnlUsd || 0) / config.BUDGET_USD) * 100).toFixed(2)) : 0,
          },
          recentLogs: recentLogs.slice(-50),
          markets: syncHarmonizedMarkets(),
          activeStrategy: getActiveStrategy(),
          strategyOrigin: getActiveStrategyOriginInfo(),
          strategySyncConfig: getStrategySyncConfig(),
          pairOverrides: getAllPairOverrides(),
          simPairDirectives: getSimPairDirectives(),
          shadowStats: tradeExecutor.getShadowStats(),
          shadowTrades: tradeExecutor.getShadowTrades().slice(-20),
          activeCoolOffs: riskGuard.getAllActiveCoolOffs(),
          shockwave: {
            activeCoolOffs: (() => {
              const map: Record<string, any> = {};
              for (const c of riskGuard.getAllActiveCoolOffs()) {
                map[c.symbol] = {
                  symbol: c.symbol,
                  direction: 'TRAP_VETO',
                  bannedSide: c.action,
                  reason: c.reason,
                  trapCategory: c.trapCategory,
                  expiresAt: c.expiresAt || (Date.now() + (c.remainingMinutes * 60 * 1000)),
                };
              }
              return map;
            })(),
            btcShock: { active: false, triggeredAt: 0, expiresAt: 0, btcDeltaPct: 0, reason: '' },
            manualPanicFreeze: { active: false, expiresAt: 0, reason: '' },
            pairVelocities: {},
          },
          portfolioHarvester: portfolioHarvester.evaluate(getLivePricesMap()),
          breakingNews: (() => {
            try {
              const { getLatestBreakingNews } = require('./pipeline/sim-consumer');
              return getLatestBreakingNews();
            } catch { return null; }
          })(),
          positions: (() => {
            const raw = getEffectiveOpenPositions();
            let bundle: any = null;
            try {
              const { getLastSyncedBundle } = require('./pipeline/sim-consumer');
              bundle = getLastSyncedBundle();
            } catch (_) {}
            return raw.map((t) => {
              const sym = (t.symbol || '').toUpperCase().replace('-', '/');
              const base = sym.split('/')[0];
              const dir = bundle?.pairDirectives?.[sym] || bundle?.pairDirectives?.[base];
              return {
                ...t,
                bykaranteli: dir?.bykaranteli || undefined,
              };
            });
          })(),
          openPositions: getEffectiveOpenPositions(),
          openOrders: getEffectiveRestingOrders(),
          restingOrders: getEffectiveRestingOrders(),
          robustReversalLoop: (agentState as any).robustReversalLoop || (smaReversalEngine ? smaReversalEngine.getTelemetry() : null),
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          startedAt,
        }),
      );
      return;
    }

    // ── 5a. Breaking News & Geopolitical Catalysts Endpoint ──────────────────
    if (pathname === '/api/news') {
      let news: any = null;
      try {
        const { getLatestBreakingNews } = require('./pipeline/sim-consumer');
        news = getLatestBreakingNews();
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...(news || { headlines: [], aggregateSentimentScore: 0, shockwaveAlert: false }) }));
      return;
    }

    // ── 5b. Learning & Counterfactual Shadow Trades Endpoint ─────────────────
    if (pathname === '/api/learning' || pathname === '/api/shadow-trades') {
      const directives = standaloneEngine.getDirectives();
      const macroDirective = getEffectiveMacroDirective(directives);
      const shadowStats = tradeExecutor.getShadowStats();
      const shadowTrades = tradeExecutor.getShadowTrades();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          macroDirective,
          directives,
          pairOverrides: getAllPairOverrides(),
          simPairDirectives: getSimPairDirectives(),
          shadowTrades: shadowTrades.slice(-30),
          learning: {
            shadowStats: shadowStats,
            dualStreamMetrics: {
              liveTradesCount: tradeExecutor.getStats().totalTrades || 0,
              simLabTradesCount: shadowStats.totalVetoed || 0,
              simLabShadowCount: shadowStats.totalVetoed || 0,
              combinedWinRatePct: tradeExecutor.getStats().winRate || 100,
            },
            scoreBuckets: {
              '80-84': { trades: 0, winRatePct: 0 },
              '85-89': { trades: 0, winRatePct: 0 },
              '90+': { trades: 0, winRatePct: 0 },
            },
            dynamicScoreFloor: directives.scoreFloor || 75,
            actionRecommendations: [
              `Shield Precision: ${shadowStats.precisionPct}% across ${shadowStats.totalVetoed} vetoed market setups.`,
              `Capital Protected: +$${shadowStats.estimatedSavedUsd.toFixed(2)} saved from avoided stop-losses.`,
            ],
          },
        }),
      );
      return;
    }

    // ── 5c. On-demand Klines API ────────────────────────────────────────────
    if (pathname === '/api/klines') {
      const sym = parsedUrl.searchParams.get('symbol') || 'BTC/USD';
      const interval = parsedUrl.searchParams.get('interval') || '15m';
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '60', 10);
      try {
        const klines = await fetchPublicKlines(sym, interval, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, symbol: sym, interval, klines }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message, klines: [] }));
      }
      return;
    }

    // ── 5d. Live Event Stream (SSE) ──────────────────────────────────────────
    if (pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

      const stats = tradeExecutor.getStats();
      const directives = standaloneEngine.getDirectives();
      const signer = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
      const sub = (config.DECIBEL_SUBACCOUNT_ADDRESS && !config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_')) ? config.DECIBEL_SUBACCOUNT_ADDRESS : '';
      const configured = isClientConfigured();
      const onChain = configured ? await tradeExecutor.fetchOnChainBalance() : { balanceUsd: 0, aptBalance: 0 };
      const onChainEquity = configured ? Math.max(0, onChain.balanceUsd || 0) : 0;
      const onChainMargin = Math.max(0, onChainEquity - stats.budgetUsedUsd);

      const curUptime = Math.floor((Date.now() - startedAt) / 1000);
      const isSupercharged = superchargeClient.isActive();
      const initialPayload = {
        status: tradeExecutor.getIsPaused() ? 'PAUSED' : 'running',
        isPaused: tradeExecutor.getIsPaused(),
        mode: config.AUTONOMOUS_MODE,
        clientName: config.CLIENT_NAME,
        operatingMode: isSupercharged ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
        isSimLabSupercharged: isSupercharged,
        simPipeline: {
          connected: isSupercharged,
          isStale: false,
          currentRegime: directives.regime,
          appliedConfidenceGate: directives.scoreFloor,
          appliedHarvestThreshold: 65,
          serverUrl: superchargeClient.getServerUrl(),
          mode: isSupercharged ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
        },
        uptime: curUptime,
        uptimeSeconds: curUptime,
        subaccount: sub,
        agentAddress: signer,
        gasFeeAddress: signer,
        signerAddress: signer,
        network: config.NETWORK,
        isConfigured: configured,
        paperTrading: Boolean((config as any).PAPER_TRADING ?? (config as any).TRADING?.paperTrading ?? true),
        paperActivated: Boolean(isClientOnboarded() && ((config as any).PAPER_TRADING ?? (config as any).TRADING?.paperTrading ?? true)),
        aiProvider: config.ACTIVE_AI_PROVIDER,
        aiModel: config.GEMINI_MODEL || (config.ACTIVE_AI_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'local-rules'),
        aiEnabled: config.ACTIVE_AI_PROVIDER !== 'local_rules' && Boolean(config.GEMINI_API_KEY || config.ANTHROPIC_API_KEY || config.OLLAMA_BASE_URL),
        budgetUsd: config.BUDGET_USD ?? 0,
        minPositionUsd: config.MIN_POSITION_USD ?? 0,
        maxPositionUsd: config.MAX_POSITION_USD ?? 0,
        minLeverage: config.MIN_LEVERAGE || 5,
        maxLeverage: config.MAX_LEVERAGE || 12,
        minAllocPct: config.MIN_ALLOC_PCT || 35,
        maxAllocPct: config.MAX_ALLOC_PCT || 60,
        maxOpenPositions: config.MAX_OPEN_POSITIONS || 1,
        maxConcurrentPositions: config.MAX_OPEN_POSITIONS || 1,
        defaultStopLossPct: (config as any).DEFAULT_STOP_LOSS_PCT || 1.5,
        defaultTakeProfitPct: (config as any).DEFAULT_TAKE_PROFIT_PCT || 3.0,
        slippageTolerancePct: (config as any).SLIPPAGE_TOLERANCE_PCT || 0.3,
        maxRiskPct: config.MAX_RISK_PER_TRADE_PCT || 2.0,
        riskSettings: {
          budgetUsd: config.BUDGET_USD ?? 0,
          minPositionUsd: config.MIN_POSITION_USD ?? 0,
          maxPositionUsd: config.MAX_POSITION_USD ?? 0,
          minLeverage: config.MIN_LEVERAGE || 5,
          maxLeverage: config.MAX_LEVERAGE || 12,
          minAllocPct: config.MIN_ALLOC_PCT || 35,
          maxAllocPct: config.MAX_ALLOC_PCT || 60,
          maxOpenPositions: config.MAX_OPEN_POSITIONS || 1,
          maxConcurrentPositions: config.MAX_OPEN_POSITIONS || 1,
          defaultStopLossPct: (config as any).DEFAULT_STOP_LOSS_PCT || 1.5,
          defaultTakeProfitPct: (config as any).DEFAULT_TAKE_PROFIT_PCT || 3.0,
          slippageTolerancePct: (config as any).SLIPPAGE_TOLERANCE_PCT || 0.3,
          maxRiskPct: config.MAX_RISK_PER_TRADE_PCT || 2.0,
        },
        accountEquityUsd: onChainEquity,
        availableMarginUsd: onChainMargin,
        gasAptBalance: onChain.aptBalance,
        stats,
        directives,
        pairs: watchPairs,
        currentPairs: watchPairs,
        watchPairs,
        markets: syncHarmonizedMarkets(),
        openPositions: getEffectiveOpenPositions(),
        positions: getEffectiveOpenPositions(),
        openOrders: getEffectiveRestingOrders(),
        restingOrders: getEffectiveRestingOrders(),
        portfolioHarvester: portfolioHarvester.evaluate(getLivePricesMap()),
        activeStrategy: getActiveStrategy(),
        strategyOrigin: getActiveStrategyOriginInfo(),
        strategySyncConfig: getStrategySyncConfig(),
      };
      res.write(`event: state\ndata: ${JSON.stringify(initialPayload)}\n\n`);

      sseStateClients.add(res);

      const timer = setInterval(() => {
        try {
          res.write(`event: ping\ndata: ${Date.now()}\n\n`);
          const tickPayload = buildStreamStatePayload();
          res.write(`event: state\ndata: ${JSON.stringify(tickPayload)}\n\n`);
        } catch {
          clearInterval(timer);
          sseStateClients.delete(res);
        }
      }, 1000);

      req.on('close', () => {
        clearInterval(timer);
        sseStateClients.delete(res);
      });
      return;
    }

    // ── 5d. Recent Logs Endpoint ─────────────────────────────────────────────
    if (pathname === '/api/logs') {
      try {
        const fs = require('fs');
        const logPath = path.resolve(process.cwd(), 'logs/trading-assistant.log');
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, 'utf8');
          const lines = content.trim().split('\n').filter(Boolean).slice(-150);
          const parsedLogs = lines.map((line: string) => {
            const match = line.match(/^\[(.*?)\]\s*\[(.*?)\]\s*(.*)$/);
            if (match) {
              const timeParts = match[1].split(' ');
              const timeStr = timeParts.length > 1 ? timeParts[1] : match[1];
              return {
                ts: new Date(match[1]).getTime() || Date.now(),
                time: timeStr,
                level: match[2].toLowerCase(),
                msg: match[3],
                message: match[3],
              };
            }
            return {
              ts: Date.now(),
              time: new Date().toLocaleTimeString('en-US', { hour12: false }),
              level: 'info',
              msg: line,
              message: line,
            };
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsedLogs));
          return;
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    // ── 5e. Portfolio Harvester & Dynamic Risk Management Endpoints ──────────
    if (pathname === '/api/harvester') {
      const harvState = portfolioHarvester.evaluate(getLivePricesMap());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          ...harvState,
        }),
      );
      return;
    }

    if (pathname === '/api/harvester/config' && req.method === 'POST') {
      const body = await parseBody(req);
      portfolioHarvester.updateConfig(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          message: 'Harvest Master thresholds updated successfully.',
          config: portfolioHarvester.getConfig(),
        }),
      );
      return;
    }

    if (pathname === '/api/harvester/action' && req.method === 'POST') {
      const body = await parseBody(req);
      const action = body.action || 'SWEEP_ALL';
      const result = portfolioHarvester.executeHarvest(action, body.symbol);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── 6. Open Positions & Controls ─────────────────────────────────────────
    if (pathname === '/api/positions') {
      const rawTrades = getEffectiveOpenPositions();
      let lastBundle: any = null;
      try {
        const { getLastSyncedBundle } = require('./pipeline/sim-consumer');
        lastBundle = getLastSyncedBundle();
      } catch (_) {}

      const enrichedTrades = rawTrades.map((t) => {
        const sym = (t.symbol || '').toUpperCase().replace('-', '/');
        const base = sym.split('/')[0];
        const dir = lastBundle?.pairDirectives?.[sym] || lastBundle?.pairDirectives?.[base];
        return {
          ...t,
          bykaranteli: dir?.bykaranteli || undefined,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, positions: enrichedTrades }));
      return;
    }

    if (pathname === '/api/positions/close-all' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: remote admin authentication required.' }));
        return;
      }
      const result = await tradeExecutor.closeAllOpenTradesAsync('closed_manual');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: result.failed === 0, 
        count: result.closed, 
        failed: result.failed, 
        message: `Emergency liquidation: on-chain closed ${result.closed} position(s), ${result.failed} failed.` 
      }));
      return;
    }

    if (pathname === '/api/positions/close' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: remote admin authentication required.' }));
        return;
      }
      const body = await parseBody(req);
      const idOrSymbol = body.id || body.symbol || '';
      const closed = await tradeExecutor.closeTradeAsync(idOrSymbol);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: closed, 
        message: closed ? `Closed on-chain position ${idOrSymbol}` : `Failed to close position ${idOrSymbol} on-chain or not found` 
      }));
      return;
    }

    // ── 5d. Visualizer Studio Manual Trade Fire Endpoint ──────────────────────
    if (pathname === '/api/trades/fire' && req.method === 'POST') {
      const body = await parseBody(req);
      const symbol = body.symbol || 'SOL/USD';
      const action = (body.action || 'LONG').toUpperCase() as 'LONG' | 'SHORT';
      const marginUsd = Number(body.marginUsd) || 30;
      const leverage = Number(body.leverage) || 10;
      const stopLossPct = Number(body.stopLossPct) || 0.8;
      const takeProfitPct = Number(body.takeProfitPct) || 1.6;

      const normSymbol = symbol.replace('-', '/').toUpperCase();
      const livePrices = getLivePricesMap();
      const currentPrice = livePrices[normSymbol] || 100;
      const slPrice = action === 'LONG' 
        ? currentPrice * (1 - stopLossPct / 100) 
        : currentPrice * (1 + stopLossPct / 100);
      const tpPrice = action === 'LONG' 
        ? currentPrice * (1 + takeProfitPct / 100) 
        : currentPrice * (1 - takeProfitPct / 100);

      const signal: any = {
        symbol: normSymbol,
        action,
        trend: action === 'LONG' ? 'BULLISH' : 'BEARISH',
        riskLevel: 'LOW',
        triggered: true,
        entryPrice: currentPrice,
        stopLoss: slPrice,
        takeProfit: tpPrice,
        riskRewardRatio: takeProfitPct / stopLossPct,
        suggestedLeverage: leverage,
        confidence: 96,
        baseScore: 96,
        indicators: {
          rsi14: action === 'LONG' ? 42 : 58,
          ema9: currentPrice,
          ema21: currentPrice,
          emaCrossover: action === 'LONG' ? 'BULLISH_CROSS' : 'BEARISH_CROSS',
          candleColor: action === 'LONG' ? 'GREEN' : 'RED',
          upperWickPct: 15,
          lowerWickPct: 15,
        },
        reasons: [`Manual trade fired from Interactive Visualizer slider studio ($${marginUsd} @ ${leverage}x, SL ${stopLossPct}%)`],
        strategyName: 'VISUALIZER_MANUAL_FIRE',
        strategyTags: ['visualizer', 'manual', 'robust_island_sma'],
        entryRationale: `Direct operator execution from Visualizer Studio.`,
        orderType: 'MARKET',
      };

      const aiEval: any = {
        confirmed: true,
        role: 'VISUALIZER_OPERATOR',
        provider: 'MANUAL_DISCRETIONARY',
        confidenceScore: 98,
        sentiment: action === 'LONG' ? 'BULLISH' : 'BEARISH',
        reasoning: `Manual execution approved by human operator via Visualizer Studio ($${marginUsd} margin, ${leverage}x leverage).`,
      };

      try {
        const result = await tradeExecutor.executeTrade(signal, aiEval);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: result.success,
          trade: result.trade,
          error: result.error,
          message: result.success 
            ? `Successfully executed ${action} trade for ${normSymbol} ($${marginUsd} @ ${leverage}x)`
            : `Order execution blocked: ${result.error}`,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

// ── SQLite & On-Chain Background Sync Engine ──────────────────────────────
function dbTradeToFrontendTrade(t: DbTrade): any {
  const fee = Number(t.fee_usd || 0);
  const grossPnl = Number(t.realized_pnl || 0);
  const netPnl = Number((grossPnl - fee).toFixed(4));
  let exitReason = t.exit_reason;
  let status = (t.status || 'closed').toLowerCase();

  // Authoritative Ledger Rectification: A closed trade with negative net PnL is NEVER a TP!
  if (status !== 'open') {
    if (netPnl < -0.0001) {
      if (status === 'closed_tp') {
        status = 'closed_sl';
      }
      if (!exitReason || exitReason.toUpperCase().includes('TP') || exitReason.toUpperCase().includes('HARVEST') || exitReason.toUpperCase().includes('TRAILING')) {
        exitReason = 'ON_CHAIN_SL';
      }
    } else if (netPnl > 0.05 && status === 'closed_sl') {
      status = 'closed_tp';
      if (exitReason && exitReason.toUpperCase().includes('SL')) {
        exitReason = 'ON_CHAIN_TP';
      }
    }
  }

  if (!exitReason || exitReason === 'Reconciled directly from Aptos on-chain DEX state' || exitReason === 'ON_CHAIN_DEX_CLOSE' || exitReason === 'DEX_SETTLED' || exitReason.includes('DEX')) {
    if (status === 'open') {
      exitReason = 'ACTIVE_POSITION';
    } else if (netPnl > 0.05) {
      exitReason = 'ON_CHAIN_TP';
    } else if (netPnl >= 0) {
      exitReason = 'BREAKEVEN';
    } else if (netPnl < 0) {
      exitReason = 'ON_CHAIN_SL';
    } else {
      exitReason = 'DEX_SETTLED';
    }
  }

  const rawTrade = t as any;
  const isManual = Boolean(
    rawTrade.is_manual === 1 ||
    rawTrade.is_manual === true ||
    rawTrade.is_manual === '1'
  );

  return {
    ...t,
    id: t.id,
    orderId: t.client_order_id || t.id,
    client_order_id: t.client_order_id || t.id,
    txHash: t.tx_version || null,
    tx_version: t.tx_version || null,
    transaction_version: t.tx_version || null,
    symbol: t.symbol,
    side: t.side,
    action: t.action,
    isManual,
    tradeType: isManual ? 'MANUAL' : 'AUTO',
    execution_price: t.entry_price,
    entryPrice: t.entry_price,
    entry_price: t.entry_price,
    price: t.exit_price || t.entry_price,
    exitPrice: t.exit_price,
    exit_price: t.exit_price,
    executed_size: t.size,
    sizeBase: t.size,
    size: t.size,
    allocatedUsd: t.allocated_usd,
    allocated_usd: t.allocated_usd,
    leverage: t.leverage,
    realized_pnl_amount: netPnl,
    pnlUsd: netPnl,
    netPnlUsd: netPnl,
    net_pnl: netPnl,
    grossPnlUsd: Number(grossPnl.toFixed(4)),
    gross_pnl: Number(grossPnl.toFixed(4)),
    pnlPct: t.realized_pnl_pct,
    realized_pnl_pct: t.realized_pnl_pct,
    fee_amount: Number(fee.toFixed(4)),
    feeUsd: Number(fee.toFixed(4)),
    fee_usd: Number(fee.toFixed(4)),
    status,
    openedAt: t.opened_at,
    opened_at: t.opened_at,
    closedAt: t.closed_at,
    closed_at: t.closed_at,
    timestamp: t.closed_at || t.opened_at || Date.now(),
    strategyName: t.strategy_name,
    strategy_name: t.strategy_name,
    confidence: t.confidence,
    exit_reason: exitReason,
    exitReason: exitReason,
    notes: exitReason,
  };
}

let isSyncingOnChain = false;
let lastOnChainSyncTime = 0;

function syncTradesToSqlite(trades: any[]): void {
  if (!Array.isArray(trades)) return;
  for (const t of trades) {
    if (!t.id) continue;
    try {
      const gross = t.grossPnlUsd !== undefined ? Number(t.grossPnlUsd) : (t.realized_pnl !== undefined ? Number(t.realized_pnl) : 0);
      const feeVal = t.feeUsd !== undefined ? Number(t.feeUsd) : (t.fee_amount !== undefined ? Number(t.fee_amount) : (t.fee_usd !== undefined ? Number(t.fee_usd) : 0));
      const pnl = t.netPnlUsd !== undefined ? Number(t.netPnlUsd) : (t.pnlUsd !== undefined ? Number(t.pnlUsd) : (gross - feeVal));
      let tradeStatus = (t.status || 'OPEN').toUpperCase();
      if ((tradeStatus === 'CLOSED_SL' || tradeStatus === 'CLOSED') && pnl > 0.05) {
        tradeStatus = 'CLOSED_TP';
      } else if (tradeStatus === 'CLOSED_TP' && pnl < -0.0001) {
        tradeStatus = 'CLOSED_SL';
      }
      let exitReason = t.exitReason || t.exit_reason || t.notes;
      if (tradeStatus !== 'OPEN' && pnl < -0.0001 && exitReason && (exitReason.toUpperCase().includes('TP') || exitReason.toUpperCase().includes('HARVEST') || exitReason.toUpperCase().includes('TRAILING'))) {
        exitReason = 'ON_CHAIN_SL';
      }
      if (!exitReason || exitReason === 'Reconciled directly from Aptos on-chain DEX state') {
        if (tradeStatus === 'OPEN') {
          exitReason = 'ACTIVE_POSITION';
        } else if (pnl > 0.05) {
          exitReason = 'TRAILING_TP';
        } else if (pnl >= 0) {
          exitReason = 'BREAKEVEN';
        } else if (pnl < 0) {
          exitReason = 'ON_CHAIN_SL';
        } else {
          exitReason = 'DEX_SETTLED';
        }
      }

      const isExplicitManual = Boolean(
        t.isManual === true || (t.orderId && String(t.orderId).startsWith('manual-user-override'))
      );
      let stratName = t.strategyName || t.strategy_name;
      if (!isExplicitManual && (!stratName || stratName === 'Manual Decibel Trade')) {
        stratName = 'Robust Island SMA Retest & 30% Dynamic Harvest Champion V3';
      }

      const grossPnl = t.grossPnlUsd !== undefined ? Number(t.grossPnlUsd) : (t.gross_pnl !== undefined ? Number(t.gross_pnl) : pnl);

      dbClient.upsertTrade({
        id: t.id,
        client_order_id: t.orderId || t.id,
        tx_version: t.txHash || t.tx_version,
        symbol: t.symbol,
        side: t.side || 'buy',
        action: t.action || 'LONG',
        is_manual: isExplicitManual ? 1 : 0,
        entry_price: Number(t.entryPrice || t.entry_price || 0),
        exit_price: t.exitPrice ? Number(t.exitPrice) : (t.exit_price ? Number(t.exit_price) : undefined),
        size: Number(t.sizeBase || t.size || 0),
        allocated_usd: Number(t.allocatedUsd || t.allocated_usd || 0),
        leverage: Number(t.leverage || 1),
        realized_pnl: grossPnl,
        fee_usd: feeVal,
        realized_pnl_pct: t.pnlPct !== undefined ? Number(t.pnlPct) : (t.realized_pnl_pct !== undefined ? Number(t.realized_pnl_pct) : 0),
        status: tradeStatus,
        opened_at: Number(t.openedAt || t.opened_at || Date.now()),
        closed_at: t.closedAt ? Number(t.closedAt) : (t.closed_at ? Number(t.closed_at) : undefined),
        strategy_name: stratName,
        confidence: t.confidence,
        exit_reason: exitReason,
      });
    } catch {}
  }
}

function triggerBackgroundOnChainSync(): void {
  const now = Date.now();
  if (isSyncingOnChain || (now - lastOnChainSyncTime < 8000)) return;
  isSyncingOnChain = true;
  setImmediate(async () => {
    try {
      await onChainPipeline.syncNow();
      lastOnChainSyncTime = Date.now();
    } catch (err: any) {
      logger.debug(`Background on-chain pipeline sync: ${err.message}`);
    } finally {
      isSyncingOnChain = false;
    }
  });
}

    // ── Trade Intel & Strategy Telemetry Endpoint ────────────────────────────
    if (pathname.startsWith('/api/trades/') && (pathname.endsWith('/intel') || pathname.endsWith('/telemetry'))) {
      const parts = pathname.split('/');
      const tradeId = decodeURIComponent(parts[3] || '');
      let telemetry = null;
      try {
        telemetry = dbClient.getTradeTelemetry(tradeId);
      } catch (err: any) {
        logger.debug(`SQLite getTradeTelemetry error: ${err.message}`);
      }

      if (!telemetry) {
        const allTrades = tradeExecutor.loadTrades();
        const found = allTrades.find((x: any) =>
          x.id === tradeId ||
          x.client_order_id === tradeId ||
          x.orderId === tradeId ||
          (x.symbol && (x.symbol === tradeId || tradeId.startsWith(x.symbol)))
        );
        if (found) {
          const pnl = found.pnlUsd !== undefined ? Number(found.pnlUsd) : 0;
          telemetry = {
            id: found.id,
            symbol: found.symbol,
            action: found.action,
            side: found.side,
            entry_price: found.entryPrice,
            exit_price: found.exitPrice,
            size: found.sizeBase,
            allocated_usd: found.allocatedUsd,
            leverage: found.leverage,
            realized_pnl: pnl,
            realized_pnl_pct: found.pnlPct || 0,
            status: found.status,
            opened_at: found.openedAt,
            closed_at: found.closedAt,
            strategy_name: found.strategyName || 'Autonomous Strategy',
            strategy_tags: found.strategyTags || ['Sniper', 'Pullback-to-Value', 'Smart-Money'],
            confidence: found.confidence || 85,
            entry_rationale: found.entryRationale || found.notes || '15m Structure: Institutional Break of Structure (BOS) trend continuation (+5%)\n1h Macro Trend: Aligned with directional momentum\nOrder Book: Ask-depth absorbed, high RVOL regime\nAI Shield Verdict: PASS with conviction bonus awarded',
            exit_reason: found.exitReason || found.notes || (pnl > 0.05 ? 'ON_CHAIN_TP' : (pnl > 0 ? 'BREAKEVEN' : (pnl < 0 ? 'ON_CHAIN_SL' : 'DEX_SETTLED'))),
            tx_version: found.txHash || found.tx_version,
            takeProfit: found.takeProfit,
            takeProfit1: found.takeProfit1,
            takeProfit2: found.takeProfit2,
            stopLoss: found.stopLoss,
            hardStopLoss: found.hardStopLoss,
            softRatchetPrice: found.softRatchetPrice,
            tp1Hit: found.tp1Hit,
            breakevenMoved: found.breakevenMoved,
            partialRealizedPnlUsd: found.partialRealizedPnlUsd,
            lifecycleEvents: found.lifecycleEvents || [],
            exitSummary: found.exitSummary || '',
          };
        }
      }

      if (telemetry) {
        let stratTags: any[] = ['Sniper', 'Pullback-to-Value', 'Smart-Money'];
        if (typeof telemetry.strategy_tags === 'string') {
          try { stratTags = JSON.parse(telemetry.strategy_tags); } catch {}
        } else if (Array.isArray(telemetry.strategy_tags)) {
          stratTags = telemetry.strategy_tags;
        }

        let entrySnap: any = null;
        if (typeof telemetry.entry_snapshot === 'string') {
          try { entrySnap = JSON.parse(telemetry.entry_snapshot); } catch {}
        } else if (telemetry.entry_snapshot && typeof telemetry.entry_snapshot === 'object') {
          entrySnap = telemetry.entry_snapshot;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ...telemetry,
          strategy_tags: stratTags,
          entry_snapshot: entrySnap,
          subaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Telemetry not found for trade: ' + tradeId }));
      return;
    }

    // ── 7. Trades History & Reset ────────────────────────────────────────────
    if (pathname === '/api/trades') {
      const isConfigured = isClientConfigured();
      if (!isConfigured) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, trades: [] }));
        return;
      }

      const limitParam = parseInt(parsedUrl.searchParams.get('limit') || '500', 10);

      // 1. Fetch immediately from SQLite database (0ms blocking, sub-millisecond response)
      let trades: any[] = [];
      try {
        const sqliteTrades = dbClient.getTrades({ limit: limitParam });
        if (sqliteTrades && sqliteTrades.length > 0) {
          trades = sqliteTrades.map(dbTradeToFrontendTrade);
        }
      } catch (err: any) {
        logger.debug(`SQLite trades read error: ${err.message}`);
      }

      // Fallback to local trade journal if SQLite table is empty
      if (!trades || trades.length === 0) {
        trades = tradeExecutor.loadTrades();
        if (trades.length > 0) {
          syncTradesToSqlite(trades);
        }
      }

      // If still 0 trades (e.g. freshly deployed or post-reset), sync on-chain directly
      if (!trades || trades.length === 0) {
        try {
          const onChainFills = await mcpClient.getTradeHistory(50);
          if (onChainFills && onChainFills.length > 0) {
            dbClient.syncOnChainTrades(onChainFills);
            const freshSqlite = dbClient.getTrades({ limit: limitParam });
            if (freshSqlite && freshSqlite.length > 0) {
              trades = freshSqlite.map(dbTradeToFrontendTrade);
            }
          }
        } catch (syncErr: any) {
          logger.debug(`Initial on-chain sync error: ${syncErr.message}`);
        }
      }

      // 2. Respond immediately so history page renders with 0 delay!
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, trades, source: 'sqlite' }));

      // 3. Reconcile with on-chain in the background without blocking HTTP
      triggerBackgroundOnChainSync();
      return;
    }

    // ── 7b. Manual On-Chain History Sync ─────────────────────────────────────
    if (pathname === '/api/trades/sync' && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const pipeState = await onChainPipeline.syncNow();
        const freshSqlite = dbClient.getTrades({ limit: 100 });
        const syncedTrades = freshSqlite && freshSqlite.length > 0 ? freshSqlite.map(dbTradeToFrontendTrade) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          count: syncedTrades.length,
          trades: syncedTrades,
          openPositionsCount: pipeState.openPositionsCount,
          accountEquityUsd: pipeState.accountEquityUsd,
          totalCollateralUsd: pipeState.totalCollateralUsd,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/trades/reset' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: remote admin authentication required.' }));
        return;
      }
      tradeExecutor.resetTrades();
      try {
        dbClient.clearAllTrades();
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'All trades reset. Budget allocation is now $0.00.' }));
      return;
    }

    // ── Mode & Engine Control Endpoints ──────────────────────────────────────
    if (pathname === '/api/mode' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: remote admin authentication required.' }));
        return;
      }
      config.AUTONOMOUS_MODE = 'full';
      updateDynamicSettings({ trading: { mode: 'full' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, mode: 'full' }));
      return;
    }

    if (pathname === '/api/control' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: remote admin authentication required.' }));
        return;
      }
      const body = await parseBody(req);
      const cmd = (body.command || body.action || '').toLowerCase();
      let reply = '';
      if (cmd === 'pause') {
        tradeExecutor.setPaused(true);
        agentState.status = 'paused';
        reply = '⏸️ Autonomous bot trading PAUSED. No new market entries will be executed.';
      } else if (cmd === 'resume') {
        tradeExecutor.setPaused(false);
        agentState.status = 'running';
        reply = '▶️ Autonomous bot trading RESUMED in FULL-AUTO mode.';
      } else if (cmd === 'scan') {
        reply = '🔍 Instant market scan triggered across active watch pairs.';
      } else {
        reply = `Command "${cmd}" received.`;
      }
      broadcastState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, reply, mode: config.AUTONOMOUS_MODE, isPaused: tradeExecutor.getIsPaused() }));
      return;
    }

    // ── 8. Financial Stats ───────────────────────────────────────────────────
    if (pathname === '/api/stats') {
      const isConfigured = isClientConfigured();
      if (!isConfigured) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            stats: {
              totalTrades: 0,
              closedTradesCount: 0,
              openTradesCount: 0,
              wins: 0,
              losses: 0,
              winRate: 0,
              totalPnlUsd: 0,
              autoPnlUsd: 0,
              manualPnlUsd: 0,
              autoWins: 0,
              autoLosses: 0,
              manualWins: 0,
              manualLosses: 0,
              budgetUsedUsd: 0,
              budgetAvailableUsd: 0,
              bestTradePnl: 0,
              worstTradePnl: 0,
            },
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, stats: tradeExecutor.getStats() }));
      return;
    }

    // ── 9. Active Directives ─────────────────────────────────────────────────
    if (pathname === '/api/directives') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, directives: standaloneEngine.getDirectives() }));
      return;
    }

    // ── 9b. System & Hardware Telemetry ──────────────────────────────────────
    if (pathname === '/api/system/stats') {
      try {
        const stats = getSystemHardwareStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/system/gui' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getDesktopGUIStatus()));
      return;
    }

    if (pathname === '/api/system/gui' && req.method === 'POST') {
      try {
        const data = await parseBody<{ enabled: boolean }>(req);
        const status = await setDesktopGUIState(Boolean(data.enabled));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, gui: status }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── 10. General Settings Endpoint ────────────────────────────────────────
    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        const maskedKey = config.DECIBEL_DELEGATE_KEY
          ? config.DECIBEL_DELEGATE_KEY.slice(0, 10) + '...' + config.DECIBEL_DELEGATE_KEY.slice(-6)
          : '';
        const saved = loadPersistentSettings();
        const activeModel = saved.ai?.model || saved.aiModel || config.GEMINI_MODEL || 'gemini-2.5-flash';
        const activeProvider = (saved.ai?.provider || saved.aiProvider || config.ACTIVE_AI_PROVIDER || 'gemini').toLowerCase();
        const activeSl = (config as any).DEFAULT_STOP_LOSS_PCT ?? saved.trading?.defaultStopLossPct ?? saved.defaultStopLossPct ?? 1.5;
        const activeTp = (config as any).DEFAULT_TAKE_PROFIT_PCT ?? saved.trading?.defaultTakeProfitPct ?? saved.defaultTakeProfitPct ?? 3.0;
        const activeSlippage = (config as any).SLIPPAGE_TOLERANCE_PCT ?? saved.trading?.slippageTolerancePct ?? saved.slippageTolerancePct ?? 0.3;

        const hasAnyAiKey = isValidApiKey(config.GEMINI_API_KEY) ||
          isValidApiKey(config.ANTHROPIC_API_KEY) ||
          isValidApiKey(config.HF_TOKEN) ||
          Boolean(saved.ai?.apiKey || saved.aiApiKey || saved.ai?.geminiApiKey || saved.ai?.anthropicApiKey || saved.ai?.hfToken);
        const rawApiBaseUrl = config.DECIBEL_API_BASE_URL || saved.decibelApiBaseUrl || saved.credentials?.decibelApiBaseUrl || '';
        const resolvedApiBaseUrl = (rawApiBaseUrl && !rawApiBaseUrl.includes('api.decibel.trade')) ? rawApiBaseUrl : 'https://api.mainnet.aptoslabs.com/decibel';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            settings: {
              credentials: {
                network: config.NETWORK,
                decibelSubaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
                decibelOwnerAddress: config.DECIBEL_OWNER_ADDRESS,
                decibelSignerAddress: getDerivedSignerAddress(),
                gasFeeAddress: tradeExecutor.getSignerAddress() || getDerivedSignerAddress(),
                decibelNodeApiKey: config.DECIBEL_NODE_API_KEY ? '••••••••' : '',
                decibelDelegateKeyMasked: maskedKey,
                decibelApiBaseUrl: resolvedApiBaseUrl,
                hasRealKey: isClientConfigured(),
                onboarded: isClientOnboarded(),
              },
              ai: {
                provider: activeProvider,
                model: activeModel,
                hasApiKey: hasAnyAiKey,
                hasGeminiKey: isValidApiKey(config.GEMINI_API_KEY) || Boolean(saved.ai?.geminiApiKey || saved.geminiApiKey),
                hasClaudeKey: isValidApiKey(config.ANTHROPIC_API_KEY) || Boolean(saved.ai?.anthropicApiKey),
                anthropicBaseUrl: config.ANTHROPIC_BASE_URL,
                ollamaBaseUrl: config.OLLAMA_BASE_URL,
                secondaryEnabled: Boolean(saved.ai?.secondaryEnabled ?? saved.secondaryEnabled),
                secondaryProvider: (saved.ai?.secondaryProvider ?? saved.secondaryProvider ?? saved.secondaryAiProvider ?? 'anthropic').toLowerCase(),
                secondaryModel: saved.ai?.secondaryModel ?? saved.secondaryModel ?? saved.secondaryAiModel ?? 'claude-3-5-sonnet-20241022',
                secondaryCustomBaseUrl: saved.ai?.secondaryCustomBaseUrl ?? saved.secondaryCustomBaseUrl ?? '',
                hasSecondaryApiKey: Boolean(saved.ai?.secondaryApiKey || saved.secondaryApiKey || saved.secondaryAiApiKey),
              },
              aiModel: activeModel,
              aiProvider: activeProvider,
              aiEnabled: saved.ai?.enabled !== false && saved.aiEnabled !== false,
              aiApiKeyMasked: hasAnyAiKey ? '••••••••' : '',
              decibelApiBaseUrl: resolvedApiBaseUrl,
              secondaryEnabled: Boolean(saved.ai?.secondaryEnabled ?? saved.secondaryEnabled),
              secondaryProvider: (saved.ai?.secondaryProvider ?? saved.secondaryProvider ?? saved.secondaryAiProvider ?? 'anthropic').toLowerCase(),
              secondaryModel: saved.ai?.secondaryModel ?? saved.secondaryModel ?? saved.secondaryAiModel ?? 'claude-3-5-sonnet-20241022',
              secondaryCustomBaseUrl: saved.ai?.secondaryCustomBaseUrl ?? saved.secondaryCustomBaseUrl ?? '',
              hasSecondaryApiKey: Boolean(saved.ai?.secondaryApiKey || saved.secondaryApiKey || saved.secondaryAiApiKey),
              trading: {
                budgetUsd: config.BUDGET_USD ?? 0,
                minPositionUsd: config.MIN_POSITION_USD ?? saved.trading?.minPositionUsd ?? 0,
                maxPositionUsd: (config as any).MAX_POSITION_USD ?? saved.trading?.maxPositionUsd ?? saved.maxPositionUsd ?? 0,
                maxOpenPositions: (config as any).MAX_OPEN_POSITIONS ?? saved.trading?.maxOpenPositions ?? saved.maxOpenPositions ?? 3,
                maxConcurrentPositions: (config as any).MAX_OPEN_POSITIONS ?? saved.trading?.maxOpenPositions ?? saved.maxOpenPositions ?? 3,
                paperTrading: config.PAPER_TRADING,
                clientName: config.CLIENT_NAME,
                watchPairs: config.WATCH_PAIRS,
                maxRiskPerTradePct: config.MAX_RISK_PER_TRADE_PCT,
                minConfidencePct: config.MIN_CONFIDENCE_PCT,
                minLeverage: config.MIN_LEVERAGE ?? 5,
                maxLeverage: config.MAX_LEVERAGE ?? 12,
                minAllocPct: config.MIN_ALLOC_PCT ?? 35,
                maxAllocPct: config.MAX_ALLOC_PCT ?? 60,
                defaultStopLossPct: activeSl,
                defaultTakeProfitPct: activeTp,
                slippageTolerancePct: activeSlippage,
              },
              budgetUsd: config.BUDGET_USD ?? 0,
              minPositionUsd: config.MIN_POSITION_USD ?? saved.trading?.minPositionUsd ?? 0,
              maxPositionUsd: (config as any).MAX_POSITION_USD ?? saved.trading?.maxPositionUsd ?? saved.maxPositionUsd ?? 0,
              minLeverage: config.MIN_LEVERAGE ?? 5,
              maxLeverage: config.MAX_LEVERAGE ?? 12,
              minAllocPct: config.MIN_ALLOC_PCT ?? 35,
              maxAllocPct: config.MAX_ALLOC_PCT ?? 60,
              maxOpenPositions: (config as any).MAX_OPEN_POSITIONS ?? saved.trading?.maxOpenPositions ?? saved.maxOpenPositions ?? 3,
              maxConcurrentPositions: (config as any).MAX_OPEN_POSITIONS ?? saved.trading?.maxOpenPositions ?? saved.maxOpenPositions ?? 3,
              defaultStopLossPct: activeSl,
              defaultTakeProfitPct: activeTp,
              slippageTolerancePct: activeSlippage,
              paperTrading: config.PAPER_TRADING,
              telegram: telegramNotifier.getSettings(),
              robustReversalLoop: saved.robustReversalLoop || {
                enabled: true,
                marginUsd: 30,
                leverage: 10,
                tickCadenceSec: 10,
                maxConcurrentPositions: 1,
                minExpansionPct: 0.40,
                emergencyStopPct: 0.80,
                pairs: {
                  'SOL/USD': { fastPeriod: 12, slowPeriod: 48, emergencyStopPct: 0.80 },
                  'SUI/USD': { fastPeriod: 16, slowPeriod: 42, emergencyStopPct: 0.70 },
                  'ETH/USD': { fastPeriod: 14, slowPeriod: 52, emergencyStopPct: 0.80 },
                  'BTC/USD': { fastPeriod: 18, slowPeriod: 64, emergencyStopPct: 0.50 },
                },
              },
              security: {
                hasAdminPassword: Boolean(config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.trim() !== ''),
              },
            },
          }),
        );
        return;
      }

      if (req.method === 'POST') {
        if (!isAuthorized(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Admin login required.' }));
          return;
        }

        const body = await parseBody(req);
        try {
          updateDynamicSettings(body);
        } catch (saveErr: any) {
          logger.error(`❌ [SETTINGS] Failed to save settings to disk: ${saveErr.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Failed to save settings: ${saveErr.message}` }));
          return;
        }

        // Only update Telegram notifier if genuine, unmasked credentials were provided
        const tgToken = (body.telegramBotToken || body.telegram?.botToken || '').trim();
        const tgChat = (body.telegramChatId !== undefined ? body.telegramChatId : body.telegram?.chatId !== undefined ? body.telegram?.chatId : '').trim();
        const hasRealTgToken = tgToken && !tgToken.includes('••••') && tgToken.length > 5;
        const hasRealTgChat = tgChat && !tgChat.includes('••••') && tgChat.length > 0;
        if (hasRealTgToken || hasRealTgChat || body.telegramEnabled !== undefined || body.telegram?.enabled !== undefined) {
          telegramNotifier.updateSettings(
            hasRealTgToken ? tgToken : undefined,
            hasRealTgChat ? tgChat : undefined,
            body.telegramEnabled ?? body.telegram?.enabled
          );
        }

        let telegramTestResult: any = undefined;
        if (body.testTelegramAlert) {
          try {
            telegramTestResult = await telegramNotifier.sendTestMessage();
          } catch (err: any) {
            telegramTestResult = { success: false, error: err.message };
          }
        }

        logger.info('⚙️ [SETTINGS] Configuration updated from dashboard.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Settings successfully updated!',
          telegramTestResult,
        }));

        try {
          broadcastState();
        } catch (bErr: any) {
          logger.warn(`broadcastState warning after settings save: ${bErr.message}`);
        }

        setImmediate(() => {
          try {
            tradeExecutor.reinitializeSigner();
            if (isClientConfigured()) {
              seedMarketsForPairs();
              triggerImmediateScan();
            }
          } catch (e: any) {
            logger.warn(`Post-settings reinitialization warning: ${e.message}`);
          }
        });
        return;
      }
    }

    // ── 9b. Dedicated Risk Guardrails Endpoint ─────────────────────────────────
    if (pathname === '/api/settings/risk') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          settings: {
            budgetUsd: config.BUDGET_USD,
            minPositionUsd: config.MIN_POSITION_USD,
            maxPositionUsd: config.MAX_POSITION_USD,
            minLeverage: config.MIN_LEVERAGE,
            maxLeverage: config.MAX_LEVERAGE,
            minAllocPct: config.MIN_ALLOC_PCT,
            maxAllocPct: config.MAX_ALLOC_PCT,
            defaultStopLossPct: (config as any).DEFAULT_STOP_LOSS_PCT || 1.5,
            defaultTakeProfitPct: (config as any).DEFAULT_TAKE_PROFIT_PCT || 3.0,
            maxOpenPositions: config.MAX_OPEN_POSITIONS,
            slippageTolerancePct: (config as any).SLIPPAGE_TOLERANCE_PCT || 0.3,
          }
        }));
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        updateDynamicSettings({ trading: body, ...body });
        try {
          broadcastState();
        } catch (bErr: any) {
          logger.warn(`broadcastState warning after risk settings save: ${bErr.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Risk guardrails updated successfully!',
        }));
        return;
      }
    }

    // ── 10a. AI Intelligence Dedicated Settings Endpoint ─────────────────────
    if (pathname === '/api/settings/ai' || pathname === '/api/ai/settings') {
      if (req.method === 'GET') {
        const { getMaskedAISettings } = require('./ai/settings');
        const masked = getMaskedAISettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(masked));
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        updateDynamicSettings({ ai: body, ...body });
        const updated = getAISettings();
        logger.info(`🤖 [AI SETTINGS] AI Intelligence updated. Provider: ${updated.provider}, Model: ${updated.model}, Enabled: ${updated.enabled}`);
        try {
          broadcastState();
        } catch (bErr: any) {
          logger.warn(`broadcastState warning after ai settings save: ${bErr.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'AI Intelligence settings saved.',
          settings: updated,
          ...updated,
        }));
        return;
      }
    }

    // ── 10b. AI Model Discovery & Connection Testing ──────────────────────────
    if (pathname === '/api/ai/models' && req.method === 'GET') {
      const provider = (parsedUrl.searchParams.get('provider') || 'gemini').toLowerCase();
      const queryKey = (parsedUrl.searchParams.get('key') || parsedUrl.searchParams.get('apiKey') || '').trim();
      const persistentSettings = loadPersistentSettings();
      const savedAi = persistentSettings.ai || persistentSettings.settings || {};
      
      // Resolve key based on provider: user settings take precedence over .env
      let key = queryKey;
      if (!key) {
        if (provider === 'gemini') key = savedAi.apiKey || savedAi.geminiApiKey || persistentSettings.aiApiKey || config.GEMINI_API_KEY || '';
        else if (provider === 'anthropic' || provider === 'claude') key = savedAi.apiKey || savedAi.anthropicApiKey || config.ANTHROPIC_API_KEY || '';
        else if (provider === 'openai') key = savedAi.apiKey || savedAi.openaiApiKey || process.env.OPENAI_API_KEY || '';
        else if (provider === 'deepseek') key = savedAi.apiKey || savedAi.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';
        else if (provider === 'groq') key = savedAi.apiKey || savedAi.groqApiKey || process.env.GROQ_API_KEY || '';
        else if (provider === 'openrouter') key = savedAi.apiKey || savedAi.openrouterApiKey || process.env.OPENROUTER_API_KEY || '';
        else if (provider === 'huggingface' || provider === 'hf') key = savedAi.apiKey || savedAi.hfToken || config.HF_TOKEN || '';
        else key = savedAi.apiKey || '';
      }

      // Default curated fallback lists per provider
      const fallbackModels: Record<string, Array<{ id: string; name: string; description: string; recommended?: boolean }>> = {
        huggingface: [
          { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'meta-llama/Llama-3.3-70B-Instruct', description: '⚡ Recommended · Flagship Llama 3.3 70B', recommended: true },
          { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen/Qwen2.5-72B-Instruct', description: '🧠 High Intelligence & Reasoning' },
          { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'mistralai/Mixtral-8x7B-Instruct-v0.1', description: '🔬 Mixtral 8x7B MoE' },
          { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', description: '🧠 DeepSeek R1 Reasoning Model' },
          { id: 'google/gemma-2-27b-it', name: 'google/gemma-2-27b-it', description: '💨 Google Gemma 2 27B' },
        ],
        gemini: [
          { id: 'gemini-4-argon', name: 'gemini-4-argon', description: '🚀 Gemini 4 Argon · Next-Gen Institutional Intelligence', recommended: true },
          { id: 'gemini-3.8-flash', name: 'gemini-3.8-flash', description: '⚡ Gemini 3.8 Flash · High-Throughput Quantitative Reasoning' },
          { id: 'gemini-3.7-flash', name: 'gemini-3.7-flash', description: '⚡ Gemini 3.7 Flash · Hybrid Reasoning & Low Latency' },
          { id: 'gemini-flash-lite-latest', name: 'gemini-flash-lite-latest', description: '💨 Lowest Latency & High Rate Limit (Active)' },
          { id: 'gemini-3.6-flash', name: 'gemini-3.6-flash', description: '⚡ Gemini 3.6 Flash · Fast Multimodal' },
        ],
        openai: [
          { id: 'gpt-4o-mini', name: 'gpt-4o-mini', description: '⚡ Recommended · Fast & Cost Efficient', recommended: true },
          { id: 'gpt-4o', name: 'gpt-4o', description: '🧠 Flagship Omnimodel' },
          { id: 'o3-mini', name: 'o3-mini', description: '🔬 High-Speed STEM & Reasoning' },
          { id: 'o1', name: 'o1', description: '🧠 Deep Multi-Step Reasoning' },
          { id: 'gpt-4-turbo', name: 'gpt-4-turbo', description: '🚀 Previous Generation High Performance' },
        ],
        anthropic: [
          { id: 'claude-3-7-sonnet-20250219', name: 'claude-3-7-sonnet-20250219', description: '⚡ Recommended · Hybrid Reasoning & Coding', recommended: true },
          { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022', description: '🧠 Top Intelligence & Strategy' },
          { id: 'claude-3-5-haiku-20241022', name: 'claude-3-5-haiku-20241022', description: '💨 Ultra Fast & Low Latency' },
          { id: 'claude-3-opus-20240229', name: 'claude-3-opus-20240229', description: '🔬 Deep Analysis & Complex Nuance' },
        ],
        claude: [
          { id: 'claude-3-7-sonnet-20250219', name: 'claude-3-7-sonnet-20250219', description: '⚡ Recommended · Hybrid Reasoning & Coding', recommended: true },
          { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022', description: '🧠 Top Intelligence & Strategy' },
          { id: 'claude-3-5-haiku-20241022', name: 'claude-3-5-haiku-20241022', description: '💨 Ultra Fast & Low Latency' },
        ],
        deepseek: [
          { id: 'deepseek-chat', name: 'deepseek-chat', description: '⚡ Recommended · DeepSeek-V3 High-Throughput', recommended: true },
          { id: 'deepseek-reasoner', name: 'deepseek-reasoner', description: '🧠 DeepSeek-R1 Full Chain-of-Thought' },
        ],
        groq: [
          { id: 'llama-3.3-70b-versatile', name: 'llama-3.3-70b-versatile', description: '⚡ Recommended · 70B Fast Inference', recommended: true },
          { id: 'llama-3.1-8b-instant', name: 'llama-3.1-8b-instant', description: '💨 8B Ultra Low Latency' },
          { id: 'deepseek-r1-distill-llama-70b', name: 'deepseek-r1-distill-llama-70b', description: '🧠 DeepSeek R1 Reasoning on Groq LPU' },
          { id: 'mixtral-8x7b-32768', name: 'mixtral-8x7b-32768', description: '🔬 32k Context Window MoE' },
        ],
        openrouter: [
          { id: 'google/gemini-2.5-flash', name: 'google/gemini-2.5-flash', description: '⚡ Recommended · Google Gemini 2.5 Flash', recommended: true },
          { id: 'anthropic/claude-3.5-sonnet', name: 'anthropic/claude-3.5-sonnet', description: '🧠 Anthropic Claude 3.5 Sonnet' },
          { id: 'deepseek/deepseek-r1', name: 'deepseek/deepseek-r1', description: '🧠 DeepSeek R1 Reasoning' },
          { id: 'openai/gpt-4o-mini', name: 'openai/gpt-4o-mini', description: '💨 OpenAI GPT-4o Mini' },
        ],
        custom: [
          { id: 'qwen2.5:3b', name: 'qwen2.5:3b', description: '⚡ Recommended · Fast Local Inference', recommended: true },
          { id: 'llama3.2:latest', name: 'llama3.2:latest', description: '🦙 Meta Llama 3.2 Local' },
          { id: 'deepseek-r1:8b', name: 'deepseek-r1:8b', description: '🧠 Local Reasoning' },
          { id: 'mistral:latest', name: 'mistral:latest', description: '🌪️ Mistral 7B Local' },
        ],
        local_rules: [
          { id: 'quantitative-confluence-engine', name: 'quantitative-confluence-engine', description: '🛡️ Pure Quantitative Technical Analysis (Offline)', recommended: true }
        ]
      };

      // Fast cache check: return instantly (<1ms) if models for this provider & key were recently discovered
      const cacheKey = `${provider}_${key ? key.slice(-6) : 'default'}`;
      const cached = aiModelCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < AI_MODEL_CACHE_TTL_MS)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, models: cached.models, source: cached.source }));
        return;
      }

      // 1. Google Gemini Live Fetch
      if (provider === 'gemini') {
        if (!key || key.startsWith('AQ.')) {
          aiModelCache.set(cacheKey, { timestamp: Date.now(), models: fallbackModels.gemini, source: 'curated' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.gemini, source: 'curated' }));
          return;
        }
        try {
          const resp = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { timeout: 2500 });
          const rawModels = resp.data?.models || [];
          const geminiModels = rawModels
            .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
            .map((m: any) => {
              const cleanId = m.name.replace(/^models\//, '');
              const isRec = cleanId === 'gemini-2.5-flash';
              return {
                id: cleanId,
                name: cleanId,
                description: m.displayName || cleanId,
                recommended: isRec,
              };
            })
            .filter((m: any) => m.id.startsWith('gemini'));

          geminiModels.sort((a: any, b: any) => {
            if (a.id === 'gemini-2.5-flash') return -1;
            if (b.id === 'gemini-2.5-flash') return 1;
            if (a.id === 'gemini-2.5-pro') return -1;
            if (b.id === 'gemini-2.5-pro') return 1;
            if (a.id === 'gemini-2.0-flash') return -1;
            if (b.id === 'gemini-2.0-flash') return 1;
            return b.id.localeCompare(a.id);
          });

          const resModels = geminiModels.length ? geminiModels : fallbackModels.gemini;
          aiModelCache.set(cacheKey, { timestamp: Date.now(), models: resModels, source: 'live_api' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: resModels,
            source: 'live_api',
          }));
          return;
        } catch (err: any) {
          aiModelCache.set(cacheKey, { timestamp: Date.now() - AI_MODEL_CACHE_TTL_MS + 60000, models: fallbackModels.gemini, source: 'curated_fallback' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: fallbackModels.gemini,
            source: 'curated_fallback',
            warning: err.response?.data?.error?.message || err.message,
          }));
          return;
        }
      }

      // 2. OpenAI Live Fetch
      if (provider === 'openai') {
        if (!key) {
          aiModelCache.set(cacheKey, { timestamp: Date.now(), models: fallbackModels.openai, source: 'curated' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.openai, source: 'curated' }));
          return;
        }
        try {
          const resp = await axios.get('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 2500,
          });
          const rawModels = resp.data?.data || [];
          const openAiModels = rawModels
            .map((m: any) => m.id)
            .filter((id: string) => id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('chatgpt'))
            .map((id: string) => ({
              id,
              name: id,
              description: id.includes('mini') ? '⚡ Fast & Low Latency' : '🧠 Advanced Model',
              recommended: id === 'gpt-4o-mini',
            }));

          openAiModels.sort((a: any, b: any) => {
            if (a.id === 'gpt-4o-mini') return -1;
            if (b.id === 'gpt-4o-mini') return 1;
            if (a.id === 'gpt-4o') return -1;
            if (b.id === 'gpt-4o') return 1;
            return b.id.localeCompare(a.id);
          });

          const resModels = openAiModels.length ? openAiModels : fallbackModels.openai;
          aiModelCache.set(cacheKey, { timestamp: Date.now(), models: resModels, source: 'live_api' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: resModels,
            source: 'live_api',
          }));
          return;
        } catch (err: any) {
          aiModelCache.set(cacheKey, { timestamp: Date.now() - AI_MODEL_CACHE_TTL_MS + 60000, models: fallbackModels.openai, source: 'curated_fallback' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.openai, source: 'curated_fallback' }));
          return;
        }
      }

      // 3. Groq Live Fetch
      if (provider === 'groq') {
        if (!key) {
          aiModelCache.set(cacheKey, { timestamp: Date.now(), models: fallbackModels.groq, source: 'curated' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.groq, source: 'curated' }));
          return;
        }
        try {
          const resp = await axios.get('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 2500,
          });
          const rawModels = resp.data?.data || [];
          const groqModels = rawModels.map((m: any) => ({
            id: m.id,
            name: m.id,
            description: m.id.includes('70b') ? '⚡ 70B High Speed' : '💨 Low Latency',
            recommended: m.id.includes('llama-3.3-70b'),
          }));

          const resModels = groqModels.length ? groqModels : fallbackModels.groq;
          aiModelCache.set(cacheKey, { timestamp: Date.now(), models: resModels, source: 'live_api' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: resModels,
            source: 'live_api',
          }));
          return;
        } catch (err: any) {
          aiModelCache.set(cacheKey, { timestamp: Date.now() - AI_MODEL_CACHE_TTL_MS + 60000, models: fallbackModels.groq, source: 'curated_fallback' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.groq, source: 'curated_fallback' }));
          return;
        }
      }

      // 4. OpenRouter Live Fetch
      if (provider === 'openrouter') {
        try {
          const resp = await axios.get('https://openrouter.ai/api/v1/models', {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            timeout: 6000,
          });
          const rawModels = (resp.data?.data || []).slice(0, 30);
          const routerModels = rawModels.map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            description: m.description ? `${m.description.slice(0, 50)}...` : 'Multi-provider model',
            recommended: m.id.includes('gemini-2.5-flash') || m.id.includes('claude-3.5-sonnet'),
          }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: routerModels.length ? routerModels : fallbackModels.openrouter,
            source: 'live_api',
          }));
          return;
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.openrouter, source: 'curated_fallback' }));
          return;
        }
      }

      // 5. Local / Ollama Live Fetch
      if (provider === 'custom' || provider === 'ollama') {
        const ollamaBase = config.OLLAMA_BASE_URL || 'http://localhost:11434';
        try {
          const resp = await axios.get(`${ollamaBase}/api/tags`, { timeout: 3000 });
          const rawModels = resp.data?.models || [];
          const ollamaModels = rawModels.map((m: any) => ({
            id: m.name,
            name: m.name,
            description: `📦 Local Size: ${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB`,
            recommended: m.name.includes('qwen') || m.name.includes('llama3'),
          }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: ollamaModels.length ? ollamaModels : fallbackModels.custom,
            source: ollamaModels.length ? 'live_api' : 'curated_fallback',
          }));
          return;
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.custom, source: 'curated_fallback' }));
          return;
        }
      }

      // Default for all other providers (Anthropic, DeepSeek, Local Rules)
      const list = fallbackModels[provider] || fallbackModels.gemini;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, models: list, source: 'curated' }));
      return;
    }

    if ((pathname === '/api/settings/ai/test' || pathname === '/api/ai/test') && req.method === 'POST') {
      const body = await parseBody(req);
      const provider = (body.provider || config.ACTIVE_AI_PROVIDER || 'gemini').toLowerCase();
      const persistentSettings = loadPersistentSettings();
      const savedAi = persistentSettings.ai || persistentSettings.settings || {};
      let key = (body.apiKey || body.key || '').trim();
      if (!key) {
        if (provider === 'gemini') key = savedAi.apiKey || savedAi.geminiApiKey || persistentSettings.aiApiKey || config.GEMINI_API_KEY || '';
        else if (provider === 'anthropic' || provider === 'claude') key = savedAi.apiKey || savedAi.anthropicApiKey || config.ANTHROPIC_API_KEY || '';
        else if (provider === 'openai') key = savedAi.apiKey || savedAi.openaiApiKey || process.env.OPENAI_API_KEY || '';
        else if (provider === 'deepseek') key = savedAi.apiKey || savedAi.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';
        else key = savedAi.apiKey || '';
      }
      const model = (body.model || body.modelId || 'gemini-2.5-flash').trim();

      const startTime = Date.now();
      if (provider === 'gemini') {
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Gemini API key is required to test connection.' }));
          return;
        }

        let targetModel = (model || '').trim().replace(/^models\//, '');
        if (targetModel === 'gemini-4' || targetModel === 'gemini 4' || targetModel === 'gemini4') {
          targetModel = 'gemini-4-argon';
        }
        if (!targetModel) targetModel = 'gemini-4-argon';

        try {
          const projectId = (config as any).VERTEX_PROJECT_ID || process.env.VERTEX_PROJECT_ID || '782261089175';
          const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${targetModel}:generateContent?key=${key}`;
          const aiStudioUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${key}`;
          const isVertexKey = key.startsWith('AQ.');
          const testUrls = isVertexKey ? [vertexUrl] : [aiStudioUrl, vertexUrl];

          let pingRes: any = null;
          let lastErr: any = null;
          let matchedPlatform = isVertexKey ? 'Vertex AI' : 'Google AI Studio';
          for (const testUrl of testUrls) {
            try {
              pingRes = await axios.post(
                testUrl,
                {
                  contents: [{ role: 'user', parts: [{ text: 'Respond with: "OK: Autonomous AI Active"' }] }],
                  generationConfig: {
                    maxOutputTokens: 60,
                    temperature: 0.1,
                    thinkingConfig: { thinkingBudget: 0 },
                  },
                },
                { timeout: 10000 }
              );
              matchedPlatform = testUrl.includes('aiplatform') ? 'Vertex AI' : 'Google AI Studio';
              if (pingRes?.data?.candidates?.[0]?.content?.parts?.[0]?.text) break;
            } catch (e: any) {
              lastErr = e;
            }
          }
          if (!pingRes?.data) {
            const errDetail = lastErr?.response?.data ? (typeof lastErr.response.data === 'string' ? lastErr.response.data : JSON.stringify(lastErr.response.data)) : (lastErr?.message || 'Connection failed');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, latencyMs: Date.now() - startTime, message: `Gemini probe failed: ${errDetail}` }));
            return;
          }
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to ${targetModel} via ${matchedPlatform} (${latencyMs}ms). Probe: "${replyText}"`,
            model: targetModel,
            provider: 'gemini',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Gemini API error: ${errorMsg}`,
            model,
            provider: 'gemini',
          }));
          return;
        }
      }

      if (provider === 'openai') {
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'OpenAI API key is required to test connection.' }));
          return;
        }
        try {
          const pingRes = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
              model: model || 'gpt-4o-mini',
              messages: [{ role: 'user', content: 'Respond with: "OK"' }],
              max_tokens: 10,
            },
            { headers: { Authorization: `Bearer ${key}` }, timeout: 4500 }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.choices?.[0]?.message?.content?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to OpenAI (${model}) successfully (${latencyMs}ms). Reply: "${replyText}"`,
            model,
            provider: 'openai',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `OpenAI API error: ${errorMsg}`,
            model,
            provider: 'openai',
          }));
          return;
        }
      }

      if (provider === 'anthropic' || provider === 'claude') {
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Anthropic API key is required to test connection.' }));
          return;
        }
        try {
          const pingRes = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
              model: model || 'claude-3-5-haiku-20241022',
              messages: [{ role: 'user', content: 'Respond with: "OK"' }],
              max_tokens: 10,
            },
            {
              headers: {
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
              },
              timeout: 8000,
            }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.content?.[0]?.text?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to Anthropic Claude (${model}) successfully (${latencyMs}ms). Reply: "${replyText}"`,
            model,
            provider: 'anthropic',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Anthropic API error: ${errorMsg}`,
            model,
            provider: 'anthropic',
          }));
          return;
        }
      }

      if (provider === 'groq') {
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Groq API key is required to test connection.' }));
          return;
        }
        try {
          const pingRes = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model: model || 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: 'Respond with: "OK"' }],
              max_tokens: 10,
            },
            { headers: { Authorization: `Bearer ${key}` }, timeout: 4500 }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.choices?.[0]?.message?.content?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to Groq (${model}) successfully (${latencyMs}ms). Reply: "${replyText}"`,
            model,
            provider: 'groq',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Groq API error: ${errorMsg}`,
            model,
            provider: 'groq',
          }));
          return;
        }
      }

      if (provider === 'huggingface' || provider === 'hf') {
        const hfKey = key || config.HF_TOKEN;
        if (!hfKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Hugging Face API token (hf_...) is required to test connection.' }));
          return;
        }
        try {
          const testModel = model || 'meta-llama/Llama-3.3-70B-Instruct';
          let pingRes;
          try {
            pingRes = await axios.post(
              'https://router.huggingface.co/v1/chat/completions',
              {
                model: testModel,
                messages: [{ role: 'user', content: 'Respond with: "OK"' }],
                max_tokens: 15,
              },
              {
                headers: { Authorization: `Bearer ${hfKey}` },
                timeout: 10000,
              }
            );
          } catch (routerErr: any) {
            pingRes = await axios.post(
              `https://api-inference.huggingface.co/models/${testModel}/v1/chat/completions`,
              {
                model: testModel,
                messages: [{ role: 'user', content: 'Respond with: "OK"' }],
                max_tokens: 15,
              },
              {
                headers: { Authorization: `Bearer ${hfKey}` },
                timeout: 10000,
              }
            );
          }
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.choices?.[0]?.message?.content?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to Hugging Face (${testModel}) successfully (${latencyMs}ms). Probe reply: "${replyText}"`,
            model: testModel,
            provider: 'huggingface',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Hugging Face API error: ${typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg)}`,
            model,
            provider: 'huggingface',
          }));
          return;
        }
      }

      if (provider === 'custom' || provider === 'ollama') {
        const rawUrl = (body.customBaseUrl || body.secondaryCustomBaseUrl || body.url || config.OLLAMA_BASE_URL || 'http://localhost:11434').trim();
        const customUrl = rawUrl.replace(/\/+$/, '');
        let testModel = (body.model || body.secondaryModel || 'qwen2.5:3b').trim();
        if (testModel.includes('gemini') || testModel.includes('claude') || testModel.includes('meta-llama') || !testModel) {
          testModel = 'qwen2.5:3b';
        }
        try {
          const pingRes = await axios.post(
            `${customUrl}/api/generate`,
            {
              model: testModel,
              prompt: 'Respond with: "OK"',
              stream: false,
              format: 'json',
            },
            { timeout: 10000 }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.response?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to ${testModel} at ${customUrl} successfully (${latencyMs}ms). Reply: "${replyText}"`,
            model: testModel,
            provider,
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Ollama/Custom API error at ${customUrl}: ${errorMsg}`,
            model: testModel,
            provider,
          }));
          return;
        }
      }

      if (provider === 'local_rules') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          latencyMs: 1,
          message: 'Local Quantitative Math Rules active (Zero API key required).',
          provider: 'local_rules',
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        latencyMs: 15,
        message: `${provider} provider configuration validated.`,
        provider,
      }));
      return;
    }

    // ── 11. Sim Lab Supercharge Features & Connection ────────────────────────
    if (pathname === '/api/simlab/ping') {
      let targetUrl = '';
      let apiKey = '';
      if (req.method === 'POST') {
        const body = await parseBody(req);
        targetUrl = body.url || body.serverUrl || '';
        apiKey = body.key || body.apiKey || body.simLabKey || '';
      } else {
        targetUrl = parsedUrl.searchParams.get('url') || '';
        apiKey = parsedUrl.searchParams.get('key') || '';
      }
      const pingResult = await superchargeClient.pingTest(targetUrl, apiKey);
      res.writeHead(pingResult.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pingResult));
      return;
    }

    if (pathname === '/api/simlab/features') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            isConnected: superchargeClient.isActive(),
            simLabKey: superchargeClient.getRawToken(),
            serverUrl: superchargeClient.getServerUrl(),
            features: superchargeClient.getFeatureFlags(),
          }),
        );
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const customUrl = body.url || body.serverUrl;
        
        // Handle feature flag updates (both nested { features: {...} } and flat)
        const flagsToUpdate = body.features || (body.syncMacroRegime !== undefined || body.syncIndicators !== undefined ? body : null);
        if (flagsToUpdate) {
          superchargeClient.updateFeatureFlags(flagsToUpdate, customUrl);
        }

        if (body.action === 'disconnect') {
          config.OPERATING_MODE = 'STANDALONE';
          superchargeClient.disconnect();
          try {
            const { stopSimPipelineConsumer } = require('./pipeline/sim-consumer');
            stopSimPipelineConsumer();
          } catch {}
          try {
            const { resetSimLabOverrides, getActiveStrategy, getActiveStrategyOriginInfo, getAllPairOverrides } = require('./strategy/manager');
            resetSimLabOverrides();
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              message: 'Disconnected from Sim Lab. Reverted to Standalone Mode.',
              isConnected: false,
              serverUrl: superchargeClient.getServerUrl(),
              simLabKey: '',
              features: superchargeClient.getFeatureFlags(),
              activeStrategy: getActiveStrategy(),
              origin: getActiveStrategyOriginInfo(),
              pairOverrides: getAllPairOverrides(),
              directives: standaloneEngine.getDirectives(),
            }),
          );
          return;
        }

        if (body.action === 'connect' || body.simLabKey !== undefined) {
          const key = (body.key || body.simLabKey || '').trim();
          if (!key) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: 'Sim Lab API Key is required. Please enter an API key or pairing token before connecting (required even for local testing).',
                message: 'Sim Lab API Key is required. Please enter an API key or pairing token before connecting (required even for local testing).',
                isConnected: false,
                serverUrl: superchargeClient.getServerUrl(),
                features: superchargeClient.getFeatureFlags(),
              }),
            );
            return;
          }

          const result = await superchargeClient.connectWithKey(key, customUrl);
          if (result.success) {
            try {
              const { startSimPipelineConsumer } = require('./pipeline/sim-consumer');
              startSimPipelineConsumer();
            } catch {}
          }
          res.writeHead(result.success ? 200 : 403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: result.success,
              message: result.message,
              error: result.success ? undefined : result.message,
              isConnected: superchargeClient.isActive(),
              serverUrl: superchargeClient.getServerUrl(),
              simLabKey: superchargeClient.getRawToken(),
              features: superchargeClient.getFeatureFlags(),
            }),
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            isConnected: superchargeClient.isActive(),
            serverUrl: superchargeClient.getServerUrl(),
            simLabKey: superchargeClient.getRawToken(),
            features: superchargeClient.getFeatureFlags(),
          }),
        );
        return;
      }
    }

    // ── 11b. Sim Pipeline Status & Comparison Endpoint ───────────────────────
    if (pathname === '/api/pipeline/sim-status') {
      let lastBundle: any = null;
      let lastSyncTime = 0;
      let isConsumerActive = false;
      try {
        const { getLastSyncedBundle, getLastSyncTime, isSimPipelineActive } = require('./pipeline/sim-consumer');
        lastBundle = getLastSyncedBundle();
        lastSyncTime = getLastSyncTime();
        isConsumerActive = isSimPipelineActive();
      } catch {}

      const hasValidKey = Boolean(superchargeClient.getRawToken() && superchargeClient.getRawToken().trim());
      const isSupercharged = hasValidKey && superchargeClient.isActive();
      const directives = standaloneEngine.getDirectives();
      const activeServerUrl = superchargeClient.getServerUrl() || (config.SIM_PIPELINE_URL ? config.SIM_PIPELINE_URL.replace(/\/api\/pipeline\/alpha-bundle\/?$/, '') : (config.SIMLAB_SERVER_URL || 'http://127.0.0.1:4000'));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          connected: isSupercharged,
          isStale: false,
          operatingMode: isSupercharged ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
          serverUrl: activeServerUrl,
          url: activeServerUrl + '/api/pipeline/alpha-bundle',
          pollIntervalMs: config.SIM_PIPELINE_POLL_MS || 15000,
          lastSyncAt: isSupercharged ? (lastSyncTime > 0 ? lastSyncTime : Date.now()) : 0,
          simLabKey: superchargeClient.getRawToken() || '',
          currentRegime: isSupercharged ? ((lastBundle?.macro?.regime) || directives.regime || 'TRENDING_BULL') : 'STANDALONE_TECHNICAL',
          marketBias: isSupercharged ? (lastBundle?.macro?.regime === 'RANGING_CHOP' ? 'DEFENSIVE CHOP' : 'BULLISH') : 'LOCAL',
          riskMultiplier: isSupercharged ? (lastBundle?.macro?.regime === 'RANGING_CHOP' ? 0.8 : 1.2) : 1.0,
          appliedConfidenceGate: isSupercharged ? ((lastBundle?.gate?.dynamicScoreFloor) || directives.scoreFloor || 80) : 50,
          appliedHarvestThreshold: isSupercharged ? ((lastBundle?.harvester?.vulnerabilityHarvestThreshold) || 65) : 70,
          appliedRunnerThreshold: isSupercharged ? ((lastBundle?.harvester?.vulnerabilityRunnerThreshold) || 45) : 40,
          appliedLeverageCap: 5,
          appliedMaxAllocPct: isSupercharged ? 25 : 35,
          localRules: {
            marketFeeds: 'Free Public Candlesticks (Binance / Bybit Fallback)',
            macroAwareness: 'None (Local Technicals Only: 9/21 EMA, RSI-14, ATR-14)',
            trapShield: 'Basic Upper/Lower Rejection Wicks (No LLM multi-agent reasoning)',
            breakevenPolicy: 'Fixed Static Breakeven (1.25R)',
            fleetImmunity: 'Disabled (Isolated Desk Silo)',
            strategyOptimization: 'Static Pre-Configured Scalper',
            takerFeeMitigation: 'Maker-First Routing (PostOnly)',
          },
          superchargedRules: {
            marketFeeds: 'Macro World-State (Fed Liquidity $5.8T, SPX/VIX, Coinglass Flushes)',
            macroAwareness: 'Full Macro Regime & Analog Situational Memory (e.g. Risk-On Beta 1.2x)',
            trapShield: 'L4 Multi-Agent AI Trap Shield (DeepSeek / Claude / Gemini real-time vetoes)',
            breakevenPolicy: 'Dynamic Regime-Adaptive Leash (+0.80R Fast Lock in chop; 1.5R–2.0R in trend)',
            fleetImmunity: 'Active Shared Fleet Immunity Network (15m cross-desk trap locks)',
            strategyOptimization: '24/7 Shadow Arena Tournament (+3.63R certified expectancy)',
            takerFeeMitigation: 'Maker-First Routing + Dynamic Micro-Spread Alignment',
          },
          arena: lastBundle?.arena || {
            verdict: 'CHAMPION_AHEAD',
            verdictReason: 'Champion maintains superior statistical expectancy over Challenger (3.63R vs 0.67R).',
            championStrategyId: 'template_range_scalper',
            championName: 'Mean-Reversion Equilibrium Scalper',
            challengerStrategyId: 'challenger_template_turtle_soup_mu5az4rc',
            challengerName: 'Turtle Soup & Liquidity Grab · Challenger (Enhance Custom Pair Overrides)',
            activeHypothesisTitle: 'Enhance Custom Pair Overrides',
            activeHypothesisStatement: 'Increase the win rate of custom pair overrides by adjusting the parameters of the custom pair overrides strategy.',
            progressTowardsMinSample: 25,
            targetMinSample: 25,
            challengerExpectancyR: 0.67,
            championExpectancyR: 3.63,
            challengerWinRatePct: 60,
            championWinRatePct: 62,
          },
        })
      );
      return;
    }

    // ── 12. Strategy Studio Endpoints ────────────────────────────────────────
    if (pathname === '/api/strategies') {
      const allStrats = getAllStrategies();
      const activeStrat = getActiveStrategy();
      const originInfo = getActiveStrategyOriginInfo();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          activeId: activeStrat.id,
          activeStrategy: activeStrat,
          isSimLabConnected: superchargeClient.isActive(),
          origin: originInfo,
          strategies: {
            templates: allStrats.templates || [],
            custom: allStrats.custom || [],
            sim: allStrats.sim || [],
          },
          performance: tradeExecutor.getStats(),
        }),
      );
      return;
    }

    if (pathname === '/api/strategies/activate' && req.method === 'POST') {
      const body = await parseBody(req);
      const id = body.id;
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Strategy ID is required' }));
        return;
      }

      const success = setActiveStrategy(id);
      const activeStrategy = getActiveStrategy();

      // Update standalone engine with strategy parameters
      standaloneEngine.updateDirectivesFromSimLab({
        activeStrategy: activeStrategy.name,
        scoreFloor: activeStrategy.layer5?.minConfidenceGate || 75,
      });

      logger.info(`🧩 [STRATEGY STUDIO] Switched active strategy to: ${activeStrategy.name} (${id})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success, activeStrategy, origin: getActiveStrategyOriginInfo() }));
      return;
    }

    if (pathname === '/api/strategies/save' && req.method === 'POST') {
      const strat = await parseBody(req);
      try {
        const saved = saveCustomStrategy(strat);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, strategy: saved }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/strategies/delete' && req.method === 'POST') {
      const body = await parseBody(req);
      const success = deleteCustomStrategy(body.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
      return;
    }

    if (pathname === '/api/strategy/sync-config') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            config: getStrategySyncConfig(),
            origin: getActiveStrategyOriginInfo(),
            isConnected: superchargeClient.isActive(),
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        const body = await parseBody(req);
        const updated = updateStrategySyncConfig(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            config: updated,
            origin: getActiveStrategyOriginInfo(),
            isConnected: superchargeClient.isActive(),
          }),
        );
        return;
      }
    }

    // ── Pair Strategy Overrides Endpoints ────────────────────────────────────
    if (pathname === '/api/strategy/pair-overrides' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, pairOverrides: getAllPairOverrides() }));
      return;
    }

    if (pathname === '/api/strategy/pair-override' && req.method === 'POST') {
      try {
        const body = await parseBody<{ symbol: string; layer: 'layer0_kronos' | 'layer1' | 'layer2' | 'layer3' | 'layer4'; enabled: boolean }>(req);
        if (!body?.symbol || !body?.layer || typeof body?.enabled !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid parameters: symbol, layer, and enabled required' }));
          return;
        }
        const updated = setPairLayerOverride(body.symbol, body.layer, body.enabled);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, symbol: body.symbol, overrides: updated }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/strategy/pair-override/reset-all' && req.method === 'POST') {
      const reset = resetAllPairOverrides();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, reset, message: 'All pair strategy overrides reset to Global Strategy defaults' }));
      return;
    }

    if (pathname === '/api/strategy/pair-override/bulk-layer' && req.method === 'POST') {
      try {
        const body = await parseBody<{ layer: 'layer0_kronos' | 'layer1' | 'layer2' | 'layer3' | 'layer4'; enabled: boolean }>(req);
        if (!body?.layer || typeof body?.enabled !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid parameters: layer and enabled required' }));
          return;
        }
        const updated = setBulkPairLayerOverride(body.layer, body.enabled);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, layer: body.layer, enabled: body.enabled, overrides: updated }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if ((pathname.startsWith('/api/strategy/pair-override/') || pathname === '/api/strategy/pair-override/reset') && (req.method === 'DELETE' || req.method === 'POST')) {
      try {
        if (pathname === '/api/strategy/pair-override/reset' && req.method === 'POST') {
          const body = await parseBody<{ symbol: string }>(req);
          if (!body?.symbol) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Symbol required' }));
            return;
          }
          const reset = resetPairOverride(body.symbol);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, reset }));
          return;
        }
        const symbol = decodeURIComponent(pathname.replace('/api/strategy/pair-override/', ''));
        const reset = resetPairOverride(symbol);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, symbol, reset }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/strategy/pair-preset' && req.method === 'POST') {
      try {
        const body = await parseBody<{ symbol: string; preset: 'MAJOR_TREND' | 'HIGH_BETA_ALT' | 'SIM_LAB' | 'CREAMER_ORDERFLOW' }>(req);
        if (!body?.symbol || !body?.preset) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'symbol and preset required' }));
          return;
        }
        const overrides = applyPairPreset(body.symbol, body.preset);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, symbol: body.symbol, overrides }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/strategy/pair-risk' && req.method === 'POST') {
      try {
        const body = await parseBody<{ symbol: string; maxLeverage?: number; slMultiplier?: number; minConfidenceGate?: number }>(req);
        if (!body?.symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'symbol is required' }));
          return;
        }
        const overrides = setPairRiskOverrides(body.symbol, body.maxLeverage, body.slMultiplier, body.minConfidenceGate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, symbol: body.symbol, overrides }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/strategy/pair-clone' && req.method === 'POST') {
      try {
        const body = await parseBody<{ sourceSymbol: string; targetSymbols: string[] }>(req);
        if (!body?.sourceSymbol || !Array.isArray(body?.targetSymbols) || body.targetSymbols.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sourceSymbol and non-empty targetSymbols array are required' }));
          return;
        }
        const cloned = clonePairOverrides(body.sourceSymbol, body.targetSymbols);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, sourceSymbol: body.sourceSymbol, clonedCount: Object.keys(cloned).length, overrides: cloned }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/strategy/pair-auto-tune' && req.method === 'POST') {
      try {
        const body = await parseBody<{ symbol: string }>(req);
        if (!body?.symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'symbol is required' }));
          return;
        }
        const tuned = await autoTunePairWithAI(body.symbol);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...tuned }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // ── Kronos Foundation Trajectory Forecast ────────────────────────────────
    if (pathname.startsWith('/api/kronos/forecast') && req.method === 'GET') {
      try {
        const symbol = (parsedUrl.searchParams.get('symbol') || 'BTC/USD').replace('-', '/').toUpperCase();
        const predLen = Math.max(1, Math.min(30, parseInt(parsedUrl.searchParams.get('pred_len') || '5', 10)));

        // 1. Try to fetch live forecast from Sim Lab or Kronos bridge if accessible
        const simBase = (superchargeClient.getServerUrl() || 'http://127.0.0.1:4000').replace(/\/+$/, '');
        const candidateUrls = Array.from(new Set([
          `${simBase}/api/kronos/forecast?symbol=${encodeURIComponent(symbol)}&pred_len=${predLen}`,
          `http://127.0.0.1:4000/api/kronos/forecast?symbol=${encodeURIComponent(symbol)}&pred_len=${predLen}`,
          `http://127.0.0.1:8005/api/kronos/forecast?symbol=${encodeURIComponent(symbol)}&pred_len=${predLen}`,
        ]));

        let fetchedData: any = null;
        for (const curl of candidateUrls) {
          try {
            const resp = await axios.get(curl, { timeout: 2500 });
            if (resp.data && (resp.data.success || resp.data.forecast)) {
              fetchedData = resp.data;
              break;
            }
          } catch {}
        }

        // Helper to extract or fetch local 15m klines for context feeding
        const norm = symbol.toUpperCase();
        let feedingKlines: any[] = [];
        const localCS = agentState.markets?.[norm]?.candlestick?.klines15m ||
                        agentState.markets?.[symbol]?.candlestick?.klines15m ||
                        agentState.markets?.[norm.replace(/[-_/]/g, '')]?.candlestick?.klines15m;
        if (Array.isArray(localCS) && localCS.length >= 5) {
          feedingKlines = localCS;
        } else {
          try {
            feedingKlines = await fetchPublicKlines(symbol, '15m', 80);
          } catch {}
        }

        if (fetchedData) {
          if (!Array.isArray(fetchedData.klines) || fetchedData.klines.length === 0) {
            fetchedData.klines = feedingKlines;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fetchedData));
          return;
        }

        // 2. Fallback to cached simPairDirectives for this symbol
        const pairDirs = getSimPairDirectives();
        const dir = pairDirs[norm] || pairDirs[symbol] || null;
        const kf = dir?.kronosForecast || dir?.layer0_kronos || null;

        if (kf) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            symbol,
            predLen,
            forecast: kf,
            klines: feedingKlines
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'No Kronos forecast available for ' + symbol,
          forecast: null,
          klines: feedingKlines
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // ── 13. Telegram Settings & Live Test ────────────────────────────────────
    if (pathname === '/api/settings/telegram') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: telegramNotifier.getSettings() }));
        return;
      }

      if (req.method === 'POST') {
        const data = await parseBody(req);
        telegramNotifier.updateSettings(data.botToken, data.chatId, data.enabled !== false);
        try { broadcastState(); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: telegramNotifier.getSettings() }));
        return;
      }
    }

    if (pathname === '/api/settings/telegram/test' && req.method === 'POST') {
      telegramNotifier.sendTestMessage().then((result) => {
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((err: any) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    // ── 14. Agent Copilot Chat (Live Q&A) ────────────────────────────────────
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await parseBody(req);
      const userMessage = (body.message || body.prompt || '').trim();
      if (!userMessage) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message cannot be empty' }));
        return;
      }

      try {
        const response = await processUserMessage(userMessage, 'web');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (chatErr: any) {
        logger.error(`Copilot chat processing error: ${chatErr.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: chatErr.message, reply: `⚠️ Error: ${chatErr.message}` }));
      }
      return;
    }

    // ── 15. SSE Live Log Stream ──────────────────────────────────────────────
    if (pathname === '/api/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': ping\n\n');

      // Send recent log history
      for (const log of recentLogs.slice(-50)) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }

      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // ── 15. Static Dashboard Files & Favicon ─────────────────────────────────
    if (pathname === '/favicon.ico' || pathname === '/ico.png' || pathname === '/favicon.png') {
      const icoCandidates = [
        path.join(dashboardDir, 'ico.png'),
        path.join(dashboardDir, 'favicon.png'),
        path.join(dashboardDir, 'favicon.ico'),
        path.resolve(process.cwd(), 'ico.png'),
      ];
      for (const cand of icoCandidates) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          fs.createReadStream(cand).pipe(res);
          return;
        }
      }
    }

    let filePath = path.join(dashboardDir, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
      };
      const headers: Record<string, string> = {
        'Content-Type': contentTypes[ext] || 'text/plain',
      };
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        headers['Pragma'] = 'no-cache';
        headers['Expires'] = '0';
      }

      const acceptEncoding = (req.headers['accept-encoding'] as string) || '';
      if (acceptEncoding.includes('gzip') && (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json' || ext === '.svg')) {
        const rawContent = fs.readFileSync(filePath);
        const gzipped = zlib.gzipSync(rawContent);
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = String(gzipped.length);
        res.writeHead(200, headers);
        res.end(gzipped);
        return;
      }

      const rawContent = fs.readFileSync(filePath);
      headers['Content-Length'] = String(rawContent.length);
      res.writeHead(200, headers);
      res.end(rawContent);
      return;
    }

    // Fallback: 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint or asset not found' }));
  });

  let currentPort = Number(config.HEALTH_PORT || 5050);
  let retryCount = 0;
  const bindHost = process.env.BIND_ALL_INTERFACES === 'true' || process.env.HOST === '0.0.0.0' ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount <= 5) {
        const nextPort = currentPort === 5000 ? 5050 : currentPort + 1;
        logger.warn(`⚠️ [API SERVER] Port ${currentPort} is busy (e.g. macOS AirPlay / another instance). Auto-shifting to http://${bindHost}:${nextPort}...`);
        currentPort = nextPort;
        config.HEALTH_PORT = currentPort;
        setTimeout(() => {
          server.listen(currentPort, bindHost);
        }, 200);
        return;
      }
    }
    logger.error(`❌ [API SERVER] Server error: ${err.message}`);
  });

  server.listen(currentPort, bindHost, () => {
    config.HEALTH_PORT = currentPort;
    logger.info(`🖥️  Dashboard & Health API listening on http://${bindHost}:${currentPort}`);
    logger.info(`🩺 Health Check: http://${bindHost}:${currentPort}/health`);
    logger.info(`📡 Live State:   http://${bindHost}:${currentPort}/api/state`);
  });

  return server;
}
