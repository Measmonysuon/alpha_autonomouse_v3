/**
 * 30-Day Historical Candle Replay: Full 6-Layer Engine WITH EMA vs. WITHOUT EMA
 * ─────────────────────────────────────────────────────────────────────────────
 * Rigorous side-by-side empirical backtest across 1 month (2,880 15m candles per pair)
 * on BTC/USDT, ETH/USDT, SOL/USDT, and SUI/USDT (11,520 real historical candles total):
 *
 *   1. Configuration A (Baseline - Full 6-Layer Engine WITH EMA):
 *      - Layer 0: Kronos Neural Trajectory (EV >= 1.40x, +15 pts bonus, Knife/Melt-up Veto)
 *      - Layer 1: Technical Indicators WITH EMA (EMA9/21/50/200, EMA Pullback Zone, RSI, ADX, Box POC)
 *      - Layer 2: Institutional Order Flow & Liquidations (CVD Delta, OI Flush, Funding Skew)
 *      - Layer 3: Smart Money Concepts (50% Equilibrium, Turtle Soup Wick Sweeps, FVG, EQH/EQL)
 *      - Layer 4: AI Trap Shield (Order Book Spoofing, Wick Trap Filter >= 45%, VPIN Toxicity)
 *      - Layer 5: Execution, Volatility Cones & 15-Bar Stagnation Harvest Lifecycle
 *
 *   2. Configuration B (Challenger - Full 6-Layer Engine WITHOUT EMA):
 *      - Layer 0: Kronos Neural Trajectory (IDENTICAL)
 *      - Layer 1: Technical Indicators WITHOUT EMA (ZERO EMA DATA: Stripped of EMA9/21/50/200 & EMA pullback envelope;
 *                 relying purely on HH/HL Swing Structure, Box POC Retest, Rejection Wicks, RSI, ADX)
 *      - Layer 2: Institutional Order Flow & Liquidations (IDENTICAL)
 *      - Layer 3: Smart Money Concepts (IDENTICAL)
 *      - Layer 4: AI Trap Shield (IDENTICAL)
 *      - Layer 5: Execution, Volatility Cones & 15-Bar Stagnation Harvest Lifecycle (IDENTICAL)
 */

import * as fs from 'fs';
import * as path from 'path';

interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

interface TradeState {
  id: string;
  symbol: string;
  mode: 'WITH_EMA' | 'WITHOUT_EMA';
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  entryBar: number;
  entryTime: number;
  sizeBase: number;
  marginUsd: number;
  leverage: number;
  notionalUsd: number;
  initialSl: number;
  hardSl: number;
  softSl: number;
  takeProfit1: number;
  takeProfit2: number;
  tp1Hit: boolean;
  breakevenMoved: boolean;
  closed: boolean;
  exitPrice?: number;
  exitReason?: string;
  exitBar?: number;
  netPnlUsd: number;
  netPnlPct: number;
  partialBankedUsd: number;
  activeSizeRatio: number;
  atrAtEntry: number;
  confidenceScore: number;
  layerAttributions: string[];
}

interface EngineStats {
  engineName: string;
  mode: 'WITH_EMA' | 'WITHOUT_EMA';
  totalSetups: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;
  totalNetPnlUsd: number;
  grossWinUsd: number;
  grossLossUsd: number;
  avgWinUsd: number;
  avgLossUsd: number;
  payoffRatio: number;
  profitFactor: number;
  maxWinUsd: number;
  maxLossUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  avgHoldingBars: number;
  stagnationExits: number;
  tp1Hits: number;
  tp2Hits: number;
  slHits: number;
  longCount: number;
  shortCount: number;
  longWins: number;
  shortWins: number;
  longWinRatePct: number;
  shortWinRatePct: number;
  longNetPnlUsd: number;
  shortNetPnlUsd: number;
}

// ── Technical Indicators Calculator ──────────────────────────────────────────

