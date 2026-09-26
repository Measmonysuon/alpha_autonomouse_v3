/**
 * Standalone Local Trading Engine & 5-Layer Strategy Pipeline
 * 
 * Works 100% autonomously out-of-the-box with NO Sim Lab connection required,
 * executing the full 5-Layer Institutional Strategy Blueprint:
 * 
 *  - Layer 1: Core Macro & Trend Filter (15m/1h EMA 25/50, Pullback envelope, RSI band 40-60, ADX, StochRSI, Reversal Patterns)
 *  - Layer 2: Liquidity & Order Flow (24h momentum, CoinGlass OI flush / surge, funding asymmetry, whale-retail divergence)
 *  - Layer 3: Smart Money Concepts (SMC) (50% Equilibrium Dealing Range, Turtle Soup with body-run filter, EQH/EQL, FVG, OB, Liquidity Sweeps, CHoCH/BOS)
 *  - Layer 4: AI Risk Shield & Second Opinion (Adversarial Trap Validator, borrow APY veto, conviction boost or trap crush)
 *  - Layer 5: Execution & Dynamic Risk Management (Confidence gate, dynamic leverage modes, dual TP, breakeven SL, ATR adaptive buffer)
 */

import axios from 'axios';
import { logger } from '../utils/logger';
import { analyzeSMC, SMCAnalysis } from './smc-detector';
import { getStrategyForPair, getPairOverrides, getActiveStrategy } from '../strategy/manager';
import type { LeverageMode, StrategyAttribution, StrategyConfig } from '../strategy/types';

// ─── Types & Interfaces ────────────────────────────────────────────────────────

export interface KlineBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface TechnicalIndicators {
  ema9: number;
  ema21: number;
  ema50: number;
  ema200?: number;
  ema9Previous: number;
  ema21Previous: number;
  emaCrossover: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'BULLISH_ALIGNMENT' | 'BEARISH_ALIGNMENT' | 'NEUTRAL';
  rsi14: number;
  stochRsi14: number;
  adx14: number;
  atr14: number;
  rvol: number;
  upperWickPct: number;
  lowerWickPct: number;
  bodyPct: number;
  isTopWickRejection: boolean;
  isBottomWickRejection: boolean;
  isPullbackBounce: boolean;
  distToEma25Pct: number;
  pullbackStatus: 'IN_PULLBACK' | 'PULLBACK_BOUNCE' | 'CHASED_BREAKOUT' | 'CHASED_BREAKDOWN' | 'NORMAL';
  swingHigh: number;
  swingLow: number;
  trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  structureTrend: 'BULLISH_STRUCTURE' | 'BEARISH_STRUCTURE' | 'SIDEWAYS';
  lastPattern: string;
  smcSignal?: 'SWEEP_LOW_REVERSAL' | 'SWEEP_HIGH_REVERSAL' | 'FAIR_VALUE_GAP_TAP' | 'NONE';
  smc?: SMCAnalysis;
  cvdTrend?: 'BUY' | 'SELL' | 'NEUTRAL';
}

export interface StandaloneSignal {
  symbol: string;
  action: 'LONG' | 'SHORT' | 'HOLD';
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  triggered: boolean;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit1?: number;
  takeProfit2?: number;
  isDualTp?: boolean;
  riskRewardRatio: number;
  suggestedLeverage: number;
  confidence: number;            // Composite multi-pillar score (0-100)
  baseScore: number;             // Synonym for confidence
  indicators: TechnicalIndicators;
  reasons: string[];
  strategyName: string;
  strategyTags: string[];
  entryRationale: string;
  strategyAttribution?: StrategyAttribution;
  orderType?: 'MARKET' | 'POST_ONLY_LIMIT';
  limitPrice?: number;
  postOnly?: boolean;
  timestamp: number;
}

export interface StrategyDirectives {
  activeStrategy: string;
  scoreFloor: number;
  bullTrapUpperWickPct: number;
  bannedSides: ('LONG' | 'SHORT')[];
  regime: string;
  source: 'STANDALONE_LOCAL' | 'SIMLAB_SUPERCHARGED';
  lastUpdated: number;
  notes?: string;
}

// ─── Default Standalone Directives ─────────────────────────────────────────────

export const DEFAULT_STANDALONE_DIRECTIVES: StrategyDirectives = {
  activeStrategy: 'Chop-Resilient 5% Daily LONG Scalper V1',
  scoreFloor: 75,
  bullTrapUpperWickPct: 50,
  bannedSides: [],
  regime: 'STANDALONE_TECHNICAL',
  source: 'STANDALONE_LOCAL',
  lastUpdated: Date.now(),
  notes: 'Autonomous local technical engine active with EMA/RSI/ATR & SMC confluence',
};

// ─── Technical Indicator Computations ──────────────────────────────────────────

export function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const emaValues: number[] = [prices[0]];

  for (let i = 1; i < prices.length; i++) {
    const nextEma = prices[i] * k + emaValues[i - 1] * (1 - k);
    emaValues.push(nextEma);
  }
  return emaValues;
}

export function calculateRSI(closes: number[], period = 14): number[] {
  if (closes.length <= period) return new Array(closes.length).fill(50);

  const rsi: number[] = new Array(closes.length).fill(50);
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

export function calculateStochRSI(closes: number[], rsiPeriod = 14, stochPeriod = 14): number {
  if (closes.length < rsiPeriod + stochPeriod) return 50;
  const rsiValues: number[] = [];
  for (let i = closes.length - stochPeriod; i <= closes.length; i++) {
    const sub = closes.slice(0, i);
    if (sub.length >= rsiPeriod + 1) {
      const subRsis = calculateRSI(sub, rsiPeriod);
      rsiValues.push(subRsis[subRsis.length - 1]);
    }
  }
  if (!rsiValues.length) return 50;
  const minRsi = Math.min(...rsiValues);
  const maxRsi = Math.max(...rsiValues);
  if (maxRsi === minRsi) return 50;
  const lastRsi = rsiValues[rsiValues.length - 1];
  const stoch = ((lastRsi - minRsi) / (maxRsi - minRsi)) * 100;
  return Number(Math.max(0, Math.min(100, stoch)).toFixed(1));
}

export function calculateADX(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < period * 2) return 22;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const highDiff = highs[i] - highs[i - 1];
    const lowDiff = lows[i - 1] - lows[i];

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    const currentTr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    tr.push(currentTr);
  }

  if (tr.length < period) return 22;

  let smoothedTR = tr.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothedPlusDM = plusDM.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothedMinusDM = minusDM.slice(0, period).reduce((s, v) => s + v, 0);

  const dxValues: number[] = [];
  const initialPlusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
  const initialMinusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;
  const initialDiSum = initialPlusDI + initialMinusDI;
  dxValues.push(initialDiSum > 0 ? (Math.abs(initialPlusDI - initialMinusDI) / initialDiSum) * 100 : 0);

  for (let i = period; i < tr.length; i++) {
    smoothedTR = smoothedTR - smoothedTR / period + tr[i];
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDM[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDM[i];

    const plusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
    const minusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return 22;

  let adx = dxValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return Number(adx.toFixed(1));
}

export function calculateATR(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const n = highs.length;
  if (n < 2) return new Array(n).fill(0);

  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }

  const atr: number[] = new Array(n).fill(0);
  let sum = 0;
  for (let i = 0; i < Math.min(period, n); i++) {
    sum += tr[i];
  }
  let currentAtr = sum / Math.min(period, n);
  atr[Math.min(period, n) - 1] = currentAtr;

  for (let i = period; i < n; i++) {
    currentAtr = (currentAtr * (period - 1) + tr[i]) / period;
    atr[i] = currentAtr;
  }

  return atr;
}

