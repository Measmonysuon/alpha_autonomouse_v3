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

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { analyzeSMC, SMCAnalysis } from './smc-detector';
import { getStrategyForPair, getPairOverrides, getActiveStrategy, getSimPairDirectives, getSimPairDirective } from '../strategy/manager';
import type { LeverageMode, StrategyAttribution, StrategyConfig } from '../strategy/types';
import { decibelPriceFeed } from '../pipeline/decibel-price-feed';

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
  candleColor?: 'GREEN' | 'RED' | 'DOJI';
  isTopWickRejection: boolean;
  isBottomWickRejection: boolean;
  isPullbackBounce: boolean;
  distToEma25Pct: number;
  distToFastSmaPct?: number;
  isNearFastSma?: boolean;
  pullbackStatus: 'IN_PULLBACK' | 'PULLBACK_BOUNCE' | 'CHASED_BREAKOUT' | 'CHASED_BREAKDOWN' | 'NORMAL';
  swingHigh: number;
  swingLow: number;
  trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  structureTrend: 'BULLISH_STRUCTURE' | 'BEARISH_STRUCTURE' | 'SIDEWAYS';
  lastPattern: string;
  // Dynamic Rolling-Window Top Parameter SMA Metrics
  fastSmaPeriod?: number;
  slowSmaPeriod?: number;
  smaFast?: number;
  smaSlow?: number;
  smaAlignment?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confluencePassed?: boolean;
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
  executionProfile?: 'STANDARD_SWING';
  microTargetProfitUsd?: number;
  noFixedTp?: boolean;
  exit50CloseEnabled?: boolean;
  gap30Price?: number;
  gap50Price?: number;
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
  scoreFloor: 72,
  bullTrapUpperWickPct: 50,
  bannedSides: [],
  regime: 'STANDALONE_TECHNICAL',
  source: 'STANDALONE_LOCAL',
  lastUpdated: Date.now(),
  notes: 'Autonomous local technical engine active with Dynamic 72% Conviction Gate & SMC Confluence',
};

// ─── Pair Dynamic Fast/Slow SMA Reference Profiles ─────────────────────────────
export const DYNAMIC_PAIR_SMA_PROFILES: Record<string, { fast: number; slow: number }> = {
  'BTC/USD': { fast: 10, slow: 40 },
  'ETH/USD': { fast: 12, slow: 48 },
  'SOL/USD': { fast: 9,  slow: 36 },
  'SUI/USD': { fast: 21, slow: 84 },
  'APT/USD': { fast: 10, slow: 40 },
  'DOGE/USD': { fast: 11, slow: 42 },
  'AVAX/USD': { fast: 13, slow: 46 },
  'BNB/USD': { fast: 15, slow: 56 },
  'XRP/USD': { fast: 14, slow: 50 },
  'NEAR/USD': { fast: 10, slow: 38 },
  'LINK/USD': { fast: 12, slow: 44 },
  'ADA/USD': { fast: 14, slow: 48 },
  'HYPE/USD': { fast: 8,  slow: 30 },
  'PEPE/USD': { fast: 7,  slow: 28 },
  'kPEPE/USD': { fast: 7, slow: 28 },
  'UNI/USD': { fast: 11, slow: 42 },
  'TAO/USD': { fast: 11, slow: 42 },
  'TRX/USD': { fast: 16, slow: 60 },
  'ZEC/USD': { fast: 12, slow: 44 },
  'MON/USD': { fast: 8, slow: 32 },
  'AAVE/USD': { fast: 12, slow: 46 },
  'MEGA/USD': { fast: 8, slow: 30 },
  'ENA/USD': { fast: 9, slow: 34 },
  'LIT/USD': { fast: 8, slow: 32 },
  'FARTCOIN/USD': { fast: 7, slow: 28 },
  'TRUMP/USD': { fast: 9, slow: 36 },
  'LDO/USD': { fast: 10, slow: 38 },
  'MORPHO/USD': { fast: 9, slow: 34 },
  'CHIP/USD': { fast: 7, slow: 28 },
  'PUMP/USD': { fast: 7, slow: 28 },
  'XPL/USD': { fast: 9, slow: 34 },
  'GME/USD': { fast: 8, slow: 30 },
  'WLFI/USD': { fast: 8, slow: 30 },
  'ZRO/USD': { fast: 10, slow: 38 },
  'SONY/USD': { fast: 12, slow: 44 },
  'TTWO/USD': { fast: 12, slow: 44 },
};

export function getDynamicSmaPeriodsForSymbol(symbol: string): { fast: number; slow: number } {
  if (!symbol) return { fast: 10, slow: 38 };
  const norm = symbol.toUpperCase().replace(/[-_]/g, '/');
  if (DYNAMIC_PAIR_SMA_PROFILES[norm]) return DYNAMIC_PAIR_SMA_PROFILES[norm];
  for (const [k, v] of Object.entries(DYNAMIC_PAIR_SMA_PROFILES)) {
    const base = k.replace('/USD', '');
    if (norm.startsWith(base) || norm.includes(base)) {
      return v;
    }
  }
  return { fast: 10, slow: 38 };
}

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

export function calculateSMA(prices: number[], period: number): number[] {
  if (prices.length === 0 || period <= 0) return [];
  const res: number[] = new Array(prices.length).fill(0);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i];
    if (i >= period) sum -= prices[i - period];
    if (i >= period - 1) res[i] = sum / period;
    else res[i] = sum / (i + 1);
  }
  return res;
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
  candleColor: 'GREEN' | 'RED' | 'DOJI';
  isTopWickRejection: boolean;
  isBottomWickRejection: boolean;
  pattern: string;
} {
  // Ensure bounding invariants when mark prices dynamically pin live candles
  const effectiveHigh = Math.max(high, open, close);
  const effectiveLow = Math.min(low, open, close);
  const range = effectiveHigh - effectiveLow;
  const candleColor: 'GREEN' | 'RED' | 'DOJI' = close > open ? 'GREEN' : close < open ? 'RED' : 'DOJI';
  if (range <= 0) {
    return {
      upperWickPct: 0,
      lowerWickPct: 0,
      bodyPct: 100,
      candleColor: 'DOJI',
      isTopWickRejection: false,
      isBottomWickRejection: false,
      pattern: 'NEUTRAL',
    };
  }

  const bodyTop = Math.max(open, close);
  const bodyBottom = Math.min(open, close);
  const upperWick = Math.max(0, effectiveHigh - bodyTop);
  const lowerWick = Math.max(0, bodyBottom - effectiveLow);
  const body = Math.max(0, bodyTop - bodyBottom);

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
    candleColor,
    isTopWickRejection: upperWickPct >= 40,
    isBottomWickRejection: lowerWickPct >= 40,
    pattern,
  };
}

export type PullbackConfirmationVerdict =
  | 'CONFIRMED_GREEN_REVERSAL'
  | 'CONFIRMED_ABSORPTION_WICK'
  | 'UNCONFIRMED_FALLING_KNIFE'
  | 'UNCONFIRMED_PUMP_EXHAUSTION'
  | 'UPPER_WICK_REJECTION_TRAP'
  | 'LOWER_WICK_REJECTION_TRAP'
  | 'NEUTRAL_CONFIRMED';

export interface PullbackConfirmationResult {
  isConfirmed: boolean;
  verdict: PullbackConfirmationVerdict;
  reason: string;
  capScore?: number;
}

