/**
 * 30-Day Historical Candle Replay: Robust Island SMA Market Bias & Dynamic Harvest Master
 * ─────────────────────────────────────────────────────────────────────────────
 * Combinatorial Grid Search & Layer Ablation across 11,520 real 15m candles
 * (BTC/USD, ETH/USD, SOL/USD, SUI/USD · September 30 to October 30, 2026):
 *
 * Features Tested:
 *   1. Robust Island SMA as primary Market Bias (Long vs. Short).
 *   2. Extra conviction weighting when fresh crossover occurs (<= 3 bars).
 *   3. Dynamic Harvest Master weighted by Robust Island momentum:
 *      - Widens runner targets (TP2 up to 3.2R) and breakeven cushion when aligned.
 *      - Tightens exits when counter-trend or approaching stagnation.
 *   4. Full Layer Ablation Matrix: Systematically tests all 32 on/off layer combinations
 *      across multiple Harvest Master tuning profiles (96 total permutations).
 *   5. Outputs the Top 3 Best Combinations with complete Long vs. Short metrics.
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

interface PrecomputedBar {
  index: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
  atr: number;
  rsi: number;
  adx: number;
  poc: number;
  vah: number;
  val: number;
  // Robust Island SMA metrics
  smaFast: number;
  smaSlow: number;
  smaBias: 'BULLISH' | 'BEARISH';
  isFreshGoldenCross: boolean; // within 3 bars
  isFreshDeathCross: boolean;  // within 3 bars
  barsSinceCross: number;
  // Layer 0 Kronos
  l0ExpectedReturn: number;
  l0EvRatio: number;
  l0Dir: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  l0Knife: boolean;
  l0Melt: boolean;
  // Layer 2 Order Flow
  l2FlowScore: number;
  l2VpinToxicity: number;
  l2Spoofed: boolean;
  // Layer 3 SMC
  l3Equilibrium: number;
  l3IsDiscount: boolean;
  l3IsPremium: boolean;
  l3TurtleSoupLong: boolean;
  l3TurtleSoupShort: boolean;
  l3FvgLong: boolean;
  l3FvgShort: boolean;
  // Layer 4 Traps
  lowerWickPct: number;
  upperWickPct: number;
}

interface LayerToggles {
  l0_kronos: boolean;
  l1_structure: boolean;
  l2_orderflow: boolean;
  l3_smc: boolean;
  l4_trap_shield: boolean;
  harvestProfile: 'DYNAMIC_RUNNER' | 'BALANCED_CUSHION' | 'TIGHT_SCALP';
}

interface ComboResult {
  configId: string;
  toggles: LayerToggles;
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  losses: number;
  longWins: number;
  shortWins: number;
  winRatePct: number;
  longWinRatePct: number;
  shortWinRatePct: number;
  totalNetPnlUsd: number;
  longNetPnlUsd: number;
  shortNetPnlUsd: number;
  grossWinUsd: number;
  grossLossUsd: number;
  profitFactor: number;
  payoffRatio: number;
  maxDrawdownUsd: number;
  compositeScore: number;
  stagnationExits: number;
  tp1Hits: number;
  tp2Hits: number;
}

// ── Indicator Functions ──────────────────────────────────────────────────────

function computeSma(prices: number[], period: number): number[] {
  const sma: number[] = new Array(prices.length).fill(prices[0]);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i];
    if (i >= period) sum -= prices[i - period];
    if (i >= period - 1) sma[i] = sum / period;
    else sma[i] = sum / (i + 1);
  }
  return sma;
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
  for (let b = 0; b < numBuckets; b++) {
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

// ── Robust Island Profiles ───────────────────────────────────────────────────
const ROBUST_ISLAND_PROFILES: Record<string, { fast: number; slow: number }> = {
  'BTC/USD': { fast: 18, slow: 64 },
  'ETH/USD': { fast: 14, slow: 52 },
  'SOL/USD': { fast: 12, slow: 48 },
  'SUI/USD': { fast: 9,  slow: 36 },
};

// ── Precomputation Engine ────────────────────────────────────────────────────

function precomputeBarsForPair(klines: Kline[], symbol: string): PrecomputedBar[] {
  const profile = ROBUST_ISLAND_PROFILES[symbol] || { fast: 12, slow: 48 };
  const closes = klines.map(k => k.close);
  const fastSma = computeSma(closes, profile.fast);
  const slowSma = computeSma(closes, profile.slow);
  const atrs = computeAtr(klines, 14);
  const rsis = computeRsi(closes, 14);
  const adxs = computeAdx(klines, 14);

  const precomputed: PrecomputedBar[] = [];
  let lastCrossBar = -100;
  let lastCrossType: 'GOLDEN' | 'DEATH' | 'NONE' = 'NONE';

  for (let i = 0; i < klines.length; i++) {
    const cur = klines[i];
    const prev = i > 0 ? klines[i - 1] : cur;
    const range = cur.high - cur.low || 1;
    const lowerWickPct = ((Math.min(cur.open, cur.close) - cur.low) / range) * 100;
    const upperWickPct = ((cur.high - Math.max(cur.open, cur.close)) / range) * 100;

    // SMA Cross & Bias
    const isGold = i > 0 && fastSma[i - 1] <= slowSma[i - 1] && fastSma[i] > slowSma[i];
    const isDeath = i > 0 && fastSma[i - 1] >= slowSma[i - 1] && fastSma[i] < slowSma[i];

    if (isGold) { lastCrossBar = i; lastCrossType = 'GOLDEN'; }
    else if (isDeath) { lastCrossBar = i; lastCrossType = 'DEATH'; }

    const barsSinceCross = i - lastCrossBar;
    const isFreshGoldenCross = lastCrossType === 'GOLDEN' && barsSinceCross <= 3;
    const isFreshDeathCross = lastCrossType === 'DEATH' && barsSinceCross <= 3;
    const smaBias: 'BULLISH' | 'BEARISH' = fastSma[i] >= slowSma[i] ? 'BULLISH' : 'BEARISH';

    // Box POC
    const box = computeBoxPoc(klines, i, 24);

    // Layer 0 Kronos proxy
    const sliceL0 = klines.slice(Math.max(0, i - 96), i + 1);
    const closesL0 = sliceL0.map(k => k.close);
    const returns: number[] = [];
    for (let j = 1; j < closesL0.length; j++) returns.push((closesL0[j] - closesL0[j - 1]) / closesL0[j - 1]);
    const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length || 1);
    const stdDev = Math.sqrt(variance) || 0.005;
    const horizonDrift = mean * 15;
    const horizonVol = stdDev * Math.sqrt(15);
    const l0ExpectedReturn = Number((horizonDrift * 100).toFixed(2));
    const upperBand = Math.abs(horizonDrift + 1.96 * horizonVol) * 100;
    const lowerBand = Math.abs(horizonDrift - 1.96 * horizonVol) * 100;
    const isBull = l0ExpectedReturn >= 0.20;
    const isBear = l0ExpectedReturn <= -0.20;
    const l0Dir: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = isBull ? 'BULLISH' : (isBear ? 'BEARISH' : 'NEUTRAL');
    const l0EvRatio = isBull ? upperBand / (lowerBand || 0.1) : lowerBand / (upperBand || 0.1);

    const recent = sliceL0.slice(-4);
    const vel = (recent[recent.length - 1].close - recent[0].close) / recent[0].close;
    const l0Knife = vel < -0.022;
    const l0Melt = vel > 0.022;

    // Layer 2 Flow proxy
    const slice30 = klines.slice(Math.max(0, i - 30), i + 1);
    const lastBody = Math.abs(cur.close - cur.open);
    const l2VpinToxicity = (lastBody / range) * (cur.volume / (slice30[0].volume || 1)) * 0.25;
    const l2Spoofed = (upperWickPct > 65 || lowerWickPct > 65) && cur.volume < slice30[0].volume * 0.6;
    const l2FlowScore = 15;

    // Layer 3 SMC proxy
    const slice20 = klines.slice(Math.max(0, i - 20), i);
    const hi20 = slice20.length > 0 ? Math.max(...slice20.map(k => k.high)) : cur.high;
    const lo20 = slice20.length > 0 ? Math.min(...slice20.map(k => k.low)) : cur.low;
    const l3Equilibrium = (hi20 + lo20) / 2;
    const l3IsDiscount = cur.close < l3Equilibrium;
    const l3IsPremium = cur.close > l3Equilibrium;
    const l3TurtleSoupLong = cur.low < lo20 && cur.close > lo20 && lowerWickPct >= 35;
    const l3TurtleSoupShort = cur.high > hi20 && cur.close < hi20 && upperWickPct >= 35;

    const prev2 = i >= 2 ? klines[i - 2] : cur;
    const l3FvgLong = i >= 2 && prev.low > prev2.high;
    const l3FvgShort = i >= 2 && prev.high < prev2.low;

    precomputed.push({
      index: i,
      open: cur.open,
      high: cur.high,
      low: cur.low,
      close: cur.close,
      volume: cur.volume,
      openTime: cur.openTime,
      atr: atrs[i] || cur.close * 0.008,
      rsi: rsis[i],
      adx: adxs[i],
      poc: box.poc,
      vah: box.vah,
      val: box.val,
      smaFast: fastSma[i],
      smaSlow: slowSma[i],
      smaBias,
      isFreshGoldenCross,
      isFreshDeathCross,
      barsSinceCross,
      l0ExpectedReturn,
      l0EvRatio,
      l0Dir,
      l0Knife,
      l0Melt,
      l2FlowScore,
      l2VpinToxicity,
      l2Spoofed,
      l3Equilibrium,
      l3IsDiscount,
      l3IsPremium,
      l3TurtleSoupLong,
      l3TurtleSoupShort,
      l3FvgLong,
      l3FvgShort,
      lowerWickPct,
      upperWickPct,
    });
  }

  return precomputed;
}

// ── Trade Simulation with Dynamic Harvest Master ─────────────────────────────

interface TradeResult {
  side: 'LONG' | 'SHORT';
  netPnlUsd: number;
  exitReason: string;
  tp1Hit: boolean;
  tp2Hit: boolean;
  barsHeld: number;
}

function simulateTradeHarvest(
  bars: PrecomputedBar[],
  entryIndex: number,
  side: 'LONG' | 'SHORT',
  harvestProfile: 'DYNAMIC_RUNNER' | 'BALANCED_CUSHION' | 'TIGHT_SCALP',
  isAlignedWithSma: boolean,
  capitalUsd = 40
): TradeResult {
  const entryBar = bars[entryIndex];
  const entryPrice = entryBar.close;
  const isLong = side === 'LONG';
  const atr = entryBar.atr;

  const slDist = Math.max(entryPrice * 0.006, atr * 1.25);
  const slDistPct = (slDist / entryPrice) * 100;
  const leverage = Math.min(10, Math.max(5, Math.floor(80 / slDistPct)));
  const notionalUsd = capitalUsd * leverage;
  const makerFeeRate = 0.0002;

  // Harvest Master Parameters dynamically modulated by Robust Island Bias:
  // When aligned with Robust Island SMA, extend runners and widen cushion!
  let tp1Mult = 1.6;
  let tp2Mult = 2.6;
  let beCushionPct = 0.006;
  let maxHorizonBars = 15;

  if (harvestProfile === 'DYNAMIC_RUNNER') {
    // Aggressive runner: aligned trades get wider room
    tp1Mult = isAlignedWithSma ? 1.8 : 1.4;
    tp2Mult = isAlignedWithSma ? 3.2 : 2.4;
    beCushionPct = isAlignedWithSma ? 0.008 : 0.005;
    maxHorizonBars = isAlignedWithSma ? 18 : 12;
  } else if (harvestProfile === 'BALANCED_CUSHION') {
    tp1Mult = 1.6;
    tp2Mult = 2.6;
    beCushionPct = 0.0075;
    maxHorizonBars = 15;
  } else if (harvestProfile === 'TIGHT_SCALP') {
    tp1Mult = 1.2;
    tp2Mult = 2.0;
    beCushionPct = 0.004;
    maxHorizonBars = 10;
  }

  let softSl = isLong ? entryPrice - slDist : entryPrice + slDist;
  const tp1Price = isLong ? entryPrice + slDist * tp1Mult : entryPrice - slDist * tp1Mult;
  const tp2Price = isLong ? entryPrice + slDist * tp2Mult : entryPrice - slDist * tp2Mult;

  let closed = false;
  let netPnlUsd = 0;
  let partialBankedUsd = 0;
  let activeSizeRatio = 1.0;
  let tp1Hit = false;
  let tp2Hit = false;
  let exitReason = 'TIMEOUT';
  let barsHeld = 0;

  for (let b = entryIndex + 1; b <= Math.min(bars.length - 1, entryIndex + maxHorizonBars); b++) {
    if (closed) break;
    barsHeld++;
    const bar = bars[b];

    // SL check
    const isSlHit = isLong ? bar.low <= softSl : bar.high >= softSl;
    if (isSlHit) {
      closed = true;
      exitReason = tp1Hit ? 'BREAKEVEN_CUSHION' : 'STOP_LOSS';
      const lossDist = isLong ? softSl - entryPrice : entryPrice - softSl;
      const lossRoi = (lossDist / entryPrice) * 100 * leverage;
      const lossPnl = (lossRoi / 100) * capitalUsd * activeSizeRatio - (notionalUsd * activeSizeRatio * makerFeeRate * 2);
      netPnlUsd = Number((partialBankedUsd + lossPnl).toFixed(2));
      break;
    }

    // TP1 check (50% scale out)
    if (!tp1Hit) {
      const isTp1Hit = isLong ? bar.high >= tp1Price : bar.low <= tp1Price;
      if (isTp1Hit) {
        tp1Hit = true;
        const winDist = Math.abs(tp1Price - entryPrice);
        const winRoi = (winDist / entryPrice) * 100 * leverage;
        const winPnl = (winRoi / 100) * capitalUsd * 0.5 - (notionalUsd * 0.5 * makerFeeRate * 2);
        partialBankedUsd = winPnl;
        activeSizeRatio = 0.5;

        // Advance SL to Breakeven + Dynamic Cushion
        softSl = isLong ? entryPrice * (1 + beCushionPct) : entryPrice * (1 - beCushionPct);
      }
    }

    // TP2 check (Runner full exit)
    if (tp1Hit) {
      const isTp2Hit = isLong ? bar.high >= tp2Price : bar.low <= tp2Price;
      if (isTp2Hit) {
        closed = true;
        tp2Hit = true;
        exitReason = 'TP2_RUNNER';
        const winDist = Math.abs(tp2Price - entryPrice);
        const winRoi = (winDist / entryPrice) * 100 * leverage;
        const winPnl = (winRoi / 100) * capitalUsd * 0.5 - (notionalUsd * 0.5 * makerFeeRate * 2);
        netPnlUsd = Number((partialBankedUsd + winPnl).toFixed(2));
        break;
      }
    }
  }

  if (!closed) {
    closed = true;
    exitReason = 'STAGNATION_HARVEST';
    const lastBar = bars[Math.min(bars.length - 1, entryIndex + maxHorizonBars)];
    const finalDist = isLong ? lastBar.close - entryPrice : entryPrice - lastBar.close;
    const finalRoi = (finalDist / entryPrice) * 100 * leverage;
    const finalPnl = (finalRoi / 100) * capitalUsd * activeSizeRatio - (notionalUsd * activeSizeRatio * makerFeeRate * 2);
    netPnlUsd = Number((partialBankedUsd + finalPnl).toFixed(2));
  }

  return { side, netPnlUsd, exitReason, tp1Hit, tp2Hit, barsHeld };
}

// ── Combinatorial Evaluation Loop ───────────────────────────────────────────

function evaluateCombination(
  pairDataMap: Record<string, PrecomputedBar[]>,
  toggles: LayerToggles
): ComboResult {
  const completedTrades: TradeResult[] = [];

  for (const [symbol, bars] of Object.entries(pairDataMap)) {
    let lastEntryBar = -50;

    for (let i = 80; i < bars.length - 20; i++) {
      if (i - lastEntryBar < 8) continue; // 8-bar cooldown
      const cur = bars[i];

      // Check candidate sides
      for (const side of ['LONG', 'SHORT'] as const) {
        const isLong = side === 'LONG';

        // 1. ROBUST ISLAND SMA MARKET BIAS & CROSSOVER WEIGHTING
        const isAlignedWithSma = (isLong && cur.smaBias === 'BULLISH') || (!isLong && cur.smaBias === 'BEARISH');
        const isFreshCross = (isLong && cur.isFreshGoldenCross) || (!isLong && cur.isFreshDeathCross);

        // Core weight from Robust Island SMA:
        // +18 pts if fresh crossover (highest momentum), +10 pts if general alignment, -12 pts if opposing
        let smaWeight = isFreshCross ? 18 : (isAlignedWithSma ? 10 : -12);

        // 2. LAYER 0: Kronos Neural Trajectory
        let l0Score = 0;
        if (toggles.l0_kronos) {
          const l0Aligned = (isLong && cur.l0Dir === 'BULLISH' && cur.l0ExpectedReturn >= 0.40 && cur.l0EvRatio >= 1.40) ||
                            (!isLong && cur.l0Dir === 'BEARISH' && cur.l0ExpectedReturn <= -0.40 && cur.l0EvRatio >= 1.40);
          if (l0Aligned) l0Score += 15;
          // Vetoes
          if (isLong && (cur.l0Knife || cur.l0ExpectedReturn <= -1.20)) continue;
          if (!isLong && (cur.l0Melt || cur.l0ExpectedReturn >= 1.20)) continue;
        }

        // 3. LAYER 1: Market Structure & Value Area POC
        let l1Score = 0;
        if (toggles.l1_structure) {
          const distPoc = Math.abs(cur.close - cur.poc) / cur.poc;
          const isPocRetest = distPoc <= 0.006 && (isLong ? cur.low <= cur.poc && cur.close >= cur.poc : cur.high >= cur.poc && cur.close <= cur.poc);
          if (isPocRetest) l1Score += 14;
          if (cur.adx >= 20) l1Score += 3;
          if (isLong && cur.rsi >= 40 && cur.rsi <= 65) l1Score += 3;
          if (!isLong && cur.rsi <= 60 && cur.rsi >= 35) l1Score += 3;
        }

        // 4. LAYER 2: Institutional Order Flow & CVD
        let l2Score = 0;
        if (toggles.l2_orderflow) {
          l2Score += cur.l2FlowScore;
          if (cur.l2Spoofed || cur.l2VpinToxicity > 0.45) continue; // Toxic flow veto
        }

        // 5. LAYER 3: Smart Money Concepts (50% Equilibrium & Turtle Soup)
        let l3Score = 0;
        if (toggles.l3_smc) {
          // 50% Equilibrium Gate: Never long in Premium (>50%), never short in Discount (<50%)
          if (isLong && !cur.l3IsDiscount) continue;
          if (!isLong && !cur.l3IsPremium) continue;

          if (isLong && cur.l3TurtleSoupLong) l3Score += 12;
          if (!isLong && cur.l3TurtleSoupShort) l3Score += 12;
          if (isLong && cur.l3FvgLong) l3Score += 5;
          if (!isLong && cur.l3FvgShort) l3Score += 5;
        }

        // 6. LAYER 4: AI Adversarial Risk Sentinel & Wick Trap Shield
        if (toggles.l4_trap_shield) {
          if (!isLong && cur.lowerWickPct >= 45) continue; // Trap short
          if (isLong && cur.upperWickPct >= 45) continue;  // Trap long
        }

        // Total Composite Score
        const baseAnchor = 35;
        const totalScore = baseAnchor + smaWeight + l0Score + l1Score + l2Score + l3Score;
        const confidence = Math.min(100, Math.max(0, totalScore));

        // Gate: Longs >= 70%, Shorts >= 75% + Kronos EV >= 1.40x
        const gate = isLong ? 70 : 75;
        const evPass = isLong || (toggles.l0_kronos ? cur.l0EvRatio >= 1.40 : true);

        if (confidence >= gate && evPass) {
          const trade = simulateTradeHarvest(bars, i, side, toggles.harvestProfile, isAlignedWithSma);
          completedTrades.push(trade);
          lastEntryBar = i;
          break; // 1 trade per bar max
        }
      }
    }
  }

  // Calculate Performance Metrics
  const totalTrades = completedTrades.length;
  const longs = completedTrades.filter(t => t.side === 'LONG');
  const shorts = completedTrades.filter(t => t.side === 'SHORT');
  const wins = completedTrades.filter(t => t.netPnlUsd > 0.05);
  const losses = completedTrades.filter(t => t.netPnlUsd < -0.05);
  const longWins = longs.filter(t => t.netPnlUsd > 0.05);
  const shortWins = shorts.filter(t => t.netPnlUsd > 0.05);

  const grossWinUsd = Number(wins.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2));
  const grossLossUsd = Number(Math.abs(losses.reduce((s, t) => s + t.netPnlUsd, 0)).toFixed(2));
  const totalNetPnlUsd = Number((grossWinUsd - grossLossUsd).toFixed(2));
  const longNetPnlUsd = Number(longs.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2));
  const shortNetPnlUsd = Number(shorts.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(2));

  const winRatePct = totalTrades > 0 ? Number(((wins.length / totalTrades) * 100).toFixed(1)) : 0;
  const longWinRatePct = longs.length > 0 ? Number(((longWins.length / longs.length) * 100).toFixed(1)) : 0;
  const shortWinRatePct = shorts.length > 0 ? Number(((shortWins.length / shorts.length) * 100).toFixed(1)) : 0;

  const avgWinUsd = wins.length > 0 ? Number((grossWinUsd / wins.length).toFixed(2)) : 0;
  const avgLossUsd = losses.length > 0 ? Number((grossLossUsd / losses.length).toFixed(2)) : 0;
  const payoffRatio = avgLossUsd > 0 ? Number((avgWinUsd / avgLossUsd).toFixed(2)) : 1.0;
  const profitFactor = grossLossUsd > 0 ? Number((grossWinUsd / grossLossUsd).toFixed(2)) : (grossWinUsd > 0 ? 99 : 0);

  let peak = 0;
  let maxDdUsd = 0;
  let running = 0;
  for (const t of completedTrades) {
    running += t.netPnlUsd;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDdUsd) maxDdUsd = dd;
  }

  const stagnationExits = completedTrades.filter(t => t.exitReason === 'STAGNATION_HARVEST').length;
  const tp1Hits = completedTrades.filter(t => t.tp1Hit).length;
  const tp2Hits = completedTrades.filter(t => t.tp2Hit).length;

  // Composite Score: Balances Net PnL, Profit Factor, sample size reliability, and drawdown
  const compositeScore = totalTrades >= 15
    ? Number((totalNetPnlUsd * Math.min(2.5, profitFactor) * (winRatePct / 100) * Math.log10(totalTrades) / (1 + maxDdUsd / 50)).toFixed(2))
    : -999;

  const configId = `L0:${toggles.l0_kronos ? '1' : '0'}|L1:${toggles.l1_structure ? '1' : '0'}|L2:${toggles.l2_orderflow ? '1' : '0'}|L3:${toggles.l3_smc ? '1' : '0'}|L4:${toggles.l4_trap_shield ? '1' : '0'}|H:${toggles.harvestProfile}`;

  return {
    configId,
    toggles,
    totalTrades,
    longTrades: longs.length,
    shortTrades: shorts.length,
    wins: wins.length,
    losses: losses.length,
    longWins: longWins.length,
    shortWins: shortWins.length,
    winRatePct,
    longWinRatePct,
    shortWinRatePct,
    totalNetPnlUsd,
    longNetPnlUsd,
    shortNetPnlUsd,
    grossWinUsd,
    grossLossUsd,
    profitFactor,
    payoffRatio,
    maxDrawdownUsd: Number(maxDdUsd.toFixed(2)),
    compositeScore,
    stagnationExits,
    tp1Hits,
    tp2Hits,
  };
}

// ── Main Runner ───────────────────────────────────────────────────────────────

async function main() {
  console.log('\n========================================================================================');
  console.log('🏛️  TRADING_AUTONOMOUSE COMBINATORIAL OPTIMIZATION & LAYER ABLATION GRID SEARCH');
  console.log('🔬  ROBUST ISLAND SMA MARKET BIAS + DYNAMIC HARVEST MASTER + 6-LAYER PERMUTATIONS');
  console.log('========================================================================================\n');

  const dataDir = path.resolve(__dirname, '../data');
  const pairs = [
    { name: 'BTC/USD', file: 'btc_1month_15m.json' },
    { name: 'ETH/USD', file: 'eth_1month_15m.json' },
    { name: 'SOL/USD', file: 'sol_1month_15m.json' },
    { name: 'SUI/USD', file: 'sui_1month_15m.json' },
  ];

  console.log('📥 Precomputing technical and microstructure features across all 4 assets (11,520 bars)...');
  const pairDataMap: Record<string, PrecomputedBar[]> = {};

  for (const p of pairs) {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, p.file), 'utf8'));
    const klines: Kline[] = raw.map((k: any) => ({
      openTime: k.openTime || k.time,
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
      volume: parseFloat(k.volume),
      closeTime: k.closeTime || (k.openTime + 15 * 60 * 1000 - 1),
    }));
    pairDataMap[p.name] = precomputeBarsForPair(klines, p.name);
    console.log(`   ✓ ${p.name.padEnd(8)}: Loaded & precomputed ${pairDataMap[p.name].length} bars.`);
  }

  // Generate All Combinatorial Configurations: 32 Layer Toggle Combos x 3 Harvest Profiles = 96 Permutations
  const harvestProfiles: LayerToggles['harvestProfile'][] = ['DYNAMIC_RUNNER', 'BALANCED_CUSHION', 'TIGHT_SCALP'];
  const allConfigs: LayerToggles[] = [];

  for (let l0 = 0; l0 <= 1; l0++) {
    for (let l1 = 0; l1 <= 1; l1++) {
      for (let l2 = 0; l2 <= 1; l2++) {
        for (let l3 = 0; l3 <= 1; l3++) {
          for (let l4 = 0; l4 <= 1; l4++) {
            for (const h of harvestProfiles) {
              allConfigs.push({
                l0_kronos: l0 === 1,
                l1_structure: l1 === 1,
                l2_orderflow: l2 === 1,
                l3_smc: l3 === 1,
                l4_trap_shield: l4 === 1,
                harvestProfile: h,
              });
            }
          }
        }
      }
    }
  }

  console.log(`\n🧪 Generated ${allConfigs.length} distinct quantitative strategy configurations.`);
  console.log('⚡ Running high-speed multi-asset backtest across all 96 permutations...\n');

  const results: ComboResult[] = [];

  for (const cfg of allConfigs) {
    const res = evaluateCombination(pairDataMap, cfg);
    results.push(res);
  }

  // Filter valid configurations (at least 20 trades to ensure statistical significance)
  const valid = results.filter(r => r.totalTrades >= 20);

  // Sort by Best Net PnL and Profit Factor
  valid.sort((a, b) => {
    // Primary sort: Net PnL, then Profit Factor
    if (b.totalNetPnlUsd !== a.totalNetPnlUsd) {
      return b.totalNetPnlUsd - a.totalNetPnlUsd;
    }
    return b.profitFactor - a.profitFactor;
  });

  const top3 = valid.slice(0, 3);

  console.log('========================================================================================');
  console.log('🏆 TOP 3 BEST QUANTITATIVE COMBINATIONS (DISCOVERED OUT OF 96 PERMUTATIONS)');
  console.log('========================================================================================\n');

  top3.forEach((c, idx) => {
    const t = c.toggles;
    console.log(`🥇 RANK #${idx + 1}: ${c.configId}`);
    console.log(`   ├─ Active Layers: L0(Kronos)=${t.l0_kronos?'ON':'OFF'} | L1(Structure/POC)=${t.l1_structure?'ON':'OFF'} | L2(Flow/CVD)=${t.l2_orderflow?'ON':'OFF'} | L3(SMC/Equilibrium)=${t.l3_smc?'ON':'OFF'} | L4(TrapShield)=${t.l4_trap_shield?'ON':'OFF'}`);
    console.log(`   ├─ Harvest Master Profile: ${t.harvestProfile}`);
    console.log(`   ├─ 📊 Trades Executed: ${c.totalTrades} total [🟢 ${c.longTrades} LONGs (${((c.longTrades/c.totalTrades)*100).toFixed(0)}%) | 🔴 ${c.shortTrades} SHORTs (${((c.shortTrades/c.totalTrades)*100).toFixed(0)}%)]`);
    console.log(`   ├─ 🎯 Win Rate: ${c.winRatePct}% [🟢 Longs: ${c.longWinRatePct}% (${c.longWins}/${c.longTrades}) | 🔴 Shorts: ${c.shortWinRatePct}% (${c.shortWins}/${c.shortTrades})]`);
    console.log(`   ├─ 💰 TOTAL NET PnL: $${c.totalNetPnlUsd > 0 ? '+' : ''}${c.totalNetPnlUsd.toFixed(2)} (Gross Win: +$${c.grossWinUsd.toFixed(2)} | Gross Loss: -$${c.grossLossUsd.toFixed(2)})`);
    console.log(`   ├─ 💵 Directional PnL: 🟢 Longs: $${c.longNetPnlUsd > 0 ? '+' : ''}${c.longNetPnlUsd.toFixed(2)} | 🔴 Shorts: $${c.shortNetPnlUsd > 0 ? '+' : ''}${c.shortNetPnlUsd.toFixed(2)}`);
    console.log(`   ├─ 📈 Profit Factor: ${c.profitFactor}x | Payoff Ratio: ${c.payoffRatio}x | Max Drawdown: -$${c.maxDrawdownUsd.toFixed(2)}`);
    console.log(`   └─ ⏱️ Harvest Telemetry: TP1 Hits=${c.tp1Hits} | TP2 Runners=${c.tp2Hits} | Stagnation Exits=${c.stagnationExits}\n`);
  });

  // Print Comparison Table of Top 3
  console.log('========================================================================================');
  console.log('📊 SIDE-BY-SIDE SCORECARD OF TOP 3 BEST COMBINATIONS');
  console.log('========================================================================================');
  console.log(`METRIC                     | #1 BEST CHAMPION            | #2 RUNNER-UP                | #3 THIRD PLACE`);
  console.log('---------------------------+-----------------------------+-----------------------------+-----------------------------');
  console.log(`Configuration ID           | ${top3[0].configId.padEnd(27)} | ${top3[1].configId.padEnd(27)} | ${top3[2].configId.padEnd(27)}`);
  console.log(`Harvest Master Profile     | ${top3[0].toggles.harvestProfile.padEnd(27)} | ${top3[1].toggles.harvestProfile.padEnd(27)} | ${top3[2].toggles.harvestProfile.padEnd(27)}`);
  console.log(`Total Trades               | ${top3[0].totalTrades.toString().padEnd(27)} | ${top3[1].totalTrades.toString().padEnd(27)} | ${top3[2].totalTrades.toString().padEnd(27)}`);
  console.log(`  ├─ 🟢 LONG Trades        | ${(top3[0].longTrades + ' (' + ((top3[0].longTrades/top3[0].totalTrades)*100).toFixed(0) + '%)').padEnd(27)} | ${(top3[1].longTrades + ' (' + ((top3[1].longTrades/top3[1].totalTrades)*100).toFixed(0) + '%)').padEnd(27)} | ${(top3[2].longTrades + ' (' + ((top3[2].longTrades/top3[2].totalTrades)*100).toFixed(0) + '%)').padEnd(27)}`);
  console.log(`  └─ 🔴 SHORT Trades       | ${(top3[0].shortTrades + ' (' + ((top3[0].shortTrades/top3[0].totalTrades)*100).toFixed(0) + '%)').padEnd(27)} | ${(top3[1].shortTrades + ' (' + ((top3[1].shortTrades/top3[1].totalTrades)*100).toFixed(0) + '%)').padEnd(27)} | ${(top3[2].shortTrades + ' (' + ((top3[2].shortTrades/top3[2].totalTrades)*100).toFixed(0) + '%)').padEnd(27)}`);
  console.log(`Overall Win Rate (%)       | ${(top3[0].winRatePct + '%').padEnd(27)} | ${(top3[1].winRatePct + '%').padEnd(27)} | ${(top3[2].winRatePct + '%').padEnd(27)}`);
  console.log(`  ├─ 🟢 LONG Win Rate      | ${(top3[0].longWinRatePct + '%').padEnd(27)} | ${(top3[1].longWinRatePct + '%').padEnd(27)} | ${(top3[2].longWinRatePct + '%').padEnd(27)}`);
  console.log(`  └─ 🔴 SHORT Win Rate     | ${(top3[0].shortWinRatePct + '%').padEnd(27)} | ${(top3[1].shortWinRatePct + '%').padEnd(27)} | ${(top3[2].shortWinRatePct + '%').padEnd(27)}`);
  console.log(`TOTAL NET PnL ($)          | ${('$' + (top3[0].totalNetPnlUsd > 0 ? '+' : '') + top3[0].totalNetPnlUsd.toFixed(2)).padEnd(27)} | ${('$' + (top3[1].totalNetPnlUsd > 0 ? '+' : '') + top3[1].totalNetPnlUsd.toFixed(2)).padEnd(27)} | ${('$' + (top3[2].totalNetPnlUsd > 0 ? '+' : '') + top3[2].totalNetPnlUsd.toFixed(2)).padEnd(27)}`);
  console.log(`  ├─ 🟢 LONG Net PnL ($)   | ${('$' + (top3[0].longNetPnlUsd > 0 ? '+' : '') + top3[0].longNetPnlUsd.toFixed(2)).padEnd(27)} | ${('$' + (top3[1].longNetPnlUsd > 0 ? '+' : '') + top3[1].longNetPnlUsd.toFixed(2)).padEnd(27)} | ${('$' + (top3[2].longNetPnlUsd > 0 ? '+' : '') + top3[2].longNetPnlUsd.toFixed(2)).padEnd(27)}`);
  console.log(`  └─ 🔴 SHORT Net PnL ($)  | ${('$' + (top3[0].shortNetPnlUsd > 0 ? '+' : '') + top3[0].shortNetPnlUsd.toFixed(2)).padEnd(27)} | ${('$' + (top3[1].shortNetPnlUsd > 0 ? '+' : '') + top3[1].shortNetPnlUsd.toFixed(2)).padEnd(27)} | ${('$' + (top3[2].shortNetPnlUsd > 0 ? '+' : '') + top3[2].shortNetPnlUsd.toFixed(2)).padEnd(27)}`);
  console.log(`Profit Factor              | ${(top3[0].profitFactor + 'x').padEnd(27)} | ${(top3[1].profitFactor + 'x').padEnd(27)} | ${(top3[2].profitFactor + 'x').padEnd(27)}`);
  console.log(`Max Drawdown ($)           | ${('-$' + top3[0].maxDrawdownUsd.toFixed(2)).padEnd(27)} | ${('-$' + top3[1].maxDrawdownUsd.toFixed(2)).padEnd(27)} | ${('-$' + top3[2].maxDrawdownUsd.toFixed(2)).padEnd(27)}`);
  console.log(`TP1 Scalp Fills            | ${top3[0].tp1Hits.toString().padEnd(27)} | ${top3[1].tp1Hits.toString().padEnd(27)} | ${top3[2].tp1Hits.toString().padEnd(27)}`);
  console.log(`TP2 Runners Captured       | ${top3[0].tp2Hits.toString().padEnd(27)} | ${top3[1].tp2Hits.toString().padEnd(27)} | ${top3[2].tp2Hits.toString().padEnd(27)}`);
  console.log(`15-Bar Stagnation Exits    | ${top3[0].stagnationExits.toString().padEnd(27)} | ${top3[1].stagnationExits.toString().padEnd(27)} | ${top3[2].stagnationExits.toString().padEnd(27)}`);
  console.log('========================================================================================\n');

  // Save report
  const outPath = path.resolve(__dirname, '../data/best-3-combinations-robust-sma-harvest.json');
  fs.writeFileSync(outPath, JSON.stringify({ top3, allValidCount: valid.length, totalPermutationsTested: allConfigs.length }, null, 2));
  console.log(`💾 Saved complete grid search report to: ${outPath}\n`);
}

main().catch(console.error);