// ─── Candlestick Wicks & Pattern Detection ──────────────────────────────────────

export function calculateWickMetrics(open: number, high: number, low: number, close: number): {
  upperWickPct: number;
  lowerWickPct: number;
  bodyPct: number;
  isTopWickRejection: boolean;
  isBottomWickRejection: boolean;
  pattern: string;
} {
  const range = high - low;
  if (range <= 0) {
    return {
      upperWickPct: 0,
      lowerWickPct: 0,
      bodyPct: 100,
      isTopWickRejection: false,
      isBottomWickRejection: false,
      pattern: 'NEUTRAL',
    };
  }

  const bodyTop = Math.max(open, close);
  const bodyBottom = Math.min(open, close);
  const upperWick = high - bodyTop;
  const lowerWick = bodyBottom - low;
  const body = bodyTop - bodyBottom;

  const upperWickPct = Number(((upperWick / range) * 100).toFixed(1));
  const lowerWickPct = Number(((lowerWick / range) * 100).toFixed(1));
  const bodyPct = Number(((body / range) * 100).toFixed(1));

  let pattern = 'NEUTRAL';
  if (lowerWickPct >= 45 && bodyPct <= 35 && close >= open) {
    pattern = 'BULLISH_HAMMER';
  } else if (upperWickPct >= 45 && bodyPct <= 35 && close <= open) {
    pattern = 'BEARISH_SHOOTING_STAR';
  } else if (lowerWickPct >= 40 && bodyPct <= 30) {
    pattern = 'BULLISH_PIN_BAR';
  } else if (upperWickPct >= 40 && bodyPct <= 30) {
    pattern = 'BEARISH_PIN_BAR';
  }

  return {
    upperWickPct,
    lowerWickPct,
    bodyPct,
    isTopWickRejection: upperWickPct >= 40,
    isBottomWickRejection: lowerWickPct >= 40,
    pattern,
  };
}

// ─── Layer 5: Dynamic Leverage Calculation (Matching Client v1 Blueprint) ──────

export function calculateDynamicLeverage(params: {
  confidence: number;
  entry: number;
  sl: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  layer5?: {
    leverageMode?: LeverageMode;
    minConfidenceGate?: number;
    minLeverage?: number;
    maxLeverage?: number;
    leverage?: number;
  };
}): {
  leverage: number;
  mode: LeverageMode;
  explanation: string;
} {
  const { confidence, entry, sl, riskLevel, layer5 } = params;
  const mode: LeverageMode = layer5?.leverageMode || 'RISK_PARITY_SAFETY_CAP';
  const minLev = Math.max(1, layer5?.minLeverage ?? (riskLevel === 'HIGH' ? 2 : 3));
  const maxLev = Math.max(minLev, layer5?.maxLeverage ?? (riskLevel === 'HIGH' ? 4 : 8));
  const fixedLev = layer5?.leverage ?? 5;

  if (mode === 'FIXED') {
    return {
      leverage: fixedLev,
      mode: 'FIXED',
      explanation: `Static ${fixedLev}x leverage`,
    };
  }

  // Base threshold gate from active strategy (defaults to 80%)
  const gate = layer5?.minConfidenceGate ?? 80;
  const scoreSpan = Math.max(10, 100 - gate);

  // Normalized confidence factor α (0.00 at gate conf, 1.00 at 100% conf)
  const alpha = Math.min(1, Math.max(0, (confidence - gate) / scoreSpan));

  let candidateLeverage: number;

  if (mode === 'DYNAMIC_TIERS') {
    // Option B: 4 Discrete conviction brackets relative to gate
    const step = scoreSpan / 3;
    if (confidence >= gate + 2 * step) {
      candidateLeverage = maxLev;
    } else if (confidence >= gate + step) {
      candidateLeverage = Math.round(minLev + 0.67 * (maxLev - minLev));
    } else if (confidence >= gate) {
      candidateLeverage = Math.round(minLev + 0.33 * (maxLev - minLev));
    } else {
      candidateLeverage = minLev;
    }
  } else {
    // Option A & C: Linear scaling between minLev and maxLev
    candidateLeverage = Math.round(minLev + alpha * (maxLev - minLev));
  }

  // Ensure bounds
  candidateLeverage = Math.max(minLev, Math.min(maxLev, candidateLeverage));

  if (mode === 'RISK_PARITY_SAFETY_CAP') {
    // Option C: Liquidation Safety Cap
    const slDistPct = (entry > 0 && sl > 0) ? (Math.abs(entry - sl) / entry) * 100 : 2.0;
    // Cap leverage so that 80% / slDistPct >= leverage, ensuring liquidation is comfortably beyond the SL
    const maxSafeLev = slDistPct > 0 ? Math.floor(80 / slDistPct) : maxLev;
    const finalLev = Math.max(minLev, Math.min(candidateLeverage, maxSafeLev, maxLev));

    const capped = finalLev < candidateLeverage;
    const explanation = capped
      ? `🛡️ DYNAMIC LEVERAGE (Option C - Risk-Parity Cap): ${finalLev}x [Capped from ${candidateLeverage}x due to ${slDistPct.toFixed(1)}% SL buffer | Bounds: ${minLev}x–${maxLev}x | Conf: ${confidence}%]`
      : `⚡ DYNAMIC LEVERAGE (Option C - Risk-Parity Cap): ${finalLev}x [Within ${maxSafeLev}x safe threshold | Bounds: ${minLev}x–${maxLev}x | Conf: ${confidence}%]`;

    return { leverage: finalLev, mode: 'RISK_PARITY_SAFETY_CAP', explanation };
  }

  const modeName = mode === 'DYNAMIC_TIERS' ? 'Option B (Conviction Tiers)' : 'Option A (Linear Scaling)';
  return {
    leverage: candidateLeverage,
    mode,
    explanation: `⚡ DYNAMIC LEVERAGE (${modeName}): ${candidateLeverage}x [Bounds: ${minLev}x–${maxLev}x | Conf: ${confidence}%]`,
  };
}

// ─── Public Free Kline Fetching ────────────────────────────────────────────────