export function evaluatePullbackConfirmation(
  action: 'LONG' | 'SHORT' | 'HOLD' | 'WAIT',
  ind?: TechnicalIndicators | null,
  options?: { isReboundActive?: boolean; dynamicWickThreshold?: number }
): PullbackConfirmationResult {
  if (!ind || action === 'HOLD' || action === 'WAIT') {
    return {
      isConfirmed: true,
      verdict: 'NEUTRAL_CONFIRMED',
      reason: 'No directional signal to validate',
    };
  }

  const isRebound = Boolean(options?.isReboundActive);
  const wickThreshold = options?.dynamicWickThreshold ?? 25;

  if (action === 'LONG') {
    if (!isRebound && (ind.isTopWickRejection || ind.upperWickPct >= 40)) {
      return {
        isConfirmed: false,
        verdict: 'UPPER_WICK_REJECTION_TRAP',
        capScore: 45,
        reason: `Upper rejection wick (${ind.upperWickPct.toFixed(1)}% >= 40%) indicates heavy overhead seller defense. Buying into rejection is strictly vetoed.`,
      };
    }

    const isRedCandle = ind.candleColor === 'RED';
    const isFastSmaRetestZoneLong = ind.isNearFastSma || (ind.distToFastSmaPct !== undefined && Math.abs(ind.distToFastSmaPct) <= 0.35);
    const effectiveWickThresholdLong = isFastSmaRetestZoneLong ? Math.min(20, wickThreshold) : wickThreshold;
    const hasBuyerAbsorption = ind.lowerWickPct >= effectiveWickThresholdLong;

    if (isRedCandle && !hasBuyerAbsorption) {
      if (isRebound && ind.lowerWickPct >= (wickThreshold * 0.7)) {
        return {
          isConfirmed: true,
          verdict: 'CONFIRMED_ABSORPTION_WICK',
          reason: `AI Rebound absorption confirmed: lower wick ${ind.lowerWickPct.toFixed(1)}% defended liquidity level.`,
        };
      }
      return {
        isConfirmed: false,
        verdict: 'UNCONFIRMED_FALLING_KNIFE',
        capScore: 45,
        reason: `Pullback in progress on active red candle without buyer absorption (lower wick ${ind.lowerWickPct.toFixed(1)}% < ${effectiveWickThresholdLong.toFixed(1)}%). Waiting for candle to close green or print absorption wick before entry.`,
      };
    }

    if (hasBuyerAbsorption) {
      return {
        isConfirmed: true,
        verdict: 'CONFIRMED_ABSORPTION_WICK',
        reason: `Buyer absorption confirmed: lower wick ${ind.lowerWickPct.toFixed(1)}% defended key support/POC.`,
      };
    }

    return {
      isConfirmed: true,
      verdict: 'CONFIRMED_GREEN_REVERSAL',
      reason: `Bullish reversal confirmed: green candle printing with buyers defending structure.`,
    };
  }

  if (action === 'SHORT') {
    if (!isRebound && (ind.isBottomWickRejection || ind.lowerWickPct >= 40)) {
      return {
        isConfirmed: false,
        verdict: 'LOWER_WICK_REJECTION_TRAP',
        capScore: 45,
        reason: `Lower rejection wick (${ind.lowerWickPct.toFixed(1)}% >= 40%) indicates aggressive buyer absorption. Shorting into support bounce is strictly vetoed.`,
      };
    }

    const isGreenCandle = ind.candleColor === 'GREEN';
    const isFastSmaRetestZoneShort = ind.isNearFastSma || (ind.distToFastSmaPct !== undefined && Math.abs(ind.distToFastSmaPct) <= 0.35);
    const effectiveWickThresholdShort = isFastSmaRetestZoneShort ? Math.min(20, wickThreshold) : wickThreshold;
    const hasSellerAbsorption = ind.upperWickPct >= effectiveWickThresholdShort;

    if (isGreenCandle && !hasSellerAbsorption) {
      if (isRebound && ind.upperWickPct >= (wickThreshold * 0.7)) {
        return {
          isConfirmed: true,
          verdict: 'CONFIRMED_ABSORPTION_WICK',
          reason: `AI Reversal seller absorption confirmed: upper wick ${ind.upperWickPct.toFixed(1)}% defended resistance level.`,
        };
      }
      return {
        isConfirmed: false,
        verdict: 'UNCONFIRMED_PUMP_EXHAUSTION',
        capScore: 45,
        reason: `Pullback rally in progress on active green candle without seller absorption (upper wick ${ind.upperWickPct.toFixed(1)}% < ${effectiveWickThresholdShort.toFixed(1)}%). Waiting for candle to close red or print rejection wick before shorting.`,
      };
    }

    if (hasSellerAbsorption) {
      return {
        isConfirmed: true,
        verdict: 'CONFIRMED_ABSORPTION_WICK',
        reason: `Seller absorption confirmed: upper wick ${ind.upperWickPct.toFixed(1)}% rejected overhead resistance.`,
      };
    }

    return {
      isConfirmed: true,
      verdict: 'CONFIRMED_GREEN_REVERSAL',
      reason: `Bearish continuation confirmed: red candle printing with sellers in control.`,
    };
  }

  return {
    isConfirmed: true,
    verdict: 'NEUTRAL_CONFIRMED',
    reason: 'Standard structure confirmed',
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
  const clientMinLev = (config as any).MIN_LEVERAGE || 10;
  const clientMaxLev = (config as any).MAX_LEVERAGE || 15;
  const minLev = Math.max(clientMinLev, layer5?.minLeverage ?? 10);
  const maxLev = Math.max(minLev, Math.min(clientMaxLev, layer5?.maxLeverage ?? 15));
  const fixedLev = Math.max(clientMinLev, Math.min(layer5?.leverage ?? clientMinLev, clientMaxLev));

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
  'APTUSD': 0.6401,
  'BTCUSD': 80497.0,
  'ETHUSD': 2428.9,
  'SOLUSD': 96.51,
  'SUIUSD': 0.9424,
  'SONYUSD': 26.11,
  'AVAXUSD': 8.75,
  'NEARUSD': 1.39,
  'LINKUSD': 11.05,
  'DOGEUSD': 0.07725,
  'XRPUSD': 1.248,
  'ADAUSD': 0.2936,
  'BNBUSD': 712.07,
  'TRXUSD': 0.3186,
  'HYPEUSD': 83.63,
  'PEPEUSD': 0.0000052,
  'UNIUSD': 7.78,
  'TAOUSD': 235.85,
  'ZECUSD': 1235.54,
  'TTWOUSD': 175.0,
  'MEGAUSD': 0.0474,
};

export function updateBaselinePrice(symbol: string, price: number): void {
  if (price > 0) {
    const norm = symbol.toUpperCase().replace(/[-_/]/g, '').replace('USDT', 'USD');
    const cleanBase = norm.replace(/USD[T]?$/, '');
    BASELINE_PRICES[norm] = price;
    BASELINE_PRICES[cleanBase] = price;
  }
}

const realKlinesCache = new Map<string, { bars: KlineBar[]; fetchedAt: number }>();

// Preloaded authentic 15m klines cache (All 34 pairs)
let preloadedAuthenticKlines: Record<string, any[]> = {};
try {
  const klinesCandidates = [
    path.resolve(process.cwd(), 'dashboard/real_klines.json'),
    path.resolve(process.cwd(), 'real_klines.json'),
    path.resolve(__dirname, '../../dashboard/real_klines.json'),
    path.resolve(__dirname, '../../../alpha-stream-broadcaster/real_klines.json'),
    '/app/dashboard/real_klines.json',
  ];
  for (const kp of klinesCandidates) {
    if (fs.existsSync(kp)) {
      preloadedAuthenticKlines = JSON.parse(fs.readFileSync(kp, 'utf8'));
      logger.info(`[StandaloneEngine] Loaded ${Object.keys(preloadedAuthenticKlines).length} authentic pairs from ${kp}`);
      break;
    }
  }
} catch (e: any) {
  logger.warn(`[StandaloneEngine] Could not preload authentic klines: ${e.message}`);
}

function generateFallbackKlines(symbol: string, interval = '15m', limit = 60): KlineBar[] {
  const norm = symbol.toUpperCase().replace(/[-_/]/g, '').replace('USDT', 'USD');
  const cleanBase = norm.replace(/USD[T]?$/, '');
  const cacheKey = `${cleanBase}_${interval}`;
  const cached = realKlinesCache.get(cacheKey);
  if (cached && cached.bars.length >= 10) {
    return cached.bars;
  }

  const base = BASELINE_PRICES[norm] || BASELINE_PRICES[cleanBase] || 10.0;
  const now = Date.now();
  const barMs = interval === '1h' ? 60 * 60 * 1000 : interval === '5m' ? 5 * 60 * 1000 : 15 * 60 * 1000;
  const bars: KlineBar[] = [];

  const atr = Math.max(base * 0.005, 0.0005);
  const seed = (cleanBase.charCodeAt(0) * 19 + (cleanBase.charCodeAt(cleanBase.length - 1) || 5)) % 100;

  // Generate realistic, natural continuous price movement ending at 'base'
  const deltas: number[] = [];
  for (let i = 0; i < limit; i++) {
    const wave = Math.sin((i + seed) * 0.42) * 0.55 + Math.cos((i + seed) * 0.95) * 0.45;
    deltas.push(wave * atr * 0.5);
  }

  let p = base;
  const prices: number[] = [base];
  for (let i = limit - 1; i > 0; i--) {
    p = Math.max(0.0001, p - deltas[i]);
    prices.unshift(p);
  }

  for (let i = 0; i < limit; i++) {
    const openTime = now - (limit - i) * barMs;
    const open = (i === 0) ? prices[0] * 0.9985 : bars[i - 1].close;
    const close = prices[i];
    const maxOC = Math.max(open, close);
    const minOC = Math.min(open, close);
    const wickHigh = Math.abs(Math.sin((i + seed) * 1.5)) * atr * 0.35;
    const wickLow = Math.abs(Math.cos((i + seed) * 1.8)) * atr * 0.35;
    const high = maxOC + wickHigh;
    const low = Math.max(0.0001, minOC - wickLow);
    const volume = 12000 + Math.floor(Math.abs(deltas[i]) * 10000);

    bars.push({
      openTime,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume,
      closeTime: openTime + barMs,
    });
  }

  return bars;
}

function reconcileWithDecibel(bars: KlineBar[], symbol: string): KlineBar[] {
  if (!bars || bars.length === 0) return bars;
  const decibelPx = decibelPriceFeed.getPrice(symbol);
  const livePx = decibelPx?.markPrice || 0;
  if (livePx > 0) {
    const lastBar = bars[bars.length - 1];
    lastBar.close = livePx;
    lastBar.high = Math.max(lastBar.high, livePx);
    lastBar.low = Math.min(lastBar.low, livePx);
  }
  return bars;
}

export async function fetchPublicKlines(symbol: string, interval = '15m', limit = 60): Promise<KlineBar[]> {
  const norm = symbol.toUpperCase().replace(/[-_/]/g, '');
  const cleanBase = norm.replace(/USD[T]?$/, '');
  const binanceSym = (cleanBase === 'KPEPE' || cleanBase === 'PEPE') ? '1000PEPEUSDT' : `${cleanBase}USDT`;
  const bybitSym = (cleanBase === 'KPEPE' || cleanBase === 'PEPE') ? '1000PEPEUSDT' : `${cleanBase}USDT`;
  const okxSym = `${cleanBase}-USDT`;
  const bybitInterval = interval === '1h' ? '60' : interval === '5m' ? '5' : interval === '15m' ? '15' : '15';
  const okxInterval = interval === '1h' ? '1H' : interval === '5m' ? '5m' : interval === '15m' ? '15m' : '15m';
  const intervalMs = interval === '1h' ? 60 * 60 * 1000 : interval === '5m' ? 5 * 60 * 1000 : 15 * 60 * 1000;
  const cacheKey = `${cleanBase}_${interval}`;
  const minRequiredBars = Math.min(limit, 5);

  // 1. In-memory cache first if fresh (< 30s for live responsive candlestick streaming)
  const existing = realKlinesCache.get(cacheKey);
  if (existing && existing.bars.length >= minRequiredBars && (Date.now() - existing.fetchedAt < 30000)) {
    return reconcileWithDecibel(existing.bars, symbol);
  }

  // 2. Primary Live Network: Binance Public API (exact same authoritative live source as Client V1 & Sim Lab)
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, {
      timeout: 4000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlphaBot/3.0)' },
    });
    if (Array.isArray(res.data) && res.data.length > 0) {
      const bars: KlineBar[] = res.data.map((k: any) => ({
        openTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: Number(k[6]),
      }));
      if (bars.length >= minRequiredBars) {
        reconcileWithDecibel(bars, symbol);
        realKlinesCache.set(cacheKey, { bars, fetchedAt: Date.now() });
        return bars;
      }
    }
  } catch (err: any) {
    logger.debug(`[${symbol}] Binance ${interval} klines: ${err.message}. Trying Bybit...`);
  }

  // 3. Secondary Network: Bybit Linear Public API (fastest, supports most crypto perps)
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${bybitSym}&interval=${bybitInterval}&limit=${limit}`;
    const res = await axios.get(url, {
      timeout: 4000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlphaBot/3.0)' },
    });
    const list = res.data?.result?.list;
    if (Array.isArray(list) && list.length > 0) {
      const sorted = [...list].reverse();
      const bars: KlineBar[] = sorted.map((k: any) => ({
        openTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: Number(k[0]) + intervalMs,
      }));
      if (bars.length >= minRequiredBars) {
        reconcileWithDecibel(bars, symbol);
        realKlinesCache.set(cacheKey, { bars, fetchedAt: Date.now() });
        return bars;
      }
    }
  } catch (err: any) {
    logger.debug(`[${symbol}] Bybit ${interval} klines: ${err.message}. Trying OKX...`);
  }

  // 4. Tertiary Network: OKX Public API
  try {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=${okxInterval}&limit=${limit}`;
    const res = await axios.get(url, {
      timeout: 4000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlphaBot/3.0)' },
    });
    const list = res.data?.data;
    if (Array.isArray(list) && list.length > 0) {
      const sorted = [...list].reverse();
      const bars: KlineBar[] = sorted.map((k: any) => ({
        openTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: Number(k[0]) + intervalMs,
      }));
      if (bars.length >= minRequiredBars) {
        reconcileWithDecibel(bars, symbol);
        realKlinesCache.set(cacheKey, { bars, fetchedAt: Date.now() });
        return bars;
      }
    }
  } catch (err: any) {
    logger.debug(`[${symbol}] OKX ${interval} klines: ${err.message}. Trying Sim Lab...`);
  }

  // 5. Quaternary: Query Sim Lab Central Brain (Port 4000) or host gateway
  try {
    const simBases = [
      process.env.SIMLAB_SERVER_URL,
      'http://172.17.0.1:4000',
      'http://alpha-forge-server:4000',
      'http://127.0.0.1:4000'
    ].filter(Boolean);
    const cleanSym = symbol.replace(/USD[T]?$/, '/USD');
    for (const simBase of simBases) {
      try {
        const simUrl = `${simBase}/api/klines?symbol=${cleanSym}&interval=${interval === '1h' ? '1h' : '15m'}&limit=${limit}`;
        const klineHeaders: Record<string, string> = {
          Accept: 'application/json',
          'x-client-id': config.CLIENT_ID || 'v3-client',
        };
        const apiKey = config.CLIENT_API_KEY || config.SIMLAB_KEY || '';
        if (apiKey) {
          klineHeaders['Authorization'] = `Bearer ${apiKey}`;
          klineHeaders['x-api-key'] = apiKey;
        }
        const res = await axios.get(simUrl, { headers: klineHeaders, timeout: 2500 });
        const list = res.data?.klines;
        if (Array.isArray(list) && list.length > 0) {
          const bars: KlineBar[] = list.map((k: any) => ({
            openTime: Number(k.openTime || k.t),
            open: Number(k.open || k.o),
            high: Number(k.high || k.h),
            low: Number(k.low || k.l),
            close: Number(k.close || k.c),
            volume: Number(k.volume || k.v || 100),
            closeTime: Number(k.closeTime || ((k.openTime || k.t) + intervalMs)),
          }));
          if (bars.length >= minRequiredBars) {
            reconcileWithDecibel(bars, symbol);
            realKlinesCache.set(cacheKey, { bars, fetchedAt: Date.now() });
            return bars;
          }
        }
      } catch {}
    }
  } catch {}

  // 6. Air-Gap Offline Fallback (preloadedAuthenticKlines from real_klines.json)
  try {
    const rawPreloaded = preloadedAuthenticKlines[cleanBase] || preloadedAuthenticKlines[norm] || preloadedAuthenticKlines[symbol];
    if (Array.isArray(rawPreloaded) && rawPreloaded.length >= minRequiredBars) {
      const decibelPx = decibelPriceFeed.getPrice(symbol);
      const livePx = decibelPx?.markPrice || 0;
      const lastRawClose = Number(rawPreloaded[rawPreloaded.length - 1].c || rawPreloaded[rawPreloaded.length - 1].close || 1);
      const ratio = (livePx > 0 && lastRawClose > 0) ? livePx / lastRawClose : 1.0;

      let base15mBars: KlineBar[] = rawPreloaded.map((k: any) => ({
        openTime: Number(k.t || k.openTime),
        open: Number(k.o || k.open) * ratio,
        high: Number(k.h || k.high) * ratio,
        low: Number(k.l || k.low) * ratio,
        close: Number(k.c || k.close) * ratio,
        volume: Number(k.v || k.volume || 100),
        closeTime: Number(k.closeTime || (Number(k.t || k.openTime) + 15 * 60 * 1000)),
      }));

      if (interval === '1h') {
        const hourlyBars: KlineBar[] = [];
        for (let i = 0; i < base15mBars.length; i += 4) {
          const chunk = base15mBars.slice(i, i + 4);
          if (chunk.length === 0) continue;
          hourlyBars.push({
            openTime: chunk[0].openTime,
            open: chunk[0].open,
            high: Math.max(...chunk.map(c => c.high)),
            low: Math.min(...chunk.map(c => c.low)),
            close: chunk[chunk.length - 1].close,
            volume: chunk.reduce((acc, c) => acc + c.volume, 0),
            closeTime: chunk[chunk.length - 1].closeTime,
          });
        }
        if (hourlyBars.length >= 5) {
          base15mBars = hourlyBars;
        }
      }

      reconcileWithDecibel(base15mBars, symbol);
      return base15mBars.slice(-limit);
    }
  } catch (err: any) {
    logger.debug(`[${symbol}] Air-gap fallback klines error: ${err.message}`);
  }

  // 7. Last Resort: Synthetic algorithmic waveform fallback
  const finalBars = generateFallbackKlines(symbol, interval, limit);
  reconcileWithDecibel(finalBars, symbol);
  return finalBars;
}