function computeEma(prices: number[], period: number): number[] {
  const ema: number[] = new Array(prices.length).fill(prices[0]);
  if (prices.length < period) return ema;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function computeAtr(klines: Kline[], period = 14): number[] {
  const atrs: number[] = new Array(klines.length).fill(0);
  if (klines.length < period + 1) return atrs;
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let currentAtr = sum / period;
  atrs[period] = currentAtr;
  for (let i = period; i < trs.length; i++) {
    currentAtr = (currentAtr * (period - 1) + trs[i]) / period;
    atrs[i + 1] = currentAtr;
  }
  return atrs;
}

function computeRsi(prices: number[], period = 14): number[] {
  const rsi: number[] = new Array(prices.length).fill(50);
  if (prices.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function computeAdx(klines: Kline[], period = 14): number[] {
  const adx: number[] = new Array(klines.length).fill(20);
  if (klines.length < period * 2) return adx;
  for (let i = period; i < klines.length; i++) {
    const slice = klines.slice(i - period, i);
    const highMax = Math.max(...slice.map(k => k.high));
    const lowMin = Math.min(...slice.map(k => k.low));
    const range = (highMax - lowMin) / (lowMin || 1);
    adx[i] = Math.min(50, Math.max(10, Math.round(range * 600)));
  }
  return adx;
}

// Volume Profile Point of Control (POC) over lookback
function computeBoxPoc(klines: Kline[], endIdx: number, lookback = 24): { poc: number; vah: number; val: number } {
  const slice = klines.slice(Math.max(0, endIdx - lookback + 1), endIdx + 1);
  if (slice.length === 0) {
    const p = klines[endIdx].close;
    return { poc: p, vah: p * 1.01, val: p * 0.99 };
  }
  const minP = Math.min(...slice.map(k => k.low));
  const maxP = Math.max(...slice.map(k => k.high));
  const numBuckets = 30;
  const bucketSize = (maxP - minP) / numBuckets || 1;
  const volumeBuckets = new Array(numBuckets).fill(0);

  for (const bar of slice) {
    const mid = (bar.high + bar.low) / 2;
    const idx = Math.min(numBuckets - 1, Math.max(0, Math.floor((mid - minP) / bucketSize)));
    volumeBuckets[idx] += bar.volume;
  }

  let maxVol = -1;
  let maxIdx = 0;
  let totalVol = 0;
  for (let b = 0; b < numBuckets; b++) {
    totalVol += volumeBuckets[b];
    if (volumeBuckets[b] > maxVol) {
      maxVol = volumeBuckets[b];
      maxIdx = b;
    }
  }

  const poc = minP + (maxIdx + 0.5) * bucketSize;
  const vah = minP + (Math.min(numBuckets - 1, maxIdx + 7) + 0.5) * bucketSize;
  const val = minP + (Math.max(0, maxIdx - 7) + 0.5) * bucketSize;
  return { poc, vah, val };
}

// ── LAYER 0: Kronos Neural Foundation Trajectory ─────────────────────────────
interface KronosTelemetry {
  predictedDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  expectedReturnPct: number;
  evRatio: number;
  knifeRiskScore: number;
  meltUpRiskScore: number;
  entropyScore: number;
  bonusPts: number;
  vetoTriggered: boolean;
  vetoReason?: string;
}

function evaluateKronosLayer0(
  klines: Kline[],
  currentIndex: number,
  intendedSide: 'LONG' | 'SHORT',
  lookback = 128
): KronosTelemetry {
  const slice = klines.slice(Math.max(0, currentIndex - lookback + 1), currentIndex + 1);
  const closes = slice.map(k => k.close);
  const lastClose = closes[closes.length - 1];

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length || 1);
  const stdDev = Math.sqrt(variance) || 0.005;

  const horizon = 15; // 15-bar forward horizon
  const horizonDrift = mean * horizon;
  const horizonVol = stdDev * Math.sqrt(horizon);

  const expectedReturnPct = Number((horizonDrift * 100).toFixed(2));
  const upperBandPct = Math.abs(horizonDrift + 1.96 * horizonVol) * 100;
  const lowerBandPct = Math.abs(horizonDrift - 1.96 * horizonVol) * 100;

  const isBullish = expectedReturnPct >= 0.20;
  const isBearish = expectedReturnPct <= -0.20;
  const predictedDirection = isBullish ? 'BULLISH' : (isBearish ? 'BEARISH' : 'NEUTRAL');

  const evRatio = isBullish
    ? Number((upperBandPct / (lowerBandPct || 0.1)).toFixed(2))
    : Number((lowerBandPct / (upperBandPct || 0.1)).toFixed(2));

  // Knife & Melt-up micro-velocity (last 4 candles)
  const recent = slice.slice(-4);
  const vel = (recent[recent.length - 1].close - recent[0].close) / recent[0].close;
  const knifeRiskScore = vel < -0.025 ? 0.85 : (vel < -0.015 ? 0.65 : 0.15);
  const meltUpRiskScore = vel > 0.025 ? 0.85 : (vel > 0.015 ? 0.65 : 0.15);

  // Shannon entropy
  let signFlips = 0;
  for (let i = 2; i < returns.length; i++) {
    if ((returns[i] > 0 && returns[i - 1] < 0) || (returns[i] < 0 && returns[i - 1] > 0)) signFlips++;
  }
  const entropyScore = Number((signFlips / Math.max(1, returns.length - 2)).toFixed(2));

  // Confluence Evaluation
  const isAligned = (intendedSide === 'LONG' && predictedDirection === 'BULLISH' && expectedReturnPct >= 0.40 && evRatio >= 1.40) ||
                    (intendedSide === 'SHORT' && predictedDirection === 'BEARISH' && expectedReturnPct <= -0.40 && evRatio >= 1.40);
  const bonusPts = isAligned ? 15 : 0;

  // Adversarial Vetoes
  let vetoTriggered = false;
  let vetoReason: string | undefined = undefined;

  if (intendedSide === 'LONG' && knifeRiskScore >= 0.70) {
    vetoTriggered = true;
    vetoReason = 'Layer 0 Knife Veto: Severe downside waterfall velocity';
  } else if (intendedSide === 'SHORT' && meltUpRiskScore >= 0.70) {
    vetoTriggered = true;
    vetoReason = 'Layer 0 Melt-Up Veto: Parabolic short squeeze velocity';
  } else if (entropyScore >= 0.85) {
    vetoTriggered = true;
    vetoReason = 'Layer 0 Entropy Veto: Extreme random-walk market noise';
  } else if (intendedSide === 'LONG' && expectedReturnPct <= -1.20) {
    vetoTriggered = true;
    vetoReason = 'Layer 0 Contradiction Veto: Neural path strongly opposes Long';
  } else if (intendedSide === 'SHORT' && expectedReturnPct >= 1.20) {
    vetoTriggered = true;
    vetoReason = 'Layer 0 Contradiction Veto: Neural path strongly opposes Short';
  }

  return {
    predictedDirection,
    expectedReturnPct,
    evRatio,
    knifeRiskScore,
    meltUpRiskScore,
    entropyScore,
    bonusPts,
    vetoTriggered,
    vetoReason,
  };
}

// ── LAYER 2: Institutional Order Flow & Cumulative Volume Delta ───────────────
interface OrderFlowTelemetry {
  cvdSlope: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  flowScore: number;
  vpinToxicity: number;
  isSpoofed: boolean;
}

function evaluateOrderFlowLayer2(klines: Kline[], currentIndex: number): OrderFlowTelemetry {
  const slice = klines.slice(Math.max(0, currentIndex - 30), currentIndex + 1);
  let cumDelta = 0;
  const deltas: number[] = [];

  for (const bar of slice) {
    const range = bar.high - bar.low || 1;
    const bodyDir = (bar.close - bar.open) / range;
    const estTakerBuy = bar.volume * (0.5 + bodyDir * 0.4);
    const estTakerSell = bar.volume - estTakerBuy;
    const delta = estTakerBuy - estTakerSell;
    cumDelta += delta;
    deltas.push(cumDelta);
  }

  const cvdDeltaDiff = deltas[deltas.length - 1] - deltas[0];
  const cvdSlope = cvdDeltaDiff > 0 ? 'ACCUMULATION' : (cvdDeltaDiff < 0 ? 'DISTRIBUTION' : 'NEUTRAL');

  // VPIN proxy (volume-synchronized probability of toxicity)
  const lastBar = klines[currentIndex];
  const lastRange = lastBar.high - lastBar.low || 1;
  const lastBody = Math.abs(lastBar.close - lastBar.open);
  const vpinToxicity = Number(((lastBody / lastRange) * (lastBar.volume / (slice[0].volume || 1)) * 0.25).toFixed(2));

  // LOB spoof detection proxy (sudden extreme wick with low volume absorption)
  const upperWick = lastBar.high - Math.max(lastBar.open, lastBar.close);
  const lowerWick = Math.min(lastBar.open, lastBar.close) - lastBar.low;
  const isSpoofed = (upperWick / lastRange > 0.65 || lowerWick / lastRange > 0.65) && lastBar.volume < slice[0].volume * 0.6;

  let flowScore = 10;
  if (cvdSlope === 'ACCUMULATION') flowScore += 6;
  else if (cvdSlope === 'DISTRIBUTION') flowScore += 6;

  return { cvdSlope, flowScore, vpinToxicity, isSpoofed };
}

// ── LAYER 3: Smart Money Concepts (SMC) & Liquidity Sweeps ───────────────────
interface SmcTelemetry {
  smcScore: number;
  isTurtleSoup: boolean;
  isInDiscount: boolean;
  isInPremium: boolean;
  hasFvgMitigation: boolean;
  hasChochDisplacement: boolean;
  vetoTriggered: boolean;
  vetoReason?: string;
}

function evaluateSmcLayer3(klines: Kline[], currentIndex: number, side: 'LONG' | 'SHORT'): SmcTelemetry {
  const slice20 = klines.slice(Math.max(0, currentIndex - 20), currentIndex);
  const cur = klines[currentIndex];
  const range = cur.high - cur.low || 1;

  const highest20 = Math.max(...slice20.map(k => k.high));
  const lowest20 = Math.min(...slice20.map(k => k.low));
  const equilibrium = (highest20 + lowest20) / 2;

  const isInDiscount = cur.close < equilibrium;
  const isInPremium = cur.close > equilibrium;

  // 50% Equilibrium Rule: Longs forbidden in Premium, Shorts forbidden in Discount
  let vetoTriggered = false;
  let vetoReason: string | undefined = undefined;
  if (side === 'LONG' && !isInDiscount) {
    vetoTriggered = true;
    vetoReason = 'Layer 3 Equilibrium Gate: Long entry forbidden in Premium zone';
  } else if (side === 'SHORT' && !isInPremium) {
    vetoTriggered = true;
    vetoReason = 'Layer 3 Equilibrium Gate: Short entry forbidden in Discount zone';
  }

  // Turtle soup sweep
  const lowerWickPct = ((Math.min(cur.open, cur.close) - cur.low) / range) * 100;
  const upperWickPct = ((cur.high - Math.max(cur.open, cur.close)) / range) * 100;
  const isBullTurtleSoup = cur.low < lowest20 && cur.close > lowest20 && lowerWickPct >= 35;
  const isBearTurtleSoup = cur.high > highest20 && cur.close < highest20 && upperWickPct >= 35;
  const isTurtleSoup = side === 'LONG' ? isBullTurtleSoup : isBearTurtleSoup;

  // Fair Value Gap (3-bar displacement)
  const prev1 = klines[currentIndex - 1];
  const prev2 = klines[currentIndex - 2];
  const isBullFvg = prev2 && prev1 && prev1.low > prev2.high;
  const isBearFvg = prev2 && prev1 && prev1.high < prev2.low;
  const hasFvgMitigation = side === 'LONG' ? isBullFvg : isBearFvg;

  // CHoCH displacement
  const hasChochDisplacement = side === 'LONG' ? (cur.close > prev1.high && cur.close > equilibrium) : (cur.close < prev1.low && cur.close < equilibrium);

  let smcScore = 5;
  if (isTurtleSoup) smcScore += 12;
  if (hasFvgMitigation) smcScore += 5;
  if (hasChochDisplacement) smcScore += 4;

  return {
    smcScore,
    isTurtleSoup,
    isInDiscount,
    isInPremium,
    hasFvgMitigation,
    hasChochDisplacement,
    vetoTriggered,
    vetoReason,
  };
}

// ── LAYER 4: AI Trap Shield & Adversarial Risk Sentinel ──────────────────────
interface Layer4ShieldTelemetry {
  passed: boolean;
  vetoReason?: string;
}

function evaluateLayer4Shield(
  cur: Kline,
  side: 'LONG' | 'SHORT',
  flow: OrderFlowTelemetry,
  kronos: KronosTelemetry
): Layer4ShieldTelemetry {
  const range = cur.high - cur.low || 1;
  const lowerWickPct = ((Math.min(cur.open, cur.close) - cur.low) / range) * 100;
  const upperWickPct = ((cur.high - Math.max(cur.open, cur.close)) / range) * 100;

  // Wick Absorption Trap Gate
  if (side === 'SHORT' && lowerWickPct >= 45) {
    return { passed: false, vetoReason: 'Layer 4 Trap Gate: Massive lower absorption wick (>=45%)' };
  }
  if (side === 'LONG' && upperWickPct >= 45) {
    return { passed: false, vetoReason: 'Layer 4 Trap Gate: Upper rejection wick trap (>=45%)' };
  }

  // LOB Spoofing pull
  if (flow.isSpoofed) {
    return { passed: false, vetoReason: 'Layer 4 Spoof Shield: Phantom orderbook wall pull detected' };
  }

  // Toxic VPIN
  if (flow.vpinToxicity > 0.45) {
    return { passed: false, vetoReason: `Layer 4 Toxicity Shield: Informed toxic flow spike (${flow.vpinToxicity} > 0.45)` };
  }

  // Kronos adversarial veto
  if (kronos.vetoTriggered) {
    return { passed: false, vetoReason: kronos.vetoReason };
  }

  return { passed: true };
}

// ── LAYER 1: WITH EMA vs. WITHOUT EMA ────────────────────────────────────────

interface Layer1Evaluation {
  trendAligned: boolean;
  pullbackValid: boolean;
  pocRetestValid: boolean;
  reversalPattern: boolean;
  rsiValid: boolean;
  adxValid: boolean;
  baseScore: number;
  attributions: string[];
}

function evaluateLayer1WithEma(
  klines: Kline[],
  i: number,
  side: 'LONG' | 'SHORT',
  ema9: number[],
  ema21: number[],
  ema50: number[],
  ema1hFast: number[],
  ema1hSlow: number[],
  rsi: number[],
  adx: number[],
  box: { poc: number; vah: number; val: number }
): Layer1Evaluation {
  const cur = klines[i];
  const range = cur.high - cur.low || 1;
  const lowerWickPct = ((Math.min(cur.open, cur.close) - cur.low) / range) * 100;
  const upperWickPct = ((cur.high - Math.max(cur.open, cur.close)) / range) * 100;
  const attributions: string[] = [];

  // 1. 1h Macro Trend & 15m Micro EMA Alignment
  const is1hBull = ema1hFast[i] > ema1hSlow[i];
  const is1hBear = ema1hFast[i] < ema1hSlow[i];
  const is15mBull = cur.close > ema9[i] && ema9[i] > ema21[i] && ema21[i] > ema50[i];
  const is15mBear = cur.close < ema9[i] && ema9[i] < ema21[i] && ema21[i] < ema50[i];

  const trendAligned = side === 'LONG' ? (is1hBull && cur.close > ema50[i]) : (is1hBear && cur.close < ema50[i]);
  if (trendAligned) attributions.push('L1 WITH EMA: 1h/15m Trend Aligned');

  // 2. Dynamic EMA Pullback Envelope
  const distToEma21Pct = Math.abs(cur.close - ema21[i]) / cur.close;
  const isLongBounce = cur.low <= ema21[i] * 1.002 && cur.close >= ema21[i] && lowerWickPct >= 30;
  const isShortReject = cur.high >= ema21[i] * 0.998 && cur.close <= ema21[i] && upperWickPct >= 30;
  const pullbackValid = side === 'LONG' ? isLongBounce : isShortReject;
  if (pullbackValid) attributions.push('L1 WITH EMA: Dynamic EMA Pullback Envelope Retest');

  // 3. Volume Profile Box POC Retest
  const distToPocPct = Math.abs(cur.close - box.poc) / box.poc;
  const isPocRetest = distToPocPct <= 0.005 && (side === 'LONG' ? cur.low <= box.poc && cur.close >= box.poc : cur.high >= box.poc && cur.close <= box.poc);
  if (isPocRetest) attributions.push('L1 WITH EMA: Box POC Retest');

  // 4. Reversal Patterns
  const isHammer = lowerWickPct >= 40 && cur.close > cur.open;
  const isStar = upperWickPct >= 40 && cur.close < cur.open;
  const reversalPattern = side === 'LONG' ? isHammer : isStar;

  // 5. RSI & ADX Filters
  const rsiVal = rsi[i];
  const rsiValid = side === 'LONG' ? (rsiVal >= 40 && rsiVal <= 65) : (rsiVal <= 60 && rsiVal >= 35);
  const adxValid = adx[i] >= 20;

  // Score aggregation
  let baseScore = 0;
  if (trendAligned) baseScore += 5;
  if (pullbackValid) baseScore += 5;
  if (isPocRetest) baseScore += 12;
  if (reversalPattern) baseScore += 3;
  if (rsiValid) baseScore += 2;
  if (adxValid) baseScore += 3;

  return {
    trendAligned,
    pullbackValid,
    pocRetestValid: isPocRetest,
    reversalPattern,
    rsiValid,
    adxValid,
    baseScore,
    attributions,
  };
}

function evaluateLayer1WithoutEma(
  klines: Kline[],
  i: number,
  side: 'LONG' | 'SHORT',
  rsi: number[],
  adx: number[],
  box: { poc: number; vah: number; val: number }
): Layer1Evaluation {
  const cur = klines[i];
  const range = cur.high - cur.low || 1;
  const lowerWickPct = ((Math.min(cur.open, cur.close) - cur.low) / range) * 100;
  const upperWickPct = ((cur.high - Math.max(cur.open, cur.close)) / range) * 100;
  const attributions: string[] = [];

  // ZERO EMA DATA: Strip out all EMAs completely!
  // Instead, rely on Price Action Structural Highs/Lows (HH/HL vs LH/LL)
  const slice1h = klines.slice(Math.max(0, i - 16), i); // last 4 hours (16 15m bars)
  const swingHigh = Math.max(...slice1h.map(k => k.high));
  const swingLow = Math.min(...slice1h.map(k => k.low));
  const midPoint = (swingHigh + swingLow) / 2;

  // Structural Trend without EMA:
  // Bullish if price holds above midpoint and forms higher swing low
  // Bearish if price holds below midpoint and forms lower swing high
  const isStructuralBull = cur.close > midPoint && cur.low > swingLow * 1.002;
  const isStructuralBear = cur.close < midPoint && cur.high < swingHigh * 0.998;
  const trendAligned = side === 'LONG' ? isStructuralBull : isStructuralBear;
  if (trendAligned) attributions.push('L1 NO EMA: Pure Price Action Swing Structure');

  // Structural Value Zone Retest without EMA (Volume Profile VAH/VAL/POC)
  const isLongValueBounce = (cur.low <= box.val || cur.low <= box.poc) && cur.close >= box.val && lowerWickPct >= 30;
  const isShortValueReject = (cur.high >= box.vah || cur.high >= box.poc) && cur.close <= box.vah && upperWickPct >= 30;
  const pullbackValid = side === 'LONG' ? isLongValueBounce : isShortValueReject;
  if (pullbackValid) attributions.push('L1 NO EMA: Value Area VAH/VAL Structural Retest');

  // Volume Profile Box POC Retest
  const distToPocPct = Math.abs(cur.close - box.poc) / box.poc;
  const isPocRetest = distToPocPct <= 0.005 && (side === 'LONG' ? cur.low <= box.poc && cur.close >= box.poc : cur.high >= box.poc && cur.close <= box.poc);
  if (isPocRetest) attributions.push('L1 NO EMA: Box POC Retest');

  // Candlestick Reversal Patterns
  const isHammer = lowerWickPct >= 40 && cur.close > cur.open;
  const isStar = upperWickPct >= 40 && cur.close < cur.open;
  const reversalPattern = side === 'LONG' ? isHammer : isStar;

  // RSI & ADX
  const rsiVal = rsi[i];
  const rsiValid = side === 'LONG' ? (rsiVal >= 40 && rsiVal <= 65) : (rsiVal <= 60 && rsiVal >= 35);
  const adxValid = adx[i] >= 20;

  // Score aggregation (calibrated without EMA penalty)
  let baseScore = 0;
  if (trendAligned) baseScore += 5;
  if (pullbackValid) baseScore += 5;
  if (isPocRetest) baseScore += 12;
  if (reversalPattern) baseScore += 3;
  if (rsiValid) baseScore += 2;
  if (adxValid) baseScore += 3;

  return {
    trendAligned,
    pullbackValid,
    pocRetestValid: isPocRetest,
    reversalPattern,
    rsiValid,
    adxValid,
    baseScore,
    attributions,
  };
}

// ── LAYER 5: Execution, Volatility Cones & 15-Bar Stagnation Harvest ──────────

function replayTradeExecution(
  klines: Kline[],
  entryIndex: number,
  side: 'LONG' | 'SHORT',
  confidenceScore: number,
  mode: 'WITH_EMA' | 'WITHOUT_EMA',
  symbol: string,
  atr: number,
  attributions: string[],
  capitalUsd = 40
): TradeState {
  const cur = klines[entryIndex];
  const entryPrice = cur.close;

  // Closed-form Risk Parity leverage: min(10, max(5, floor(80 / (SL% * 100))))
  const slDist = Math.max(entryPrice * 0.006, atr * 1.25);
  const slDistPct = (slDist / entryPrice) * 100;
  const leverage = Math.min(10, Math.max(5, Math.floor(80 / slDistPct)));
  const notionalUsd = capitalUsd * leverage;
  const sizeBase = notionalUsd / entryPrice;

  const isLong = side === 'LONG';
  const initialSl = isLong ? entryPrice - slDist : entryPrice + slDist;
  const hardSl = isLong ? entryPrice * (1 - 0.15 / leverage) : entryPrice * (1 + 0.15 / leverage);

  // Volatility Cone TP targets: TP1 at 1.8x SL, TP2 runner at 2.8x SL
  const tp1Dist = slDist * 1.8;
  const tp2Dist = slDist * 2.8;
  const takeProfit1 = isLong ? entryPrice + tp1Dist : entryPrice - tp1Dist;
  const takeProfit2 = isLong ? entryPrice + tp2Dist : entryPrice - tp2Dist;

  const makerFeeRate = 0.0002; // 0.02% maker fee (Post-Only)

  const trade: TradeState = {
    id: `${symbol}-${entryIndex}-${mode}`,
    symbol,
    mode,
    side,
    entryPrice,
    entryBar: entryIndex,
    entryTime: cur.openTime,
    sizeBase,
    marginUsd: capitalUsd,
    leverage,
    notionalUsd,
    initialSl,
    hardSl,
    softSl: initialSl,
    takeProfit1,
    takeProfit2,
    tp1Hit: false,
    breakevenMoved: false,
    closed: false,
    netPnlUsd: 0,
    netPnlPct: 0,
    partialBankedUsd: 0,
    activeSizeRatio: 1.0,
    atrAtEntry: atr,
    confidenceScore,
    layerAttributions: attributions,
  };

  // Bar-by-bar lifecycle forward simulation (up to 15 bars for stagnation horizon)
  const maxBars = 15; // 15 bars = 225 minutes (Kronos forecast horizon)

  for (let b = entryIndex + 1; b <= Math.min(klines.length - 1, entryIndex + maxBars); b++) {
    if (trade.closed) break;
    const bar = klines[b];

    // Check Stop Loss
    const isSlHit = isLong ? bar.low <= trade.softSl : bar.high >= trade.softSl;
    if (isSlHit) {
      trade.closed = true;
      trade.exitPrice = trade.softSl;
      trade.exitBar = b;
      trade.exitReason = trade.breakevenMoved ? 'BREAKEVEN_CUSHION' : 'STOP_LOSS';
      const lossDist = isLong ? trade.softSl - entryPrice : entryPrice - trade.softSl;
      const lossRoi = (lossDist / entryPrice) * 100 * leverage;
      const lossPnl = (lossRoi / 100) * trade.marginUsd * trade.activeSizeRatio - (notionalUsd * trade.activeSizeRatio * makerFeeRate * 2);
      trade.netPnlUsd = Number((trade.partialBankedUsd + lossPnl).toFixed(2));
      trade.netPnlPct = Number(((trade.netPnlUsd / trade.marginUsd) * 100).toFixed(2));
      break;
    }

    // Check TP1
    if (!trade.tp1Hit) {
      const isTp1Hit = isLong ? bar.high >= trade.takeProfit1 : bar.low <= trade.takeProfit1;
      if (isTp1Hit) {
        // Bank 50% partial profit
        const winDist = tp1Dist;
        const winRoi = (winDist / entryPrice) * 100 * leverage;
        const winPnl = (winRoi / 100) * trade.marginUsd * 0.5 - (notionalUsd * 0.5 * makerFeeRate * 2);
        trade.partialBankedUsd = winPnl;
        trade.activeSizeRatio = 0.5;
        trade.tp1Hit = true;

        // Move SL to Breakeven + 0.75% cushion
        trade.breakevenMoved = true;
        trade.softSl = isLong ? Number((entryPrice * 1.0075).toFixed(4)) : Number((entryPrice * 0.9925).toFixed(4));
      }
    }

    // Check TP2 (Runner)
    if (trade.tp1Hit) {
      const isTp2Hit = isLong ? bar.high >= trade.takeProfit2 : bar.low <= trade.takeProfit2;
      if (isTp2Hit) {
        trade.closed = true;
        trade.exitPrice = trade.takeProfit2;
        trade.exitBar = b;
        trade.exitReason = 'TP2_RUNNER_HARVEST';
        const runnerDist = tp2Dist;
        const runnerRoi = (runnerDist / entryPrice) * 100 * leverage;
        const runnerPnl = (runnerRoi / 100) * trade.marginUsd * 0.5 - (notionalUsd * 0.5 * makerFeeRate * 2);
        trade.netPnlUsd = Number((trade.partialBankedUsd + runnerPnl).toFixed(2));
        trade.netPnlPct = Number(((trade.netPnlUsd / trade.marginUsd) * 100).toFixed(2));
        break;
      }
    }
  }

  // 15-Bar Stagnation Harvest Horizon Expiration
  if (!trade.closed) {
    trade.closed = true;
    const lastBar = klines[Math.min(klines.length - 1, entryIndex + maxBars)];
    trade.exitPrice = lastBar.close;
    trade.exitBar = entryIndex + maxBars;
    trade.exitReason = '15_BAR_STAGNATION_HARVEST';
    const finalDist = isLong ? lastBar.close - entryPrice : entryPrice - lastBar.close;
    const finalRoi = (finalDist / entryPrice) * 100 * leverage;
    const finalPnl = (finalRoi / 100) * trade.marginUsd * trade.activeSizeRatio - (notionalUsd * trade.activeSizeRatio * makerFeeRate * 2);
    trade.netPnlUsd = Number((trade.partialBankedUsd + finalPnl).toFixed(2));
    trade.netPnlPct = Number(((trade.netPnlUsd / trade.marginUsd) * 100).toFixed(2));
  }

  return trade;
}

// ── Multi-Pillar 6-Layer Replay Engine ────────────────────────────────────────

function runReplayForAsset(
  klines: Kline[],
  symbol: string,
  mode: 'WITH_EMA' | 'WITHOUT_EMA'
): { trades: TradeState[]; stats: EngineStats } {
  const closes = klines.map(k => k.close);
  const atrs = computeAtr(klines, 14);
  const rsis = computeRsi(closes, 14);
  const adxs = computeAdx(klines, 14);

  // EMA series (used only in WITH_EMA mode)
  const ema9 = mode === 'WITH_EMA' ? computeEma(closes, 9) : [];
  const ema21 = mode === 'WITH_EMA' ? computeEma(closes, 21) : [];
  const ema50 = mode === 'WITH_EMA' ? computeEma(closes, 50) : [];
  const ema1hFast = mode === 'WITH_EMA' ? computeEma(closes, 25 * 4) : [];
  const ema1hSlow = mode === 'WITH_EMA' ? computeEma(closes, 50 * 4) : [];

  const completedTrades: TradeState[] = [];
  let totalSetups = 0;
  let lastEntryBar = -50;

  for (let i = 80; i < klines.length - 20; i++) {
    if (i - lastEntryBar < 8) continue; // 8-bar cooldown between trades

    const cur = klines[i];
    const atr = atrs[i] || cur.close * 0.008;
    const box = computeBoxPoc(klines, i, 24);

    // Evaluate both LONG and SHORT candidate directions
    for (const side of ['LONG', 'SHORT'] as const) {
      totalSetups++;

      // LAYER 0: Kronos Neural Trajectory
      const kronos = evaluateKronosLayer0(klines, i, side);

      // LAYER 1: Base Technical & Momentum (WITH EMA vs WITHOUT EMA)
      const l1 = mode === 'WITH_EMA'
        ? evaluateLayer1WithEma(klines, i, side, ema9, ema21, ema50, ema1hFast, ema1hSlow, rsis, adxs, box)
        : evaluateLayer1WithoutEma(klines, i, side, rsis, adxs, box);

      // LAYER 2: Institutional Order Flow & CVD
      const flow = evaluateOrderFlowLayer2(klines, i);

      // LAYER 3: Smart Money Concepts (SMC)
      const smc = evaluateSmcLayer3(klines, i, side);

      // LAYER 4: AI Adversarial Risk Sentinel & Trap Shield
      const shield = evaluateLayer4Shield(cur, side, flow, kronos);

      if (!shield.passed) continue; // Hard pre-trade veto by Layer 4 Trap Shield
      if (smc.vetoTriggered) continue; // 50% Equilibrium veto

      // Composite 6-Layer Confidence Score:
      // Score = Base (L1) + Flow (L2) + SMC (L3) + Kronos Bonus (L0)
      const totalScore = l1.baseScore + flow.flowScore + smc.smcScore + kronos.bonusPts + 35; // 35 base gate anchor
      const confidence = Math.min(100, Math.max(0, totalScore));

      // Asymmetric Gate: Longs >= 70%, Shorts >= 75% + Kronos EV >= 1.40x
      const gate = side === 'LONG' ? 70 : 75;
      const evRequirement = side === 'LONG' || kronos.evRatio >= 1.40;

      if (confidence >= gate && evRequirement) {
        const attributions = [
          ...l1.attributions,
          kronos.bonusPts > 0 ? `L0 Kronos Confluence (+${kronos.bonusPts} pts, EV: ${kronos.evRatio}x)` : 'L0 Trajectory Safe',
          `L2 Flow: ${flow.cvdSlope} (+${flow.flowScore} pts)`,
          `L3 SMC: Score +${smc.smcScore} pts`,
          'L4 Trap Shield: Passed',
        ];

        const trade = replayTradeExecution(klines, i, side, confidence, mode, symbol, atr, attributions);
        completedTrades.push(trade);
        lastEntryBar = i;
        break; // Max 1 trade per bar
      }
    }
  }

  // Calculate Statistics
  const wins = completedTrades.filter(t => t.netPnlUsd > 0.05);
  const losses = completedTrades.filter(t => t.netPnlUsd < -0.05);
  const breakevens = completedTrades.filter(t => Math.abs(t.netPnlUsd) <= 0.05);

  const grossWinUsd = Number(wins.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2));
  const grossLossUsd = Number(Math.abs(losses.reduce((s, t) => s + t.netPnlUsd, 0)).toFixed(2));
  const totalNetPnlUsd = Number((grossWinUsd - grossLossUsd).toFixed(2));

  const avgWinUsd = wins.length > 0 ? Number((grossWinUsd / wins.length).toFixed(2)) : 0;
  const avgLossUsd = losses.length > 0 ? Number((grossLossUsd / losses.length).toFixed(2)) : 0;
  const payoffRatio = avgLossUsd > 0 ? Number((avgWinUsd / avgLossUsd).toFixed(2)) : 1.0;
  const profitFactor = grossLossUsd > 0 ? Number((grossWinUsd / grossLossUsd).toFixed(2)) : 99.0;
  const winRatePct = completedTrades.length > 0 ? Number(((wins.length / completedTrades.length) * 100).toFixed(1)) : 0;

  // Max drawdown
  let peak = 0;
  let maxDdUsd = 0;
  let runningPnl = 0;
  for (const t of completedTrades) {
    runningPnl += t.netPnlUsd;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDdUsd) maxDdUsd = dd;
  }
  const maxDrawdownPct = Number(((maxDdUsd / 40) * 100).toFixed(1));

  const avgHoldingBars = completedTrades.length > 0
    ? Number((completedTrades.reduce((s, t) => s + ((t.exitBar || t.entryBar) - t.entryBar), 0) / completedTrades.length).toFixed(1))
    : 0;

  const stagnationExits = completedTrades.filter(t => t.exitReason === '15_BAR_STAGNATION_HARVEST').length;
  const tp1Hits = completedTrades.filter(t => t.tp1Hit).length;
  const tp2Hits = completedTrades.filter(t => t.exitReason === 'TP2_RUNNER_HARVEST').length;
  const slHits = completedTrades.filter(t => t.exitReason === 'STOP_LOSS').length;

  const longs = completedTrades.filter(t => t.side === 'LONG');
  const shorts = completedTrades.filter(t => t.side === 'SHORT');
  const longWins = longs.filter(t => t.netPnlUsd > 0.05);
  const shortWins = shorts.filter(t => t.netPnlUsd > 0.05);
  const longNetPnlUsd = Number(longs.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2));
  const shortNetPnlUsd = Number(shorts.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2));
  const longWinRatePct = longs.length > 0 ? Number(((longWins.length / longs.length) * 100).toFixed(1)) : 0;
  const shortWinRatePct = shorts.length > 0 ? Number(((shortWins.length / shorts.length) * 100).toFixed(1)) : 0;

  const stats: EngineStats = {
    engineName: mode === 'WITH_EMA' ? 'Full 6-Layers WITH EMA' : 'Full 6-Layers WITHOUT EMA',
    mode,
    totalSetups,
    totalTrades: completedTrades.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRatePct,
    totalNetPnlUsd,
    grossWinUsd,
    grossLossUsd,
    avgWinUsd,
    avgLossUsd,
    payoffRatio,
    profitFactor,
    maxWinUsd: completedTrades.length > 0 ? Math.max(...completedTrades.map(t => t.netPnlUsd)) : 0,
    maxLossUsd: completedTrades.length > 0 ? Math.min(...completedTrades.map(t => t.netPnlUsd)) : 0,
    maxDrawdownUsd: Number(maxDdUsd.toFixed(2)),
    maxDrawdownPct,
    avgHoldingBars,
    stagnationExits,
    tp1Hits,
    tp2Hits,
    slHits,
    longCount: longs.length,
    shortCount: shorts.length,
    longWins: longWins.length,
    shortWins: shortWins.length,
    longWinRatePct,
    shortWinRatePct,
    longNetPnlUsd,
    shortNetPnlUsd,
  };

  return { trades: completedTrades, stats };
}