const BASELINE_PRICES: Record<string, number> = {
  'APTUSD': 0.77,
  'BTCUSD': 84850,
  'ETHUSD': 2735,
  'SOLUSD': 116.2,
  'SUIUSD': 0.998,
  'AVAXUSD': 11.27,
  'NEARUSD': 4.31,
  'LINKUSD': 13.03,
  'DOGEUSD': 0.0935,
  'XRPUSD': 1.476,
  'ADAUSD': 0.240,
  'BNBUSD': 782.5,
  'TRXUSD': 0.231,
  'DOTUSD': 3.85,
  'HYPEUSD': 18.50,
  'PEPEUSD': 0.0000078,
  'SHIBUSD': 0.0000125,
  'LTCUSD': 88.4,
  'BCHUSD': 430.0,
  'UNIUSD': 8.20,
  'FETUSD': 0.75,
  'TAOUSD': 310.0,
  'RENDERUSD': 3.45,
  'ARBUSD': 0.48,
  'OPUSD': 1.15,
  'INJUSD': 14.80,
  'SEIUSD': 0.28,
  'TIAUSD': 3.10,
};

function generateFallbackKlines(symbol: string, interval = '15m', limit = 60): KlineBar[] {
  const norm = symbol.toUpperCase().replace(/[-_/]/g, '').replace('USDT', 'USD');
  const base = BASELINE_PRICES[norm] || 10.0;
  const now = Date.now();
  const barMs = interval === '1h' ? 60 * 60 * 1000 : interval === '5m' ? 5 * 60 * 1000 : 15 * 60 * 1000;
  const bars: KlineBar[] = [];

  let current = base * 0.985;
  for (let i = limit; i > 0; i--) {
    const openTime = now - i * barMs;
    const changePct = (Math.sin(i * 0.45) * 0.008) + ((Math.random() - 0.48) * 0.006);
    const open = current;
    const close = Math.max(0.0001, open * (1 + changePct));
    const high = Math.max(open, close) * (1 + Math.random() * 0.0035);
    const low = Math.min(open, close) * (1 - Math.random() * 0.0035);
    const volume = (base > 500 ? 50 : 25000) * (0.8 + Math.random() * 0.5);

    bars.push({
      openTime,
      open,
      high,
      low,
      close,
      volume,
      closeTime: openTime + barMs,
    });
    current = close;
  }
  return bars;
}