// ─── Standalone Strategy Engine Class (5-Layer Blueprint) ──────────────────────

export class StandaloneTradingEngine {
  private directives: StrategyDirectives = { ...DEFAULT_STANDALONE_DIRECTIVES };
  private lastIndicatorsMap: Map<string, TechnicalIndicators> = new Map();

  constructor() {
    logger.info(`🏛️  [ENGINE] Standalone Local Engine initialized (${this.directives.activeStrategy})`);
  }

  public getLatestIndicators(symbol: string): TechnicalIndicators | undefined {
    const sym = symbol.replace('-', '/').toUpperCase();
    return this.lastIndicatorsMap.get(sym) || this.lastIndicatorsMap.get(symbol);
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
  public computeIndicators(
    klines: KlineBar[],
    klines1h?: KlineBar[],
    dynamicSmaParams?: { fast?: number; slow?: number; symbol?: string }
  ): TechnicalIndicators | null {
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
      if (last1h > ema25_1h && (ema25_1h >= ema50_1h || last1h > closes1h[closes1h.length - 2])) {
        trend1h = 'BULLISH';
      } else if (last1h < ema25_1h && (ema25_1h <= ema50_1h || last1h < closes1h[closes1h.length - 2])) {
        trend1h = 'BEARISH';
      }
    } else {
      trend1h = structureTrend === 'BULLISH_STRUCTURE' ? 'BULLISH' : (structureTrend === 'BEARISH_STRUCTURE' ? 'BEARISH' : 'NEUTRAL');
    }

    const rsi14 = rsiSeries[lastIdx];
    const atr14 = atrSeries[lastIdx] || (highs[lastIdx] - lows[lastIdx]);

    // ── Dynamic Rolling-Window Top Parameter SMA calculation ───────────────────
    const pairProfile = getDynamicSmaPeriodsForSymbol(dynamicSmaParams?.symbol || '');
    const fastPeriod = dynamicSmaParams?.fast || pairProfile.fast;
    const slowPeriod = dynamicSmaParams?.slow || pairProfile.slow;

    const smaFastSeries = calculateSMA(closes, Math.min(fastPeriod, closes.length));
    const smaSlowSeries = calculateSMA(closes, Math.min(slowPeriod, closes.length));
    const smaFast = Number(smaFastSeries[lastIdx].toFixed(2));
    const smaSlow = Number(smaSlowSeries[lastIdx].toFixed(2));
    const smaAlignment: TechnicalIndicators['smaAlignment'] =
      smaFast > smaSlow ? 'BULLISH' : smaFast < smaSlow ? 'BEARISH' : 'NEUTRAL';
    const confluencePassed =
      (trend1h === 'BULLISH' && smaAlignment === 'BULLISH') ||
      (trend1h === 'BEARISH' && smaAlignment === 'BEARISH');

    const wick = calculateWickMetrics(opens[lastIdx], highs[lastIdx], lows[lastIdx], closes[lastIdx]);

    // Pullback-to-Value Envelope: distance from current price to EMA21/EMA25 and Fast SMA
    const distToEma25Pct = Number((((currentPrice - ema21) / ema21) * 100).toFixed(2));
    const distToFastSmaPct = smaFast > 0 ? Number((((currentPrice - smaFast) / smaFast) * 100).toFixed(2)) : 0;
    const isNearEma = Math.abs(distToEma25Pct) <= 0.35;
    const isNearFastSma = Math.abs(distToFastSmaPct) <= 0.35 || (closes[lastIdx] <= smaFast && highs[lastIdx] >= smaFast);
    let pullbackStatus: TechnicalIndicators['pullbackStatus'] = 'NORMAL';
    let isPullbackBounce = false;

    if (isNearEma || isNearFastSma) {
      pullbackStatus = 'IN_PULLBACK';
      if (structureTrend === 'BULLISH_STRUCTURE' && wick.lowerWickPct >= 20) {
        isPullbackBounce = true;
        pullbackStatus = 'PULLBACK_BOUNCE';
      } else if (structureTrend === 'BEARISH_STRUCTURE' && wick.upperWickPct >= 20) {
        isPullbackBounce = true;
        pullbackStatus = 'PULLBACK_BOUNCE';
      }
    } else if (distToEma25Pct > 1.8 && distToFastSmaPct > 0.8) {
      pullbackStatus = 'CHASED_BREAKOUT';
    } else if (distToEma25Pct < -1.8 && distToFastSmaPct < -0.8) {
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
      candleColor: wick.candleColor,
      isTopWickRejection: wick.isTopWickRejection,
      isBottomWickRejection: wick.isBottomWickRejection,
      isPullbackBounce,
      distToEma25Pct,
      distToFastSmaPct,
      isNearFastSma,
      pullbackStatus,
      swingHigh,
      swingLow,
      trend1h,
      structureTrend,
      lastPattern: wick.pattern,
      fastSmaPeriod: fastPeriod,
      slowSmaPeriod: slowPeriod,
      smaFast,
      smaSlow,
      smaAlignment,
      confluencePassed,
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
      change24h?: number;
    },
  ): StandaloneSignal {
    const timestamp = Date.now();
    let pairRolling: any = undefined;
    try {
      const { getPairRollingDirectives } = require('../pipeline/sim-consumer');
      pairRolling = getPairRollingDirectives(symbol);
    } catch {}

    const pairProfile = getDynamicSmaPeriodsForSymbol(symbol);
    const dynamicSmaParams = {
      fast: pairRolling?.fastPeriod || pairProfile.fast,
      slow: pairRolling?.slowPeriod || pairProfile.slow,
      symbol,
    };
    const ind = this.computeIndicators(klines, klines1h, dynamicSmaParams);
    const activeStrategy: StrategyConfig = getStrategyForPair(symbol);
    const pairOverrides = getPairOverrides(symbol);
    let simPairDir = getSimPairDirective(symbol);

    // Whitelisted Target Asset Enforcement (Dynamic between Standalone & Sim Lab)
    let effectiveTargetAssets = activeStrategy.targetAssets;
    if (simPairDir?.targetAssets && Array.isArray(simPairDir.targetAssets) && simPairDir.targetAssets.length > 0) {
      effectiveTargetAssets = simPairDir.targetAssets;
    }
    const normSym = symbol.toUpperCase().replace(/[-_/]/g, '');
    const isTargetWhitelisted = !effectiveTargetAssets || effectiveTargetAssets.length === 0 || effectiveTargetAssets.some(
      (t) => normSym.includes(t.toUpperCase().replace(/[-_/]/g, '')) || t.toUpperCase().replace(/[-_/]/g, '').includes(normSym)
    );
    const watchPairsList = typeof config.WATCH_PAIRS === 'string'
      ? config.WATCH_PAIRS.split(',').map((p: string) => p.trim()).filter(Boolean)
      : (Array.isArray(config.WATCH_PAIRS) ? (config.WATCH_PAIRS as string[]) : []);
    const isWatchPair = watchPairsList.some(
      (wp: string) => wp.toUpperCase().replace(/[-_/]/g, '') === normSym
    );
    const isReboundOpportunity = Boolean(simPairDir?.reboundOpportunity?.isReboundActive);

    // Permit execution across all configured watch pairs and active AI rebound triggers
    if (!isTargetWhitelisted && !isWatchPair && !isReboundOpportunity) {
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
        indicators: ind ? ind : {
          ema9: 0, ema21: 0, ema50: 0, ema9Previous: 0, ema21Previous: 0,
          emaCrossover: 'NEUTRAL', rsi14: 50, stochRsi14: 50, adx14: 20, atr14: 0, rvol: 1.0,
          upperWickPct: 0, lowerWickPct: 0, bodyPct: 0, isTopWickRejection: false, isBottomWickRejection: false,
          isPullbackBounce: false, distToEma25Pct: 0, pullbackStatus: 'NORMAL',
          swingHigh: 0, swingLow: 0, trend1h: 'NEUTRAL', structureTrend: 'SIDEWAYS', lastPattern: 'NEUTRAL',
        },
        reasons: [`Symbol ${symbol} held: Neither whitelisted [${(effectiveTargetAssets || []).join(', ')}] nor configured in WATCH_PAIRS`],
        strategyName: activeStrategy.name,
        strategyTags: [activeStrategy.id],
        entryRationale: `Selective Target Filter: ${symbol} is outside active trading universe.`,
        timestamp,
      };
    }

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
    const change24h = (typeof extraMetrics?.change24h === 'number')
      ? extraMetrics.change24h
      : (firstPrice > 0 ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0);

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