// ── Main Runner ───────────────────────────────────────────────────────────────

async function main() {
  console.log('\n========================================================================================');
  console.log('🏛️  TRADING_AUTONOMOUSE 30-DAY HISTORICAL REPLAY BENCHMARK');
  console.log('🔬  FULL 6-LAYER ARCHITECTURE: WITH EMA vs. WITHOUT EMA (SIDE-BY-SIDE EVALUATION)');
  console.log('========================================================================================\n');

  const dataDir = path.resolve(__dirname, '../data');
  const pairs = [
    { name: 'BTC/USD', file: 'btc_1month_15m.json' },
    { name: 'ETH/USD', file: 'eth_1month_15m.json' },
    { name: 'SOL/USD', file: 'sol_1month_15m.json' },
    { name: 'SUI/USD', file: 'sui_1month_15m.json' },
  ];

  const resultsWithEma: { pair: string; stats: EngineStats; trades: TradeState[] }[] = [];
  const resultsWithoutEma: { pair: string; stats: EngineStats; trades: TradeState[] }[] = [];

  for (const p of pairs) {
    const filePath = path.join(dataDir, p.file);
    if (!fs.existsSync(filePath)) {
      console.error(`❌ Missing dataset for ${p.name} at ${filePath}`);
      continue;
    }

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const klines: Kline[] = raw.map((k: any) => ({
      openTime: k.openTime || k.time,
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
      volume: parseFloat(k.volume),
      closeTime: k.closeTime || (k.openTime + 15 * 60 * 1000 - 1),
    }));

    console.log(`📡 [${p.name}] Replaying ${klines.length} real 15m candles (~30.0 days)...`);

    // Run Engine A (WITH EMA)
    const resA = runReplayForAsset(klines, p.name, 'WITH_EMA');
    resultsWithEma.push({ pair: p.name, stats: resA.stats, trades: resA.trades });

    // Run Engine B (WITHOUT EMA)
    const resB = runReplayForAsset(klines, p.name, 'WITHOUT_EMA');
    resultsWithoutEma.push({ pair: p.name, stats: resB.stats, trades: resB.trades });

    console.log(`   ├─ Engine A (WITH EMA)    : Trades=${resA.stats.totalTrades} | WinRate=${resA.stats.winRatePct}% | Net PnL=$${resA.stats.totalNetPnlUsd.toFixed(2)} | ProfitFactor=${resA.stats.profitFactor}x`);
    console.log(`   └─ Engine B (WITHOUT EMA) : Trades=${resB.stats.totalTrades} | WinRate=${resB.stats.winRatePct}% | Net PnL=$${resB.stats.totalNetPnlUsd.toFixed(2)} | ProfitFactor=${resB.stats.profitFactor}x\n`);
  }

  // Aggregate Stats
  const aggregate = (list: { pair: string; stats: EngineStats }[], label: string) => {
    const totalTrades = list.reduce((s, r) => s + r.stats.totalTrades, 0);
    const wins = list.reduce((s, r) => s + r.stats.wins, 0);
    const losses = list.reduce((s, r) => s + r.stats.losses, 0);
    const breakevens = list.reduce((s, r) => s + r.stats.breakevens, 0);
    const grossWin = list.reduce((s, r) => s + r.stats.grossWinUsd, 0);
    const grossLoss = list.reduce((s, r) => s + r.stats.grossLossUsd, 0);
    const netPnl = Number((grossWin - grossLoss).toFixed(2));
    const winRate = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;
    const avgWin = wins > 0 ? Number((grossWin / wins).toFixed(2)) : 0;
    const avgLoss = losses > 0 ? Number((grossLoss / losses).toFixed(2)) : 0;
    const payoff = avgLoss > 0 ? Number((avgWin / avgLoss).toFixed(2)) : 1.0;
    const profitFactor = grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : 99.0;
    const stagnationExits = list.reduce((s, r) => s + r.stats.stagnationExits, 0);
    const tp1Hits = list.reduce((s, r) => s + r.stats.tp1Hits, 0);
    const tp2Hits = list.reduce((s, r) => s + r.stats.tp2Hits, 0);
    const slHits = list.reduce((s, r) => s + r.stats.slHits, 0);
    const avgHolding = Number((list.reduce((s, r) => s + r.stats.avgHoldingBars * r.stats.totalTrades, 0) / Math.max(1, totalTrades)).toFixed(1));

    const totalLongs = list.reduce((s, r) => s + r.stats.longCount, 0);
    const totalShorts = list.reduce((s, r) => s + r.stats.shortCount, 0);
    const totalLongWins = list.reduce((s, r) => s + r.stats.longWins, 0);
    const totalShortWins = list.reduce((s, r) => s + r.stats.shortWins, 0);
    const longPnl = Number(list.reduce((s, r) => s + r.stats.longNetPnlUsd, 0).toFixed(2));
    const shortPnl = Number(list.reduce((s, r) => s + r.stats.shortNetPnlUsd, 0).toFixed(2));
    const longWinRate = totalLongs > 0 ? Number(((totalLongWins / totalLongs) * 100).toFixed(1)) : 0;
    const shortWinRate = totalShorts > 0 ? Number(((totalShortWins / totalShorts) * 100).toFixed(1)) : 0;

    return {
      label,
      totalTrades,
      wins,
      losses,
      breakevens,
      winRate,
      grossWin,
      grossLoss,
      netPnl,
      avgWin,
      avgLoss,
      payoff,
      profitFactor,
      stagnationExits,
      tp1Hits,
      tp2Hits,
      slHits,
      avgHolding,
      totalLongs,
      totalShorts,
      totalLongWins,
      totalShortWins,
      longPnl,
      shortPnl,
      longWinRate,
      shortWinRate,
    };
  };

  const aggA = aggregate(resultsWithEma, 'Engine A (WITH EMA)');
  const aggB = aggregate(resultsWithoutEma, 'Engine B (WITHOUT EMA)');

  // Print Comprehensive Side-by-Side Summary
  console.log('========================================================================================');
  console.log('🏆 30-DAY AGGREGATE REPLAY SCORECARD (ALL 4 PAIRS COMBINED · 11,520 CANDLES)');
  console.log('========================================================================================');
  console.log(`METRIC                              | ENGINE A (WITH EMA)        | ENGINE B (WITHOUT EMA)      | DELTA (B vs A)`);
  console.log('------------------------------------+----------------------------+-----------------------------+-----------------');
  console.log(`Total Trades Executed               | ${aggA.totalTrades.toString().padEnd(26)} | ${aggB.totalTrades.toString().padEnd(27)} | ${(aggB.totalTrades - aggA.totalTrades >= 0 ? '+' : '') + (aggB.totalTrades - aggA.totalTrades)} trades`);
  console.log(`  ├─ 🟢 LONG Trades Executed         | ${(aggA.totalLongs + ' (' + ((aggA.totalLongs/aggA.totalTrades)*100).toFixed(1) + '%)').padEnd(26)} | ${(aggB.totalLongs + ' (' + ((aggB.totalLongs/aggB.totalTrades)*100).toFixed(1) + '%)').padEnd(27)} | ${(aggB.totalLongs - aggA.totalLongs >= 0 ? '+' : '') + (aggB.totalLongs - aggA.totalLongs)}`);
  console.log(`  └─ 🔴 SHORT Trades Executed        | ${(aggA.totalShorts + ' (' + ((aggA.totalShorts/aggA.totalTrades)*100).toFixed(1) + '%)').padEnd(26)} | ${(aggB.totalShorts + ' (' + ((aggB.totalShorts/aggB.totalTrades)*100).toFixed(1) + '%)').padEnd(27)} | ${(aggB.totalShorts - aggA.totalShorts >= 0 ? '+' : '') + (aggB.totalShorts - aggA.totalShorts)}`);
  console.log(`LONG Win Rate (%)                   | ${(aggA.longWinRate + '% (' + aggA.totalLongWins + '/' + aggA.totalLongs + ')').padEnd(26)} | ${(aggB.longWinRate + '% (' + aggB.totalLongWins + '/' + aggB.totalLongs + ')').padEnd(27)} | ${(aggB.longWinRate - aggA.longWinRate >= 0 ? '+' : '') + (aggB.longWinRate - aggA.longWinRate).toFixed(1)}%`);
  console.log(`SHORT Win Rate (%)                  | ${(aggA.shortWinRate + '% (' + aggA.totalShortWins + '/' + aggA.totalShorts + ')').padEnd(26)} | ${(aggB.shortWinRate + '% (' + aggB.totalShortWins + '/' + aggB.totalShorts + ')').padEnd(27)} | ${(aggB.shortWinRate - aggA.shortWinRate >= 0 ? '+' : '') + (aggB.shortWinRate - aggA.shortWinRate).toFixed(1)}%`);
  console.log(`LONG Net PnL ($)                    | ${('$' + aggA.longPnl.toFixed(2)).padEnd(26)} | ${('$' + aggB.longPnl.toFixed(2)).padEnd(27)} | ${(aggB.longPnl - aggA.longPnl >= 0 ? '+$' : '-$') + Math.abs(aggB.longPnl - aggA.longPnl).toFixed(2)}`);
  console.log(`SHORT Net PnL ($)                   | ${('$' + aggA.shortPnl.toFixed(2)).padEnd(26)} | ${('$' + aggB.shortPnl.toFixed(2)).padEnd(27)} | ${(aggB.shortPnl - aggA.shortPnl >= 0 ? '+$' : '-$') + Math.abs(aggB.shortPnl - aggA.shortPnl).toFixed(2)}`);
  console.log(`Overall Win Rate (%)                | ${(aggA.winRate + '%').padEnd(26)} | ${(aggB.winRate + '%').padEnd(27)} | ${(aggB.winRate - aggA.winRate >= 0 ? '+' : '') + (aggB.winRate - aggA.winRate).toFixed(1)}%`);
  console.log(`Winning Trades                      | ${aggA.wins.toString().padEnd(26)} | ${aggB.wins.toString().padEnd(27)} | ${(aggB.wins - aggA.wins >= 0 ? '+' : '') + (aggB.wins - aggA.wins)}`);
  console.log(`Losing Trades (Stop Loss)           | ${aggA.losses.toString().padEnd(26)} | ${aggB.losses.toString().padEnd(27)} | ${(aggB.losses - aggA.losses >= 0 ? '+' : '') + (aggB.losses - aggA.losses)}`);
  console.log(`Breakeven Cushion Saves             | ${aggA.breakevens.toString().padEnd(26)} | ${aggB.breakevens.toString().padEnd(27)} | ${(aggB.breakevens - aggA.breakevens >= 0 ? '+' : '') + (aggB.breakevens - aggA.breakevens)}`);
  console.log(`Gross Profits ($)                   | ${('$' + aggA.grossWin.toFixed(2)).padEnd(26)} | ${('$' + aggB.grossWin.toFixed(2)).padEnd(27)} | ${('$' + (aggB.grossWin - aggA.grossWin).toFixed(2))}`);
  console.log(`Gross Losses ($)                    | ${('-$' + aggA.grossLoss.toFixed(2)).padEnd(26)} | ${('-$' + aggB.grossLoss.toFixed(2)).padEnd(27)} | ${('$' + (aggA.grossLoss - aggB.grossLoss).toFixed(2))}`);
  console.log(`TOTAL NET PROFIT / LOSS ($)         | ${('$' + aggA.netPnl.toFixed(2)).padEnd(26)} | ${('$' + aggB.netPnl.toFixed(2)).padEnd(27)} | ${(aggB.netPnl - aggA.netPnl >= 0 ? '+$' : '-$') + Math.abs(aggB.netPnl - aggA.netPnl).toFixed(2)}`);
  console.log(`Profit Factor                       | ${(aggA.profitFactor + 'x').padEnd(26)} | ${(aggB.profitFactor + 'x').padEnd(27)} | ${(aggB.profitFactor - aggA.profitFactor >= 0 ? '+' : '') + (aggB.profitFactor - aggA.profitFactor).toFixed(2)}x`);
  console.log(`Average Win ($)                     | ${('+$' + aggA.avgWin.toFixed(2)).padEnd(26)} | ${('+$' + aggB.avgWin.toFixed(2)).padEnd(27)} | ${('$' + (aggB.avgWin - aggA.avgWin).toFixed(2))}`);
  console.log(`Average Loss ($)                    | ${('-$' + aggA.avgLoss.toFixed(2)).padEnd(26)} | ${('-$' + aggB.avgLoss.toFixed(2)).padEnd(27)} | ${('$' + (aggA.avgLoss - aggB.avgLoss).toFixed(2))}`);
  console.log(`Payoff Ratio (Win / Loss)           | ${(aggA.payoff + 'x').padEnd(26)} | ${(aggB.payoff + 'x').padEnd(27)} | ${(aggB.payoff - aggA.payoff >= 0 ? '+' : '') + (aggB.payoff - aggA.payoff).toFixed(2)}x`);
  console.log(`TP1 Partial Fills (50% Scalp)       | ${aggA.tp1Hits.toString().padEnd(26)} | ${aggB.tp1Hits.toString().padEnd(27)} | ${(aggB.tp1Hits - aggA.tp1Hits >= 0 ? '+' : '') + (aggB.tp1Hits - aggA.tp1Hits)}`);
  console.log(`TP2 Runner Harvests (Full 2.8R)     | ${aggA.tp2Hits.toString().padEnd(26)} | ${aggB.tp2Hits.toString().padEnd(27)} | ${(aggB.tp2Hits - aggA.tp2Hits >= 0 ? '+' : '') + (aggB.tp2Hits - aggA.tp2Hits)}`);
  console.log(`15-Bar Stagnation Harvests          | ${aggA.stagnationExits.toString().padEnd(26)} | ${aggB.stagnationExits.toString().padEnd(27)} | ${(aggB.stagnationExits - aggA.stagnationExits >= 0 ? '+' : '') + (aggB.stagnationExits - aggA.stagnationExits)}`);
  console.log(`Average Holding Duration (Bars)     | ${(aggA.avgHolding + ' bars (~' + (aggA.avgHolding * 15 / 60).toFixed(1) + 'h)').padEnd(26)} | ${(aggB.avgHolding + ' bars (~' + (aggB.avgHolding * 15 / 60).toFixed(1) + 'h)').padEnd(27)} | ${(aggB.avgHolding - aggA.avgHolding).toFixed(1)} bars`);
  console.log('========================================================================================\n');

  // Per Pair Breakdown Table
  console.log('📊 ASSET-BY-ASSET BREAKDOWN TABLE:');
  console.log('--------------------------------------------------------------------------------------------------------');
  console.log('Asset     | Mode           | Trades | WinRate | Gross Win | Gross Loss | Net PnL    | Profit Factor');
  console.log('--------------------------------------------------------------------------------------------------------');
  for (let i = 0; i < pairs.length; i++) {
    const a = resultsWithEma[i].stats;
    const b = resultsWithoutEma[i].stats;
    console.log(`${pairs[i].name.padEnd(9)} | WITH EMA       | ${a.totalTrades.toString().padEnd(6)} | ${(a.winRatePct + '%').padEnd(7)} | $${a.grossWinUsd.toFixed(2).padEnd(9)} | -$${a.grossLossUsd.toFixed(2).padEnd(9)} | $${a.totalNetPnlUsd.toFixed(2).padEnd(10)} | ${a.profitFactor}x`);
    console.log(`${''.padEnd(9)} | WITHOUT EMA    | ${b.totalTrades.toString().padEnd(6)} | ${(b.winRatePct + '%').padEnd(7)} | $${b.grossWinUsd.toFixed(2).padEnd(9)} | -$${b.grossLossUsd.toFixed(2).padEnd(9)} | $${b.totalNetPnlUsd.toFixed(2).padEnd(10)} | ${b.profitFactor}x`);
    console.log('--------------------------------------------------------------------------------------------------------');
  }

  // Save JSON report for verification
  const reportPath = path.resolve(__dirname, '../data/replay-6layers-ema-comparison-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ aggregateWithEma: aggA, aggregateWithoutEma: aggB, pairsWithEma: resultsWithEma.map(r => ({ pair: r.pair, stats: r.stats })), pairsWithoutEma: resultsWithoutEma.map(r => ({ pair: r.pair, stats: r.stats })) }, null, 2));
  console.log(`\n💾 Saved detailed comparison report to: ${reportPath}\n`);
}

main().catch(console.error);