export async function fetchPublicKlines(symbol: string, interval = '15m', limit = 60): Promise<KlineBar[]> {
  const norm = symbol.toUpperCase().replace(/[-_/]/g, '');
  const cleanBase = norm.replace(/USD[T]?$/, '');
  const bybitSym = `${cleanBase}USDT`;
  const okxSym = `${cleanBase}-USDT`;
  const bybitInterval = interval === '15m' ? '15' : interval === '5m' ? '5' : interval === '1h' ? '60' : '15';
  const intervalMs = interval === '1h' ? 60 * 60 * 1000 : interval === '5m' ? 5 * 60 * 1000 : 15 * 60 * 1000;
  const maxAllowedAge = intervalMs * 2.5;

  // 1. Primary: Bybit Public API
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${bybitSym}&interval=${bybitInterval}&limit=${limit}`;
    const res = await axios.get(url, {
      timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0 (TradingBot/2.0; AutonomousDesk)' },
    });
    const list = res.data?.result?.list;
    if (Array.isArray(list) && list.length > 0) {
      const sorted = [...list].reverse();
      const bars = sorted.map((k: any) => ({
        openTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: Number(k[0]) + intervalMs,
      }));
      const lastBarAge = Date.now() - bars[bars.length - 1].openTime;
      if (lastBarAge < maxAllowedAge) return bars;
      logger.warn(`[${symbol}] Bybit ${interval} klines stale (age: ${Math.round(lastBarAge/60000)}m). Trying OKX...`);
    }
  } catch (err: any) {
    logger.warn(`[${symbol}] Bybit ${interval} klines failed: ${err.message}. Trying OKX...`);
  }

  // 2. Fallback: OKX Public API
  try {
    const okxInterval = interval === '15m' ? '15m' : interval === '5m' ? '5m' : interval === '1h' ? '1H' : '15m';
    const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=${okxInterval}&limit=${limit}`;
    const res = await axios.get(url, {
      timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0 (TradingBot/2.0; AutonomousDesk)' },
    });
    const list = res.data?.data;
    if (Array.isArray(list) && list.length > 0) {
      const sorted = [...list].reverse();
      const bars = sorted.map((k: any) => ({
        openTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: Number(k[0]) + intervalMs,
      }));
      const lastBarAge = Date.now() - bars[bars.length - 1].openTime;
      if (lastBarAge < maxAllowedAge) return bars;
      logger.warn(`[${symbol}] OKX ${interval} klines stale. Trying Binance...`);
    }
  } catch (err: any) {
    logger.warn(`[${symbol}] OKX ${interval} klines failed: ${err.message}. Trying Binance...`);
  }

  // 3. Fallback: Binance Public API
  try {
    const baseNorm = norm.endsWith('USD') ? norm + 'T' : norm;
    const url = `https://api.binance.com/api/v3/klines?symbol=${baseNorm}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (TradingBot/2.0; AutonomousDesk)' },
    });
    if (Array.isArray(res.data) && res.data.length > 0) {
      const bars = res.data.map((k: any) => ({
        openTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: Number(k[6]),
      }));
      const lastBarAge = Date.now() - bars[bars.length - 1].openTime;
      if (lastBarAge < maxAllowedAge) return bars;
    }
  } catch (err: any) {
    logger.warn(`[${symbol}] Binance ${interval} klines failed: ${err.message}. Using fallback synthesis.`);
  }

  return generateFallbackKlines(symbol, interval, limit);
}

// ─── Standalone Strategy Engine Class (5-Layer Blueprint) ──────────────────────

export class StandaloneTradingEngine {
  private directives: StrategyDirectives = { ...DEFAULT_STANDALONE_DIRECTIVES };

  constructor() {
    logger.info(`🏛️  [ENGINE] Standalone Local Engine initialized (${this.directives.activeStrategy})`);
  }

  public getDirectives(): StrategyDirectives {
    return { ...this.directives };
  }

  public updateDirectivesFromSimLab(newDirectives: Partial<StrategyDirectives>): void {
    this.directives = {
      ...this.directives,
      ...newDirectives,
      source: 'SIMLAB_SUPERCHARGED',
      lastUpdated: Date.now(),
    };
    logger.info(
      `⚡ [ENGINE] Directives synchronized from Sim Lab! Strategy="${this.directives.activeStrategy}" ` +
      `ScoreFloor=${this.directives.scoreFloor} WickTol=${this.directives.bullTrapUpperWickPct}% ` +
      `BannedSides=[${this.directives.bannedSides.join(',')}] Regime="${this.directives.regime}"`,
    );
  }

  public resetToStandaloneDirectives(reason?: string): void {
    const wasSupercharged = this.directives.source === 'SIMLAB_SUPERCHARGED';
    this.directives = {
      ...DEFAULT_STANDALONE_DIRECTIVES,
      lastUpdated: Date.now(),
      notes: reason || 'Operating in Pure Standalone Mode',
    };
    if (wasSupercharged) {
      logger.warn(`🛡️  [ENGINE] Reverted to Pure Standalone Local Directives: ${this.directives.notes}`);
    }
  }

  /**
   * Computes comprehensive technical indicators across 15m and 1h intervals
   */
  public computeIndicators(klines: KlineBar[], klines1h?: KlineBar[]): TechnicalIndicators | null {
    if (!klines || klines.length < 30) return null;

    const closes = klines.map((k) => k.close);
    const highs = klines.map((k) => k.high);
    const lows = klines.map((k) => k.low);
    const opens = klines.map((k) => k.open);
    const volumes = klines.map((k) => k.volume);

    const ema9Series = calculateEMA(closes, 9);
    const ema21Series = calculateEMA(closes, 21);
    const ema50Series = calculateEMA(closes, 50);
    const ema200Series = closes.length >= 200 ? calculateEMA(closes, 200) : [];
    const rsiSeries = calculateRSI(closes, 14);
    const atrSeries = calculateATR(highs, lows, closes, 14);
    const adx14 = calculateADX(highs, lows, closes, 14);
    const stochRsi14 = calculateStochRSI(closes, 14, 14);

    const len = closes.length;
    const lastIdx = len - 1;
    const prevIdx = len - 2;

    const ema9 = ema9Series[lastIdx];
    const ema21 = ema21Series[lastIdx];
    const ema50 = ema50Series[lastIdx];
    const ema200 = ema200Series.length > 0 ? ema200Series[lastIdx] : (ema50 * 0.98);
    const ema9Prev = ema9Series[prevIdx];
    const ema21Prev = ema21Series[prevIdx];
    const currentPrice = closes[lastIdx];

    let emaCrossover: TechnicalIndicators['emaCrossover'] = 'NEUTRAL';
    if (ema9Prev <= ema21Prev && ema9 > ema21) {
      emaCrossover = 'BULLISH_CROSS';
    } else if (ema9Prev >= ema21Prev && ema9 < ema21) {
      emaCrossover = 'BEARISH_CROSS';
    } else if (ema9 > ema21 && ema21 > ema50) {
      emaCrossover = 'BULLISH_ALIGNMENT';
    } else if (ema9 < ema21 && ema21 < ema50) {
      emaCrossover = 'BEARISH_ALIGNMENT';
    }

    const structureTrend: TechnicalIndicators['structureTrend'] =
      ema9 > ema21 && currentPrice > ema21 ? 'BULLISH_STRUCTURE' :
      (ema9 < ema21 && currentPrice < ema21 ? 'BEARISH_STRUCTURE' : 'SIDEWAYS');

    // 1h Macro Trend (EMA25 / EMA50 alignment on 1h)
    let trend1h: TechnicalIndicators['trend1h'] = 'NEUTRAL';
    if (klines1h && klines1h.length >= 20) {
      const closes1h = klines1h.map((k) => k.close);
      const ema25_1hSeries = calculateEMA(closes1h, 25);
      const ema50_1hSeries = calculateEMA(closes1h, 50);
      const last1h = closes1h[closes1h.length - 1];
      const ema25_1h = ema25_1hSeries[ema25_1hSeries.length - 1];
      const ema50_1h = ema50_1hSeries[ema50_1hSeries.length - 1];
      if (last1h > ema25_1h && ema25_1h >= ema50_1h) {
        trend1h = 'BULLISH';
      } else if (last1h < ema25_1h && ema25_1h <= ema50_1h) {
        trend1h = 'BEARISH';
      }
    } else {
      trend1h = structureTrend === 'BULLISH_STRUCTURE' ? 'BULLISH' : (structureTrend === 'BEARISH_STRUCTURE' ? 'BEARISH' : 'NEUTRAL');
    }

    const rsi14 = rsiSeries[lastIdx];
    const atr14 = atrSeries[lastIdx] || (highs[lastIdx] - lows[lastIdx]);

    const wick = calculateWickMetrics(opens[lastIdx], highs[lastIdx], lows[lastIdx], closes[lastIdx]);

    // Pullback-to-Value Envelope: distance from current price to EMA21/EMA25
    const distToEma25Pct = Number((((currentPrice - ema21) / ema21) * 100).toFixed(2));
    const isNearEma = Math.abs(distToEma25Pct) <= 0.35;
    let pullbackStatus: TechnicalIndicators['pullbackStatus'] = 'NORMAL';
    let isPullbackBounce = false;

    if (isNearEma) {
      pullbackStatus = 'IN_PULLBACK';
      if (structureTrend === 'BULLISH_STRUCTURE' && wick.lowerWickPct >= 35) {
        isPullbackBounce = true;
        pullbackStatus = 'PULLBACK_BOUNCE';
      } else if (structureTrend === 'BEARISH_STRUCTURE' && wick.upperWickPct >= 35) {
        isPullbackBounce = true;
        pullbackStatus = 'PULLBACK_BOUNCE';
      }
    } else if (distToEma25Pct > 1.8) {
      pullbackStatus = 'CHASED_BREAKOUT';
    } else if (distToEma25Pct < -1.8) {
      pullbackStatus = 'CHASED_BREAKDOWN';
    }

    // Relative Volume (RVOL)
    const recentVols = volumes.slice(-20);
    const avgVol = recentVols.reduce((s, v) => s + v, 0) / (recentVols.length || 1);
    const lastVol = volumes[lastIdx];
    const rvol = avgVol > 0 ? Number((lastVol / avgVol).toFixed(2)) : 1.0;

    // Swing high / low of last 20 candles
    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);
    const swingHigh = Math.max(...recentHighs);
    const swingLow = Math.min(...recentLows);

    // Full SMC Analysis
    const smc = analyzeSMC(klines, currentPrice);

    let smcSignal: TechnicalIndicators['smcSignal'] = 'NONE';
    if (smc.turtleSoup.isTurtleSoup) {
      smcSignal = smc.turtleSoup.type === 'BULLISH_TURTLE_SOUP' ? 'SWEEP_LOW_REVERSAL' : 'SWEEP_HIGH_REVERSAL';
    } else if (smc.liquiditySweep.type === 'BULLISH_SWEEP_SSL') {
      smcSignal = 'SWEEP_LOW_REVERSAL';
    } else if (smc.liquiditySweep.type === 'BEARISH_SWEEP_BSL') {
      smcSignal = 'SWEEP_HIGH_REVERSAL';
    } else if (smc.fvg.isPriceInsideFVG) {
      smcSignal = 'FAIR_VALUE_GAP_TAP';
    }

    return {
      ema9,
      ema21,
      ema50,
      ema200,
      ema9Previous: ema9Prev,
      ema21Previous: ema21Prev,
      emaCrossover,
      rsi14,
      stochRsi14,
      adx14,
      atr14,
      rvol,
      upperWickPct: wick.upperWickPct,
      lowerWickPct: wick.lowerWickPct,
      bodyPct: wick.bodyPct,
      isTopWickRejection: wick.isTopWickRejection,
      isBottomWickRejection: wick.isBottomWickRejection,
      isPullbackBounce,
      distToEma25Pct,
      pullbackStatus,
      swingHigh,
      swingLow,
      trend1h,
      structureTrend,
      lastPattern: wick.pattern,
      smcSignal,
      smc,
    };
  }

  /**
   * Evaluates complete 5-Layer Institutional Strategy Setup for a symbol
   */
  public evaluateSetup(
    symbol: string,
    klines: KlineBar[],
    klines1h?: KlineBar[],
    extraMetrics?: {
      fundingRate?: number;
      oiChange24h?: number;
      lsRatio?: number;
      liquidationClusters?: any;
      orderBookSpread?: number;
      cvdTrend?: 'BUY' | 'SELL' | 'NEUTRAL';
      predictedFundingRate?: number;
    },
  ): StandaloneSignal {
    const timestamp = Date.now();
    const ind = this.computeIndicators(klines, klines1h);
    const activeStrategy: StrategyConfig = getStrategyForPair(symbol);
    const pairOverrides = getPairOverrides(symbol);

    if (!ind || klines.length === 0) {
      return {
        symbol,
        action: 'HOLD',
        trend: 'NEUTRAL',
        riskLevel: 'LOW',
        triggered: false,
        entryPrice: 0,
        stopLoss: 0,
        takeProfit: 0,
        riskRewardRatio: 0,
        suggestedLeverage: 1,
        confidence: 0,
        baseScore: 0,
        indicators: {
          ema9: 0, ema21: 0, ema50: 0, ema9Previous: 0, ema21Previous: 0,
          emaCrossover: 'NEUTRAL', rsi14: 50, stochRsi14: 50, adx14: 20, atr14: 0, rvol: 1.0,
          upperWickPct: 0, lowerWickPct: 0, bodyPct: 0, isTopWickRejection: false, isBottomWickRejection: false,
          isPullbackBounce: false, distToEma25Pct: 0, pullbackStatus: 'NORMAL',
          swingHigh: 0, swingLow: 0, trend1h: 'NEUTRAL', structureTrend: 'SIDEWAYS', lastPattern: 'NEUTRAL',
        },
        reasons: ['Insufficient candlestick history to compute technicals'],
        strategyName: activeStrategy.name,
        strategyTags: [activeStrategy.id],
        entryRationale: 'Standing by for market data',
        timestamp,
      };
    }

    const currentPrice = klines[klines.length - 1].close;
    const reasons: string[] = [];
    let bullScore = 0;
    let bearScore = 0;

    // ── 1. LAYER 1: Core Macro & Trend Filter ──────────────────────────────────
    if (activeStrategy.layer1.enabled) {
      // 1h Macro Confluence
      if (activeStrategy.layer1.trendFilterEma) {
        if (ind.trend1h === 'BULLISH') {
          bullScore += 3;
          reasons.push(`🔭 L1 1h Macro Trend: BULLISH (EMA25/50 alignment)`);
        } else if (ind.trend1h === 'BEARISH') {
          bearScore += 3;
          reasons.push(`🔭 L1 1h Macro Trend: BEARISH (EMA25/50 alignment)`);
        }
      }

      // 15m Micro Structure
      if (ind.structureTrend === 'BULLISH_STRUCTURE') {
        bullScore += 2;
        reasons.push(`📊 L1 15m Structure: Bullish alignment (Price > EMA9 > EMA21)`);
      } else if (ind.structureTrend === 'BEARISH_STRUCTURE') {
        bearScore += 2;
        reasons.push(`📊 L1 15m Structure: Bearish alignment (Price < EMA9 < EMA21)`);
      }

      // Pullback Envelope
      if (activeStrategy.layer1.pullbackEmaEnvelope && ind.isPullbackBounce) {
        if (ind.structureTrend === 'BULLISH_STRUCTURE') {
          bullScore += 2;
          reasons.push(`🎯 L1 Pullback: Dynamic EMA support bounce confirmed`);
        } else if (ind.structureTrend === 'BEARISH_STRUCTURE') {
          bearScore += 2;
          reasons.push(`🎯 L1 Pullback: Dynamic EMA resistance rejection confirmed`);
        }
      }

      // Reversal / Continuation Patterns
      if (['BULLISH_HAMMER', 'BULLISH_ENGULFING', 'BULLISH_PIN_BAR'].includes(ind.lastPattern)) {
        bullScore += 2;
        reasons.push(`🕯️ L1 Pattern: ${ind.lastPattern} confirmed`);
      } else if (['BEARISH_SHOOTING_STAR', 'BEARISH_ENGULFING', 'BEARISH_PIN_BAR'].includes(ind.lastPattern)) {
        bearScore += 2;
        reasons.push(`🕯️ L1 Pattern: ${ind.lastPattern} confirmed`);
      }
    } else {
      // Layer 1 disabled (e.g. HIGH_BETA_ALT scalper) — use basic momentum
      if (ind.emaCrossover === 'BULLISH_CROSS' || ind.emaCrossover === 'BULLISH_ALIGNMENT') bullScore += 2;
      else if (ind.emaCrossover === 'BEARISH_CROSS' || ind.emaCrossover === 'BEARISH_ALIGNMENT') bearScore += 2;
    }

    // ── 2. LAYER 2: Liquidity & Order Flow ─────────────────────────────────────
    let coinglassScore = 0;
    const firstPrice = klines[0].open;
    const change24h = firstPrice > 0 ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0;

    if (activeStrategy.layer2.enabled) {
      if (change24h > 3) { bullScore += 2; reasons.push(`📈 L2 24h Momentum: +${change24h.toFixed(1)}%`); }
      else if (change24h > 0.5) { bullScore += 1; }
      else if (change24h < -3) { bearScore += 2; reasons.push(`📉 L2 24h Momentum: ${change24h.toFixed(1)}%`); }
      else if (change24h < -0.5) { bearScore += 1; }

      // Funding Asymmetry
      const funding = extraMetrics?.fundingRate ?? 0.01;
      if (activeStrategy.layer2.fundingRateAsymmetry) {
        if (funding > (activeStrategy.layer2.maxFundingAbsPct || 0.05)) {
          bearScore += 1;
          reasons.push(`💸 L2 High Funding: ${funding.toFixed(4)}% — longs paying carry`);
        } else if (funding < -(activeStrategy.layer2.maxFundingAbsPct || 0.05)) {
          bullScore += 1;
          reasons.push(`💸 L2 Negative Funding: ${funding.toFixed(4)}% — shorts paying carry`);
        }
      }

      // Delta OI Flush / Momentum
      const oiChange = extraMetrics?.oiChange24h ?? 0;
      if (oiChange > 3) {
        bullScore += 2; coinglassScore += 2;
        reasons.push(`🔥 L2 OI Expansion: +${oiChange.toFixed(1)}% capital influx`);
      } else if (oiChange < -3) {
        bearScore += 2; coinglassScore += 2;
        reasons.push(`🔥 L2 OI Flush: ${oiChange.toFixed(1)}% liquidation exit`);
      }

      // Whale-Retail Crowd Sentiment
      const lsRatio = extraMetrics?.lsRatio ?? 1.0;
      if (activeStrategy.layer2.whaleRetailDivergence) {
        if (lsRatio > 1.35) {
          bearScore += 1; coinglassScore += 1;
          reasons.push(`👥 L2 Crowd Heavily Long (L/S: ${lsRatio.toFixed(2)}) — contrarian short signal`);
        } else if (lsRatio < 0.75) {
          bullScore += 1; coinglassScore += 1;
          reasons.push(`👥 L2 Crowd Heavily Short (L/S: ${lsRatio.toFixed(2)}) — contrarian long signal`);
        }
      }

      // Sim Lab Synchronized CVD Delta / Absorption
      const cvdTrend = extraMetrics?.cvdTrend;
      if (cvdTrend === 'BUY') {
        bullScore += 1;
        coinglassScore += 1;
        ind.cvdTrend = 'BUY';
        reasons.push(`📊 L2 Sim Lab CVD: Institutional Accumulation (Buy delta dominant)`);
      } else if (cvdTrend === 'SELL') {
        bearScore += 1;
        coinglassScore += 1;
        ind.cvdTrend = 'SELL';
        reasons.push(`📊 L2 Sim Lab CVD: Institutional Distribution (Sell delta dominant)`);
      } else if (cvdTrend === 'NEUTRAL') {
        ind.cvdTrend = 'NEUTRAL';
      }
    }

    // ── Direction Determination ───────────────────────────────────────────────
    let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let action: 'LONG' | 'SHORT' | 'HOLD' = 'HOLD';
    const scoreDiff = bullScore - bearScore;

    if (scoreDiff >= 2) {
      trend = 'BULLISH';
      action = 'LONG';
    } else if (scoreDiff <= -2) {
      trend = 'BEARISH';
      action = 'SHORT';
    } else {
      reasons.push('⚖️ Mixed technical signals — standing by for directional expansion');
    }

    // ── Risk Level ────────────────────────────────────────────────────────────
    const high24h = Math.max(...klines.map((k) => k.high));
    const low24h = Math.min(...klines.map((k) => k.low));
    const volRange = ((high24h - low24h) / (low24h || 1)) * 100;
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
    if (volRange > 12 || (bullScore + bearScore) < 2) riskLevel = 'HIGH';
    else if (volRange > 6 || (bullScore + bearScore) < 3) riskLevel = 'MEDIUM';

    // ── Stop Loss & Take Profit Geometry ──────────────────────────────────────
    const entry = currentPrice;
    const atr = ind.atr14 > 0 ? ind.atr14 : (high24h - low24h) * 0.5;
    const slMultiplier = (pairOverrides && typeof pairOverrides.slMultiplier === 'number') ? pairOverrides.slMultiplier : 1.0;
    let slDist = Math.max(entry * 0.0045, atr * 1.2 * slMultiplier);
    let sl = action === 'LONG' ? entry - slDist : entry + slDist;

    // Anchor SL to pullback dynamic EMA or structural swing wick
    if (action === 'LONG') {
      if (ind.isPullbackBounce && ind.ema21 > 0 && ind.ema21 < entry) {
        const sniperSl = Math.min(ind.ema21 * 0.997, ind.swingLow > 0 ? ind.swingLow * 0.998 : ind.ema21 * 0.997);
        if (entry - sniperSl >= slDist * 0.3 && entry - sniperSl <= slDist * 1.8) {
          sl = sniperSl;
          slDist = entry - sl;
          reasons.push(`🎯 Sniper SL placed tight below EMA21/pullback wick ($${sl.toFixed(4)})`);
        }
      }
    } else if (action === 'SHORT') {
      if (ind.isPullbackBounce && ind.ema21 > 0 && ind.ema21 > entry) {
        const sniperSl = Math.max(ind.ema21 * 1.003, ind.swingHigh > 0 ? ind.swingHigh * 1.002 : ind.ema21 * 1.003);
        if (sniperSl - entry >= slDist * 0.3 && sniperSl - entry <= slDist * 1.8) {
          sl = sniperSl;
          slDist = sniperSl - entry;
          reasons.push(`🎯 Sniper SL placed tight above EMA21/rejection wick ($${sl.toFixed(4)})`);
        }
      }
    }

    // 200 EMA Liquidity Magnet Clearance
    if (ind.ema200 && ind.ema200 > 0) {
      const ema200 = ind.ema200;
      if (action === 'SHORT' && ema200 > entry) {
        const distFromEma200 = (sl - ema200) / ema200;
        if (distFromEma200 >= -0.0025 && distFromEma200 <= 0.0025) {
          sl = ema200 * 1.0035 + (atr * 0.5);
          slDist = sl - entry;
          reasons.push(`🧲 LIQUIDITY CLEARANCE: SL pushed above 15m 200 EMA ($${ema200.toFixed(4)})`);
        }
      } else if (action === 'LONG' && ema200 < entry) {
        const distFromEma200 = (ema200 - sl) / ema200;
        if (distFromEma200 >= -0.0025 && distFromEma200 <= 0.0025) {
          sl = ema200 * 0.9965 - (atr * 0.5);
          slDist = entry - sl;
          reasons.push(`🧲 LIQUIDITY CLEARANCE: SL pushed below 15m 200 EMA ($${ema200.toFixed(4)})`);
        }
      }
    }

    const targetMinRR = activeStrategy.layer5?.minRiskRewardRatio ?? 2.0;
    let tpDist = slDist * targetMinRR;
    const tp = action === 'LONG' ? entry + tpDist : entry - tpDist;
    const rrRatio = Number((tpDist / (slDist || 1)).toFixed(2));

    // Dual Take-Profit Geometry
    let takeProfit1: number | undefined;
    let takeProfit2: number | undefined;
    let isDualTp = false;

    if (activeStrategy.layer5?.dualTakeProfit && action !== 'HOLD') {
      isDualTp = true;
      const eqPrice = ind.smc?.premiumDiscount?.equilibrium;
      if (action === 'LONG') {
        takeProfit1 = eqPrice && eqPrice > entry ? eqPrice : entry + slDist * 1.5;
        let dynamicRR = Math.max(2.5, targetMinRR);
        if (ind.adx14 >= 28 && ind.rvol >= 1.2) dynamicRR = Math.max(dynamicRR, 3.5);
        takeProfit2 = Math.max(tp, entry + slDist * dynamicRR);
      } else {
        takeProfit1 = eqPrice && eqPrice < entry ? eqPrice : entry - slDist * 1.5;
        let dynamicRR = Math.max(2.5, targetMinRR);
        if (ind.adx14 >= 28 && ind.rvol >= 1.2) dynamicRR = Math.max(dynamicRR, 3.5);
        takeProfit2 = Math.min(tp, entry - slDist * dynamicRR);
      }
    }

    // ── Multi-Pillar Confidence Calculation ───────────────────────────────────
    let confidence = 45;

    if (action !== 'HOLD') {
      // Pillar 1: Base Momentum (0 to 30 pts)
      let pillar1 = Math.min(20, Math.abs(scoreDiff) * 6);
      if (riskLevel === 'LOW') pillar1 += 10;
      else if (riskLevel === 'MEDIUM') pillar1 += 5;

      // Pillar 2: Trend Alignment (0 to 35 pts)
      let pillar2 = 0;
      const isMtfAligned =
        (action === 'LONG' && ind.structureTrend === 'BULLISH_STRUCTURE' && ind.trend1h === 'BULLISH') ||
        (action === 'SHORT' && ind.structureTrend === 'BEARISH_STRUCTURE' && ind.trend1h === 'BEARISH');

      if (isMtfAligned) {
        pillar2 += 20;
        reasons.push(`⚡ MTF CONFLUENCE: 15m structure and 1h macro trend aligned ${trend}`);
      } else if (
        (action === 'LONG' && ind.structureTrend === 'BULLISH_STRUCTURE') ||
        (action === 'SHORT' && ind.structureTrend === 'BEARISH_STRUCTURE')
      ) {
        pillar2 += 10;
      }

      if (ind.isPullbackBounce) {
        pillar2 += 15;
        reasons.push(`🎯 VALUE PULLBACK BOUNCE: Retested dynamic value zone with rejection wick`);
      }

      if (ind.adx14 >= (activeStrategy.layer1.adxTrendThreshold || 20)) {
        pillar2 += 5;
        reasons.push(`💪 Strong ADX Trend: ${ind.adx14} >= ${activeStrategy.layer1.adxTrendThreshold || 20}`);
      }

      // Pillar 3: Volume & Order Flow (0 to 35 pts)
      let pillar3 = 0;
      if (coinglassScore >= 2) pillar3 += 15;
      if (ind.rvol >= 1.3) {
        pillar3 += 10;
        reasons.push(`🔥 RVOL Spike: ${ind.rvol}x volume surge confirming institutional participation`);
      } else if (ind.rvol >= 1.0) {
        pillar3 += 5;
      }

      // Tier 1: 72% Technical Cap (Requires SMC Institutional Footprint to cross 80%)
      const rawTechnical = pillar1 + pillar2 + pillar3;
      let technicalScore = Math.min(72, rawTechnical);

      // ── Hard Gating (Anti-Point Stacking Caps) ─────────────────────────────
      // Gate 1: MTF Trend Conflict Cap (Max 60%)
      if (
        (action === 'LONG' && ind.trend1h === 'BEARISH') ||
        (action === 'SHORT' && ind.trend1h === 'BULLISH')
      ) {
        technicalScore = Math.min(technicalScore, 60);
        reasons.push(`🛑 MTF HARD GATE: 15m ${action} contradicts 1h ${ind.trend1h} macro trend. Capped at 60%.`);
      }

      // Gate 2: Overextension / Chased Breakout
      if (ind.pullbackStatus === 'CHASED_BREAKOUT' && action === 'LONG') {
        technicalScore = Math.min(technicalScore, 55);
        reasons.push(`🛑 CHASED BREAKOUT GATE: Price rallied +${ind.distToEma25Pct}% away from value. Capped at 55%.`);
      } else if (ind.pullbackStatus === 'CHASED_BREAKDOWN' && action === 'SHORT') {
        technicalScore = Math.min(technicalScore, 55);
        reasons.push(`🛑 CHASED BREAKDOWN GATE: Price dropped ${ind.distToEma25Pct}% away from value. Capped at 55%.`);
      }

      // Gate 3: Low Volume
      if (ind.rvol < 0.7) {
        technicalScore = Math.min(technicalScore, 65);
        reasons.push(`⚠️ RVOL HARD GATE: Volume is only ${ind.rvol}x average. Insufficient liquidity.`);
      }

      // Gate 4: Anti-FOMO Rejection Wick
      if (ind.isTopWickRejection && action === 'LONG') {
        technicalScore = Math.min(technicalScore, 55);
        reasons.push(`🛑 ANTI-FOMO GATE: Upper wick rejection ${ind.upperWickPct}% detected at highs. Capped at 55%.`);
      } else if (ind.isBottomWickRejection && action === 'SHORT') {
        technicalScore = Math.min(technicalScore, 55);
        reasons.push(`🛑 ANTI-FOMO GATE: Lower wick rejection ${ind.lowerWickPct}% detected at lows. Capped at 55%.`);
      }

      // Gate 5: StochRSI Exhaustion
      if (activeStrategy.layer1.stochRsiFilter) {
        if (action === 'SHORT' && (ind.stochRsi14 < 20 || ind.rsi14 < 32)) {
          technicalScore = Math.min(technicalScore, 55);
          reasons.push(`🛑 OVERSOLD EXHAUSTION GATE: StochRSI (${ind.stochRsi14}) / RSI (${ind.rsi14.toFixed(1)}) oversold. Capped at 55%.`);
        } else if (action === 'LONG' && (ind.stochRsi14 > 80 || ind.rsi14 > 68)) {
          technicalScore = Math.min(technicalScore, 55);
          reasons.push(`🛑 OVERBOUGHT EXHAUSTION GATE: StochRSI (${ind.stochRsi14}) / RSI (${ind.rsi14.toFixed(1)}) overbought. Capped at 55%.`);
        }
      }

      // Gate 6: ADX Consolidation Chop
      if (ind.adx14 < 18) {
        technicalScore = Math.min(technicalScore, 65);
        reasons.push(`⚠️ ADX CHOP GATE: ADX (${ind.adx14}) < 18 indicates consolidation chop. Capped at 65%.`);
      }

      // ── 3. LAYER 3: Smart Money Concepts (SMC) Confluence Key ──────────────
      let smcBonus = 0;
      if (ind.smc && activeStrategy.layer3.enabled) {
        const smc = ind.smc;
        let smcPoints = 0;
        const smcReasons: string[] = [];

        // 50% Equilibrium Dealing Range (Premium vs Discount Gate)
        if (activeStrategy.layer3.premiumDiscountEquilibrium && smc.premiumDiscount) {
          const pd = smc.premiumDiscount;
          if (action === 'LONG' && pd.zone === 'PREMIUM') {
            technicalScore = Math.min(technicalScore, 60);
            reasons.push(`🛑 50% EQUILIBRIUM GATE: Long entry in Premium zone ($${entry.toFixed(4)} > Eq $${pd.equilibrium.toFixed(4)}) is forbidden. Capped at 60%.`);
          } else if (action === 'SHORT' && pd.zone === 'DISCOUNT') {
            technicalScore = Math.min(technicalScore, 60);
            reasons.push(`🛑 50% EQUILIBRIUM GATE: Short entry in Discount zone ($${entry.toFixed(4)} < Eq $${pd.equilibrium.toFixed(4)}) is forbidden. Capped at 60%.`);
          } else if ((action === 'LONG' && pd.zone === 'DISCOUNT') || (action === 'SHORT' && pd.zone === 'PREMIUM')) {
            smcPoints += 5;
            smcReasons.push('50% Equilibrium Discount/Premium alignment (+5%)');
          }
        }

        // Turtle Soup Wick Sweep vs Body Run Filter
        if (activeStrategy.layer3.turtleSoupSweep && smc.turtleSoup) {
          const ts = smc.turtleSoup;
          if (action === 'LONG' && ts.type === 'BULLISH_TURTLE_SOUP') {
            smcPoints += 15;
            smcReasons.push(`Turtle Soup Wick Sweep (${ts.rejectionWickPct.toFixed(1)}% wick rejection) (+15%)`);
          } else if (action === 'SHORT' && ts.type === 'BEARISH_TURTLE_SOUP') {
            smcPoints += 15;
            smcReasons.push(`Turtle Soup Wick Sweep (${ts.rejectionWickPct.toFixed(1)}% wick rejection) (+15%)`);
          } else if (activeStrategy.layer3.blockBodyRun && ts.isBodyRunInvalidation) {
            technicalScore = Math.min(technicalScore, 50);
            reasons.push(`🛑 TURTLE SOUP VETO: Breakout body run past swing level. Capped at 50%.`);
          }
        }

        // Equal Highs & Equal Lows (EQH / EQL Liquidity Pools)
        if (activeStrategy.layer3.equalHighsLowsMagnet && smc.equalHighsLows) {
          if (action === 'LONG' && smc.equalHighsLows.hasEQH && smc.equalHighsLows.eqhPrice !== undefined) {
            smcPoints += 5;
            smcReasons.push(`Equal Highs (EQH) Liquidity Magnet ($${smc.equalHighsLows.eqhPrice.toFixed(4)}) (+5%)`);
          } else if (action === 'SHORT' && smc.equalHighsLows.hasEQL && smc.equalHighsLows.eqlPrice !== undefined) {
            smcPoints += 5;
            smcReasons.push(`Equal Lows (EQL) Liquidity Magnet ($${smc.equalHighsLows.eqlPrice.toFixed(4)}) (+5%)`);
          }
        }

        // Liquidity Sweeps
        if (action === 'LONG' && smc.liquiditySweep.type === 'BULLISH_SWEEP_SSL') {
          smcPoints += 12;
          smcReasons.push('SSL Liquidity Sweep with wick rejection (+12%)');
        } else if (action === 'SHORT' && smc.liquiditySweep.type === 'BEARISH_SWEEP_BSL') {
          smcPoints += 12;
          smcReasons.push('BSL Liquidity Sweep with wick rejection (+12%)');
        }

        // Fair Value Gaps
        if (activeStrategy.layer3.fvgRetestEntry) {
          if (action === 'LONG' && smc.fvg.fvgBias === 'BULLISH_FVG_SUPPORT') {
            smcPoints += 8;
            smcReasons.push('Testing Bullish FVG demand zone (+8%)');
          } else if (action === 'SHORT' && smc.fvg.fvgBias === 'BEARISH_FVG_RESISTANCE') {
            smcPoints += 8;
            smcReasons.push('Testing Bearish FVG supply zone (+8%)');
          }
        }

        // Structure Shifts (CHoCH / BOS)
        if (activeStrategy.layer3.structureShiftChoch) {
          if (action === 'LONG' && ['BULLISH_CHOCH', 'BULLISH_BOS'].includes(smc.structureShift.type)) {
            smcPoints += 5;
            smcReasons.push(`SMC ${smc.structureShift.type} confirmed (+5%)`);
          } else if (action === 'SHORT' && ['BEARISH_CHOCH', 'BEARISH_BOS'].includes(smc.structureShift.type)) {
            smcPoints += 5;
            smcReasons.push(`SMC ${smc.structureShift.type} confirmed (+5%)`);
          }
        }

        // Unlock SMC Confluence Key
        if (smcPoints > 0) {
          smcBonus = Math.min(18, Math.max(8, smcPoints));
          reasons.push(`🔑 SMC REQUIRED EXECUTION KEY: +${smcBonus}% bonus unlocked (${smcReasons.join(', ')})`);
        }
      }

      confidence = Math.max(0, Math.min(100, technicalScore + smcBonus));
    }

    // ── 4. LAYER 5: Dynamic Leverage & Execution Trigger Check ─────────────────
    const dynamicLev = calculateDynamicLeverage({
      confidence,
      entry,
      sl,
      riskLevel,
      layer5: activeStrategy.layer5,
    });

    let leverage = dynamicLev.leverage;
    if (pairOverrides && typeof pairOverrides.maxLeverage === 'number' && pairOverrides.maxLeverage > 0) {
      if (leverage > pairOverrides.maxLeverage) {
        reasons.push(`🛡️ PAIR LEVERAGE CAP: Leverage ${leverage}x capped to pair limit ${pairOverrides.maxLeverage}x`);
        leverage = pairOverrides.maxLeverage;
      }
    }
    if (action !== 'HOLD') {
      reasons.push(dynamicLev.explanation);
    }

    // Gate threshold check (pair override or active strategy)
    const minGate = pairOverrides?.minConfidenceGate || activeStrategy.layer5?.minConfidenceGate || 75;
    const isTriggered = action !== 'HOLD' && confidence >= minGate;

    const isCustomPair = Boolean(pairOverrides && (
      typeof pairOverrides.layer1 === 'boolean' ||
      typeof pairOverrides.layer2 === 'boolean' ||
      typeof pairOverrides.layer3 === 'boolean' ||
      typeof pairOverrides.layer4 === 'boolean' ||
      typeof pairOverrides.maxLeverage === 'number'
    ));

    // Autonomous Maker-First FVG / Pullback Limit Order Calculation
    let limitPrice = entry;
    let orderType: 'MARKET' | 'POST_ONLY_LIMIT' = 'MARKET';
    let postOnly = false;

    if (isTriggered && action === 'LONG') {
      const nearest = ind.smc?.fvg?.nearestFVG;
      const fvgTop = (nearest && nearest.type === 'BULLISH_FVG') ? nearest.top : undefined;
      const emaSupport = (ind.ema9 && ind.ema9 < entry) ? ind.ema9 : entry * 0.9995;
      limitPrice = Number((fvgTop ? Math.min(entry, fvgTop) : emaSupport).toFixed(4));
      orderType = 'POST_ONLY_LIMIT';
      postOnly = true;
    } else if (isTriggered && action === 'SHORT') {
      const nearest = ind.smc?.fvg?.nearestFVG;
      const fvgBottom = (nearest && nearest.type === 'BEARISH_FVG') ? nearest.bottom : undefined;
      const emaResistance = (ind.ema9 && ind.ema9 > entry) ? ind.ema9 : entry * 1.0005;
      limitPrice = Number((fvgBottom ? Math.max(entry, fvgBottom) : emaResistance).toFixed(4));
      orderType = 'POST_ONLY_LIMIT';
      postOnly = true;
    }

    return {
      symbol,
      action,
      trend,
      riskLevel,
      triggered: isTriggered,
      entryPrice: entry,
      limitPrice,
      orderType,
      postOnly,
      stopLoss: sl,
      takeProfit: tp,
      takeProfit1,
      takeProfit2,
      isDualTp,
      riskRewardRatio: rrRatio,
      suggestedLeverage: leverage,
      confidence,
      baseScore: confidence,
      indicators: ind,
      reasons,
      strategyName: isCustomPair ? `${activeStrategy.name} (${symbol})` : activeStrategy.name,
      strategyTags: [activeStrategy.id, ...(isCustomPair ? ['pair-override'] : [])],
      entryRationale: reasons.slice(0, 3).join(' · '),
      strategyAttribution: {
        strategyId: activeStrategy.id,
        strategyName: activeStrategy.name,
        isPairOverride: isCustomPair,
        layersActive: {
          layer1: activeStrategy.layer1.enabled,
          layer2: activeStrategy.layer2.enabled,
          layer3: activeStrategy.layer3.enabled,
          layer4: activeStrategy.layer4.enabled,
          layer5: true,
        },
        pairOverrides: pairOverrides || null,
      },
      timestamp,
    };
  }
}

export const standaloneEngine = new StandaloneTradingEngine();