    // Fetch live Sim Lab Pair Directives (including active Rebound Opportunity)
    const allSimDirs = getSimPairDirectives();
    simPairDir = allSimDirs[symbol] || allSimDirs[symbol?.toUpperCase()] || allSimDirs[symbol?.replace('/', '-')] || simPairDir;

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

    // Dynamic Top 1 Rolling-Window SMA Confluence Veto
    // The SMA periods are derived dynamically from the rolling-window parameter surface scan per pair.
    if (ind.smaAlignment && ind.smaAlignment !== 'NEUTRAL') {
      if (action === 'LONG' && ind.smaAlignment === 'BEARISH') {
        reasons.push(`🛑 Confluence Veto: Dynamic SMA(${ind.fastSmaPeriod}/${ind.slowSmaPeriod}) is BEARISH opposing LONG. Decoupled chop trap avoided.`);
        action = 'HOLD';
      } else if (action === 'SHORT' && ind.smaAlignment === 'BULLISH') {
        reasons.push(`🛑 Confluence Veto: Dynamic SMA(${ind.fastSmaPeriod}/${ind.slowSmaPeriod}) is BULLISH opposing SHORT. Decoupled chop trap avoided.`);
        action = 'HOLD';
      } else if ((action === 'LONG' && ind.smaAlignment === 'BULLISH') || (action === 'SHORT' && ind.smaAlignment === 'BEARISH')) {
        reasons.push(`✨ Dynamic SMA Confluence: Dynamic SMA(${ind.fastSmaPeriod}/${ind.slowSmaPeriod}) confirms ${action} trend alignment.`);
      }
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

    if (simPairDir?.reboundOpportunity?.isReboundActive) {
      // AI Rebound Sniper SL: Snug stop anchored right below/above sweep wick with minimum volatility floor
      const ro = simPairDir.reboundOpportunity;
      const dynamicBuffer = Math.max(entry * 0.003, atr * 0.5);
      const minRequiredSlDist = Math.max(entry * 0.008, atr * 1.0 * slMultiplier);

      if (action === 'LONG' && ro.reboundSide === 'LONG') {
        const candidateSl = Math.min(entry - minRequiredSlDist, ro.structuralAnchor - dynamicBuffer);
        if (candidateSl < entry) {
          sl = Number(candidateSl.toFixed(4));
          slDist = entry - sl;
          reasons.push(`🎯 AI REBOUND SL: Calibrated stop placed below sweep wick low ($${sl.toFixed(2)}) with $${dynamicBuffer.toFixed(2)} volatility buffer`);
        }
      } else if (action === 'SHORT' && ro.reboundSide === 'SHORT') {
        const candidateSl = Math.max(entry + minRequiredSlDist, ro.structuralAnchor + dynamicBuffer);
        if (candidateSl > entry) {
          sl = Number(candidateSl.toFixed(4));
          slDist = sl - entry;
          reasons.push(`🎯 AI REBOUND SL: Calibrated stop placed above sweep wick high ($${sl.toFixed(2)}) with $${dynamicBuffer.toFixed(2)} volatility buffer`);
        }
      }
    } else if (action === 'LONG') {
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

    // ── ByKaranteli Liquidity Wall Soft SL Shielding ─────────────────────────
    const bkDirectives = simPairDir?.bykaranteli?.executionDirectives;
    const bkSuggestedSl = bkDirectives?.suggestedSlPrice;
    if (bkSuggestedSl && bkSuggestedSl > 0 && action !== 'HOLD') {
      if (action === 'SHORT' && bkSuggestedSl > entry && bkSuggestedSl <= entry + (slDist * 1.35)) {
        sl = bkSuggestedSl;
        slDist = sl - entry;
        reasons.push(`🛡️ LIQUIDITY WALL SL: Soft SL shielded behind overhead squeeze wall ($${sl.toFixed(2)})`);
      } else if (action === 'LONG' && bkSuggestedSl < entry && bkSuggestedSl >= entry - (slDist * 1.35)) {
        sl = bkSuggestedSl;
        slDist = entry - sl;
        reasons.push(`🛡️ LIQUIDITY WALL SL: Soft SL shielded below downside flush wall ($${sl.toFixed(2)})`);
      }
    }

    let takeProfit1: number;
    let takeProfit2: number;
    let tp: number;
    let isDualTp = true;
    let rrRatio: number;

    // Sim Lab Dynamic R:R & Take-Profit Scaling Calibration
    const dynamicRRFromSimLab = (activeStrategy.layer5 as any)?.dynamicTakeProfit1R ?? activeStrategy.layer5?.minRiskRewardRatio;
    const targetMinRR = dynamicRRFromSimLab ?? 1.45;

    // Check if Sim Lab pairDirectives provides an opposing VPOC or Key Level target
    const opposingVpocPrice = simPairDir?.dynamicTpTarget?.opposingVpocPrice || 
      (action === 'LONG' ? simPairDir?.keyLevels?.vah : simPairDir?.keyLevels?.val);

    let tp1Dist = slDist * targetMinRR;
    if (opposingVpocPrice && opposingVpocPrice > 0 && action !== 'HOLD') {
      const vpocDist = Math.abs(opposingVpocPrice - entry);
      const isOpposingDirection = (action === 'LONG' && opposingVpocPrice > entry) || (action === 'SHORT' && opposingVpocPrice < entry);
      if (isOpposingDirection && vpocDist >= slDist * 1.1 && vpocDist <= slDist * 2.2) {
        tp1Dist = vpocDist;
      }
    }

    // ── Multi-Venue Liquidity Magnet TP1 Snapping (Master Data Hub Primary, ByKaranteli Secondary) ──
    const hubMagnet = (simPairDir as any)?.primaryLiquidityMagnet;
    const hubSuggestedTp = hubMagnet?.magnetPrice;
    const bkSuggestedTp = bkDirectives?.suggestedTp1Price || bkDirectives?.primaryMagnetPrice;
    const activeSuggestedTp = hubSuggestedTp || bkSuggestedTp;
    const magnetLabel = hubSuggestedTp ? 'Master Data Hub Multi-Venue' : 'ByKaranteli Secondary';

    if (activeSuggestedTp && activeSuggestedTp > 0 && action !== 'HOLD') {
      const magnetDist = Math.abs(activeSuggestedTp - entry);
      const isCorrectDirection = (action === 'LONG' && activeSuggestedTp > entry) || (action === 'SHORT' && activeSuggestedTp < entry);
      if (isCorrectDirection && magnetDist >= slDist * 1.05 && magnetDist <= slDist * 2.5) {
        tp1Dist = magnetDist;
        reasons.push(`🧲 LIQUIDITY MAGNET TP1 (${magnetLabel}): Snapped to high-intensity cluster ($${activeSuggestedTp.toFixed(2)})`);
      }
    }

    const tp1 = action === 'LONG' ? entry + tp1Dist : entry - tp1Dist;
    takeProfit1 = Number(tp1.toFixed(4));

    // Extended Runner (TP2) for macro breakout continuation
    let runnerRR = Math.max(2.5, targetMinRR * 1.8);
    if (ind.adx14 >= 28 && ind.rvol >= 1.2) runnerRR = Math.max(runnerRR, 3.5);
    const tp2 = action === 'LONG' ? entry + (slDist * runnerRR) : entry - (slDist * runnerRR);
    takeProfit2 = Number(tp2.toFixed(4));

    // Primary takeProfit armed on-chain is TP1 to ensure guaranteed execution on first swing!
    tp = takeProfit1;
    isDualTp = true;
    rrRatio = Number((tp1Dist / (slDist || 1)).toFixed(2));

    const isNoFixedTp = Boolean(activeStrategy.layer5?.noFixedTp);
    if (isNoFixedTp) {
      isDualTp = false;
      takeProfit1 = 0;
      takeProfit2 = 0;
      tp = 0;
      reasons.push('🌊 ROBUST ISLAND HARVEST: No fixed TP armed on-chain. Dynamic 30% gap harvest + 50% midpoint full exit active.');
    }

    // ── Multi-Pillar Confidence Calculation ───────────────────────────────────
    let confidence = 45;

    if (action !== 'HOLD') {
      // Pillar 1: Base Momentum (0 to 15 pts)
      let pillar1 = Math.min(10, Math.abs(scoreDiff) * 5);
      if (riskLevel === 'LOW') pillar1 += 5;
      else if (riskLevel === 'MEDIUM') pillar1 += 2;

      // Pillar 2: Trend Alignment (0 to 15 pts)
      let pillar2 = 0;
      const isMtfAligned =
        (action === 'LONG' && ind.structureTrend === 'BULLISH_STRUCTURE' && ind.trend1h === 'BULLISH') ||
        (action === 'SHORT' && ind.structureTrend === 'BEARISH_STRUCTURE' && ind.trend1h === 'BEARISH');

      if (isMtfAligned) {
        pillar2 += 8;
        reasons.push(`⚡ MTF CONFLUENCE: 15m structure and 1h macro trend aligned ${trend}`);
      } else if (
        (action === 'LONG' && ind.structureTrend === 'BULLISH_STRUCTURE') ||
        (action === 'SHORT' && ind.structureTrend === 'BEARISH_STRUCTURE')
      ) {
        pillar2 += 4;
      }

      if (ind.isPullbackBounce) {
        pillar2 += 5;
        reasons.push(`🎯 VALUE PULLBACK BOUNCE: Retested dynamic value zone with rejection wick`);
      }

      if (ind.adx14 >= (activeStrategy.layer1.adxTrendThreshold || 20)) {
        pillar2 += 2;
        reasons.push(`💪 Strong ADX Trend: ${ind.adx14} >= ${activeStrategy.layer1.adxTrendThreshold || 20}`);
      }

      // Dynamic Top 1 SMA Alignment (+15 pts bonus or -10 pts penalty if opposing)
      let smaBonus = 0;
      if (ind.smaAlignment && ind.smaAlignment !== 'NEUTRAL') {
        const isSmaAligned = (action === 'LONG' && ind.smaAlignment === 'BULLISH') ||
                             (action === 'SHORT' && ind.smaAlignment === 'BEARISH');
        if (isSmaAligned) {
          smaBonus = 15;
          reasons.push(`✨ Dynamic SMA Alignment (+15%): SMA(${ind.fastSmaPeriod}/${ind.slowSmaPeriod}) confirms ${action} trend`);
        } else {
          smaBonus = -10;
          reasons.push(`⚠️ Dynamic SMA Opposing (-10%): SMA(${ind.fastSmaPeriod}/${ind.slowSmaPeriod}) momentum is ${ind.smaAlignment}, opposing ${action}`);
        }
      }

      // Pillar 3: Volume & Order Flow (0 to 20 pts)
      let pillar3 = 0;
      if (coinglassScore >= 2) pillar3 += 8;
      if (ind.rvol >= 1.3) {
        pillar3 += 8;
        reasons.push(`🔥 RVOL Spike: ${ind.rvol}x volume surge confirming institutional participation`);
      } else if (ind.rvol >= 1.0) {
        pillar3 += 4;
      }
      // ByKaranteli Live Whale Tape Confluence (+$1M prints aligned with direction)
      if (bkDirectives?.whaleNetBias24h === action) {
        pillar3 += 4;
        reasons.push(`🐋 WHALE CONFLUENCE: Live $1M+ whale tape confirms aggressive ${action} dominance (${bkDirectives.whalePrintsCount} prints)`);
      }

      // Tier 1: 75% Technical Cap (Calibrated de-overfitted threshold)
      const rawTechnical = pillar1 + pillar2 + smaBonus + pillar3;
      let technicalScore = Math.max(0, Math.min(75, rawTechnical));

      // ── Hard Gating (Anti-Point Stacking Caps) ─────────────────────────────
      // Gate 1: MTF Trend Conflict Cap (Max 60%)
      if (
        (action === 'LONG' && ind.trend1h === 'BEARISH') ||
        (action === 'SHORT' && ind.trend1h === 'BULLISH')
      ) {
        const orderflow = simPairDir?.orderflow;
        const isFlowSupportive = action === 'LONG'
          ? (orderflow?.cvdTrend !== 'STRONG_SELL' && ((orderflow as any)?.takerBuyRatio === undefined || (orderflow as any)?.takerBuyRatio >= 0.48))
          : (orderflow?.cvdTrend !== 'STRONG_BUY' && ((orderflow as any)?.takerBuyRatio === undefined || (orderflow as any)?.takerBuyRatio <= 0.52));

        if (simPairDir?.reboundOpportunity?.isReboundActive && isFlowSupportive) {
          reasons.push(`⚡ REBOUND MTF EXEMPTION: 1h macro trend lag waived for AI-confirmed ${simPairDir.reboundOpportunity.reboundType}.`);
        } else {
          technicalScore = Math.min(technicalScore, 60);
          reasons.push(`🛑 MTF HARD GATE: 15m ${action} contradicts 1h ${ind.trend1h} macro trend without supportive flow. Capped at 60%.`);
        }
      }

      // Gate 2: Overextension / Chased Breakout
      if (simPairDir?.reboundOpportunity?.isReboundActive) {
        reasons.push(`⚡ REBOUND MOMENTUM EXEMPTION: Fast impulse is confirmed initial expansion of ${simPairDir.reboundOpportunity.reboundType} — exempt from chased breakout penalty.`);
      } else if (ind.pullbackStatus === 'CHASED_BREAKOUT' && action === 'LONG') {
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

      // Gate 5: StochRSI Exhaustion (Soft Point Deduction)
      if (activeStrategy.layer1.stochRsiFilter && !simPairDir?.reboundOpportunity?.isReboundActive) {
        if (action === 'SHORT' && (ind.stochRsi14 < 20 || ind.rsi14 < 32)) {
          technicalScore = Math.max(30, technicalScore - 8);
          reasons.push(`⚠️ OVERSOLD EXHAUSTION WARNING: StochRSI (${ind.stochRsi14}) / RSI (${ind.rsi14.toFixed(1)}) oversold (-8 pts).`);
        } else if (action === 'LONG' && (ind.stochRsi14 > 80 || ind.rsi14 > 68)) {
          technicalScore = Math.max(30, technicalScore - 8);
          reasons.push(`⚠️ OVERBOUGHT EXHAUSTION WARNING: StochRSI (${ind.stochRsi14}) / RSI (${ind.rsi14.toFixed(1)}) overbought (-8 pts).`);
        }
      }

      // AI Institutional Rebound Conviction Boost from Sim Lab
      if (simPairDir?.reboundOpportunity?.isReboundActive) {
        const ro = simPairDir.reboundOpportunity;
        if ((action === 'LONG' && ro.reboundSide === 'LONG') || (action === 'SHORT' && ro.reboundSide === 'SHORT')) {
          technicalScore = Math.max(technicalScore, 68);
          reasons.push(`🚀 AI REBOUND CONVICTION: Sim Lab verified ${ro.summary}`);
        }
      }

      // Gate 6: ADX Consolidation Chop
      if (ind.adx14 < 18) {
        technicalScore = Math.min(technicalScore, 65);
        reasons.push(`⚠️ ADX CHOP GATE: ADX (${ind.adx14}) < 18 indicates consolidation chop. Capped at 65%.`);
      }

      // ── Gate 7: Institutional 4-Regime & Volume Profile (Sim Lab Port 4000) ──
      if (simPairDir) {
        // 7a. Compression Squeeze — hard cap at 65% until breakout
        if (simPairDir.regime?.type === 'REGIME_COMPRESSION_SQUEEZE' && simPairDir.regime?.isBbSqueeze) {
          technicalScore = Math.min(technicalScore, 65);
          reasons.push(`📦 SQUEEZE LOCK [Sim Lab]: BB(20,2σ) coiled inside Keltner(20,1.5×ATR). Pre-breakout compression. Capped at 65%.`);
        }
        // 7b. Strong Trend regime — directional bonus/penalty
        if (simPairDir.regime?.type === 'REGIME_STRONG_TREND') {
          const regTrend = simPairDir.regime.trendDirection;
          if ((action === 'LONG' && regTrend === 'BULLISH') || (action === 'SHORT' && regTrend === 'BEARISH')) {
            technicalScore = Math.min(72, technicalScore + 6);
            reasons.push(`⚡ REGIME ALIGNMENT [Sim Lab]: Aligned with ${simPairDir.regime.displayName} (+6% trend rider).`);
          } else if (regTrend !== 'NEUTRAL') {
            technicalScore = Math.min(technicalScore, 58);
            reasons.push(`⚠️ REGIME CONFLICT [Sim Lab]: Counter-trend against ${simPairDir.regime.displayName}. Capped at 58%.`);
          }
        }
        // 7c. Volume Profile — vPOC tap confluence
        const kl = simPairDir.keyLevels;
        if (kl?.activeVpocs?.length > 0) {
          const nearestVpoc = kl.activeVpocs.find((vp: number) => Math.abs(entry - vp) / vp <= 0.0035);
          if (nearestVpoc) {
            technicalScore = Math.min(72, technicalScore + 7);
            reasons.push(`🎯 VIRGIN POC TAP [Sim Lab]: Institutional liquidity sweep & bounce at $${nearestVpoc.toFixed(4)} (+7% vPOC edge).`);
          }
        }
        // 7d. Developing POC migration alignment
        if (kl?.dProcTrend === 'STEPPING_UP' && action === 'LONG') {
          technicalScore = Math.min(72, technicalScore + 4);
          reasons.push(`📈 D-POC MIGRATION [Sim Lab]: Developing POC stepping up — bullish value migration (+4%).`);
        } else if (kl?.dProcTrend === 'STEPPING_DOWN' && action === 'SHORT') {
          technicalScore = Math.min(72, technicalScore + 4);
          reasons.push(`📉 D-POC MIGRATION [Sim Lab]: Developing POC stepping down — bearish value migration (+4%).`);
        }

        // 7e. Box POC Retest & Anti-Chase Breakout Veto [Sim Lab Directive]
        const box = kl?.consolidationBox;
        const isBoxEnabled = activeStrategy.layer1?.boxConsolidationRetest !== false &&
                             activeStrategy.layer3?.boxConsolidationRetest !== false;
        if (box && box.isBoxActive && isBoxEnabled) {
          const tfLabel = `${(box.boxTimeframe || '15m').toUpperCase()} Box`;
          if (box.status === 'WAITING_FOR_POC_RETEST') {
            technicalScore = Math.max(30, technicalScore - 6);
            reasons.push(`⚠️ BOX POC RETEST PENDING [Sim Lab Directive]: ${tfLabel} impulse active without POC retest. Waiting for pullback to POC ($${Number(box.boxPoc).toFixed(2)}) (-6 pts).`);
          } else if (box.status === 'AT_POC_RETEST' && box.breakoutSide === action) {
            const hasRejectionWick = action === 'LONG' ? (ind.lowerWickPct >= 25) : (ind.upperWickPct >= 25);
            const hasReversalColor = action === 'LONG' ? (ind.candleColor === 'GREEN') : (ind.candleColor === 'RED');
            const isConfirmedBounce = hasRejectionWick || hasReversalColor;
            if (isConfirmedBounce) {
              technicalScore = Math.min(72, technicalScore + 15);
              reasons.push(`🎯 BOX POC RETEST [Sim Lab Directive]: Clean ${tfLabel} POC pullback retest ($${Number(box.boxPoc).toFixed(2)}, dist: ${Number(box.distToPocPct || 0).toFixed(2)}%) with ${hasRejectionWick ? `${action === 'LONG' ? ind.lowerWickPct : ind.upperWickPct}% wick` : 'reversal candle'} (+15%).`);
            } else {
              technicalScore = Math.min(technicalScore, 48);
              reasons.push(`⚠️ BOX POC RETEST: Price at Box POC ($${Number(box.boxPoc).toFixed(2)}) but lacks reversal/absorption confirmation (candle ${ind.candleColor}, wick ${action === 'LONG' ? ind.lowerWickPct : ind.upperWickPct}%). Capped at 48%.`);
            }
          }
        }

        // 7f. Future Dynamic Sim Lab Indicators & TA Confluence Passthrough
        if ((simPairDir as any).extraTaConfluences?.length) {
          const extras = (simPairDir as any).extraTaConfluences;
          for (const extra of extras) {
            if (typeof extra.scoreBonus === 'number') {
              technicalScore = Math.max(0, Math.min(72, technicalScore + extra.scoreBonus));
            }
            if (extra.reason) {
              reasons.push(`⚡ ${extra.name || 'NEW TA'} [Sim Lab Directive]: ${extra.reason}`);
            }
          }
        }
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

        // Structure Shifts (CHoCH / BOS) under Sim Lab Layer 3 Directive
        if (activeStrategy.layer3.structureShiftChoch) {
          if (action === 'LONG') {
            if (['BULLISH_CHOCH', 'BULLISH_BOS'].includes(smc.structureShift.type)) {
              smcPoints += 5;
              smcReasons.push(`SMC ${smc.structureShift.type} confirmed (+5%)`);
            } else if (['BEARISH_CHOCH', 'BEARISH_BOS'].includes(smc.structureShift.type)) {
              technicalScore = Math.min(technicalScore, 50);
              reasons.push(`🛑 SMC STRUCTURE BREAK VETO: Bearish ${smc.structureShift.type} detected under Sim Lab Layer 3 directive. Entry score capped at 50%.`);
            }
          } else if (action === 'SHORT') {
            if (['BEARISH_CHOCH', 'BEARISH_BOS'].includes(smc.structureShift.type)) {
              smcPoints += 5;
              smcReasons.push(`SMC ${smc.structureShift.type} confirmed (+5%)`);
            } else if (['BULLISH_CHOCH', 'BULLISH_BOS'].includes(smc.structureShift.type)) {
              technicalScore = Math.min(technicalScore, 50);
              reasons.push(`🛑 SMC STRUCTURE BREAK VETO: Bullish ${smc.structureShift.type} detected under Sim Lab Layer 3 directive. Entry score capped at 50%.`);
            }
          }
        }

        // Unlock SMC Confluence Key (up to 30 pts)
        if (smcPoints > 0) {
          smcBonus = Math.min(30, Math.max(10, smcPoints));
          reasons.push(`🔑 SMC REQUIRED EXECUTION KEY: +${smcBonus}% bonus unlocked (${smcReasons.join(', ')})`);
        }
      }

      confidence = Math.max(0, Math.min(100, technicalScore + smcBonus));

      // ── Universal Non-Bypassable Candle Retest & Reversal Gate ───────────────
      // Non-bypassable core baseline: irrespective of strategy layer toggles or pair overrides,
      // never execute a Long order into an unconfirmed expanding red candle (falling knife) or buy an upper wick trap.
      const candleConfirm = evaluatePullbackConfirmation(action, ind, {
        isReboundActive: Boolean(simPairDir?.reboundOpportunity?.isReboundActive),
        dynamicWickThreshold: simPairDir?.reboundOpportunity?.dynamicWickThreshold,
      });
      if (!candleConfirm.isConfirmed) {
        const prevAction = action;
        action = 'HOLD';
        confidence = Math.min(confidence, candleConfirm.capScore ?? 45);
        reasons.push(`🛑 UNIVERSAL CANDLE CONFIRMATION GATE: ${candleConfirm.reason} (${prevAction} aborted -> HOLD).`);
      }
    }

    // ── 4. LAYER 5: Dynamic Leverage & Execution Trigger Check ─────────────────
    const dynamicLev = calculateDynamicLeverage({
      confidence,
      entry,
      sl,
      riskLevel,
      layer5: activeStrategy.layer5,
    });

    const hardMinLev = (config as any).MIN_LEVERAGE || 10;
    const hardMaxLev = (config as any).MAX_LEVERAGE || 15;
    let leverage = Math.max(hardMinLev, Math.min(dynamicLev.leverage, hardMaxLev));
    if (pairOverrides && typeof pairOverrides.maxLeverage === 'number' && pairOverrides.maxLeverage > 0) {
      const pairCap = Math.max(hardMinLev, Math.min(pairOverrides.maxLeverage, hardMaxLev));
      if (leverage > pairCap) {
        reasons.push(`🛡️ PAIR LEVERAGE CAP: Leverage ${leverage}x capped to pair limit ${pairCap}x`);
        leverage = pairCap;
      }
    }
    if (action !== 'HOLD') {
      reasons.push(dynamicLev.explanation);

      // Strict Invariant: Soft SL must ALWAYS stay strictly between entry and catastrophic Hard SL
      if (entry > 0) {
        const hardSlDist = entry * (0.15 / Math.max(1, leverage));
        const hardSlEst = action === 'LONG' ? entry - hardSlDist : entry + hardSlDist;
        if (action === 'LONG') {
          const maxSoftSl = entry * 0.997;
          const minSoftSl = hardSlEst * 1.002;
          sl = Number(Math.max(minSoftSl, Math.min(maxSoftSl, sl)).toFixed(4));
        } else if (action === 'SHORT') {
          const minSoftSl = entry * 1.003;
          const maxSoftSl = hardSlEst * 0.998;
          sl = Number(Math.min(maxSoftSl, Math.max(minSoftSl, sl)).toFixed(4));
        }
      }
    }

    // Dynamic Gate hierarchy: 1. Pair Override (Agent Brain) -> 2. Sim Lab Directives -> 3. Strategy Profile -> 4. Baseline Default (68 for liquid, 72 general)
    const isLiquidPair = ['BTC', 'ETH', 'SOL'].some(p => symbol.toUpperCase().includes(p));
    const defaultGate = isLiquidPair ? 68 : 72;
    const minGate = pairOverrides?.minConfidenceGate || this.directives.scoreFloor || activeStrategy.layer5?.minConfidenceGate || defaultGate;
    let isTriggered = action !== 'HOLD' && confidence >= minGate;

    // Institutional Veto 1: Empirical Pair Quarantine & Pair Ban Check
    if (pairOverrides) {
      const pOver = pairOverrides as any;
      if (pOver.probationActive || pOver.shadowModeOnly || pOver.bannedSide === 'BOTH') {
        isTriggered = false;
        reasons.push(`🛑 QUANT QUARANTINE: ${symbol} is quarantined to Paper Shadow Simulation. Live orders forbidden.`);
      } else if (pOver.bannedSide === action) {
        isTriggered = false;
        reasons.push(`🛑 PAIR BAN: Direction ${action} is banned for ${symbol} by Sim Lab directive.`);
      }
    }

    // Institutional Veto 2: Hard Directional Ban in RISK_ON_BETA / TRENDING_BULL
    const isRiskOnBetaOrBull = this.directives.regime === 'RISK_ON_BETA' || this.directives.regime === 'TRENDING_BULL' || this.directives.bannedSides?.includes('SHORT');
    if (action === 'SHORT' && isRiskOnBetaOrBull) {
      isTriggered = false;
      reasons.push(`🛑 HARD DIRECTIONAL BAN: SHORTs are strictly prohibited across all pairs under ${this.directives.regime || 'RISK_ON_BETA'} regime.`);
    }

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

    // Dynamic Per-Pair Maker Offset from Sim Lab Directive and Active Regime
    // Calibrated for Top-Of-Book Maker placement (high fill probability without crossing the spread)
    const isChop = this.directives.regime === 'RANGING_CHOP';
    const isHighVol = this.directives.regime === 'HIGH_VOLATILITY';
    const dynamicOffset = typeof pairOverrides?.makerOffsetPct === 'number'
      ? pairOverrides.makerOffsetPct
      : (isChop ? 0.0006 : isHighVol ? 0.0010 : 0.0008);

    if (isTriggered && action === 'LONG') {
      // Pullback Retest Limit Order #4: Prioritize Sim Lab pre-calculated maker limit, then fast SMA dynamic support floor, then top-of-book bid
      if (simPairDir?.retestLimitLong && simPairDir.retestLimitLong > 0) {
        limitPrice = Number(simPairDir.retestLimitLong.toFixed(4));
      } else if (ind.smaFast && ind.smaFast > 0 && Math.abs(entry - ind.smaFast) / ind.smaFast <= 0.0075) {
        limitPrice = Number(Math.max(klines[klines.length - 1].low, ind.smaFast).toFixed(4));
      } else {
        limitPrice = Number((entry * (1 - dynamicOffset)).toFixed(4));
      }
      orderType = 'POST_ONLY_LIMIT';
      postOnly = true;
    } else if (isTriggered && action === 'SHORT') {
      // Pullback Retest Limit Order #4: Prioritize Sim Lab pre-calculated maker limit, then fast SMA dynamic resistance ceiling, then top-of-book ask
      if (simPairDir?.retestLimitShort && simPairDir.retestLimitShort > 0) {
        limitPrice = Number(simPairDir.retestLimitShort.toFixed(4));
      } else if (ind.smaFast && ind.smaFast > 0 && Math.abs(entry - ind.smaFast) / ind.smaFast <= 0.0075) {
        limitPrice = Number(Math.min(klines[klines.length - 1].high, ind.smaFast).toFixed(4));
      } else {
        limitPrice = Number((entry * (1 + dynamicOffset)).toFixed(4));
      }
      orderType = 'POST_ONLY_LIMIT';
      postOnly = true;
    }

    // Cache latest indicators for real-time portfolio harvester structure break evaluation
    this.lastIndicatorsMap.set(symbol.replace('-', '/').toUpperCase(), ind);
    this.lastIndicatorsMap.set(symbol, ind);

    // Dynamic Amber Band Harvest Prices: Prioritize Sim Lab broadcast, then strategy lambda weights
    let gap30PriceVal: number | undefined = simPairDir?.gap30Price;
    let gap50PriceVal: number | undefined = simPairDir?.gap50Price;
    if ((!gap30PriceVal || !gap50PriceVal) && ind.smaFast && ind.smaSlow) {
      const inner = ind.smaFast;
      const longer = ind.smaSlow;
      const lambda30 = (activeStrategy.layer5 as any)?.dynamicGapLambda ?? 0.30;
      const lambda50 = (activeStrategy.layer5 as any)?.dynamicGapExitLambda ?? 0.50;
      if (!gap30PriceVal) gap30PriceVal = Number(((1 - lambda30) * inner + lambda30 * longer).toFixed(4));
      if (!gap50PriceVal) gap50PriceVal = Number(((1 - lambda50) * inner + lambda50 * longer).toFixed(4));
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
      executionProfile: 'STANDARD_SWING',
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
      noFixedTp: isNoFixedTp,
      exit50CloseEnabled: Boolean(activeStrategy.layer5?.exit50CloseEnabled),
      gap30Price: gap30PriceVal,
      gap50Price: gap50PriceVal,
      strategyName: simPairDir?.reboundOpportunity?.isReboundActive
        ? (simPairDir.reboundOpportunity.reboundSide === 'LONG' ? 'AI Institutional V-Rebound' : 'AI Blow-Off Top Reversal')
        : (isCustomPair ? `${activeStrategy.name} (${symbol})` : activeStrategy.name),
      strategyTags: [
        ...(simPairDir?.reboundOpportunity?.isReboundActive ? ['AI-Brain', 'Rebound', simPairDir.reboundOpportunity.sweepType || 'Reversal'] : [activeStrategy.id]),
        ...(isCustomPair ? ['pair-override'] : [])
      ],
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
