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

// Technical Indicator Helpers
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

interface Trade {
  side: 'LONG' | 'SHORT';
  netPnlUsd: number;
}

function simulateTrade(
  klines: Kline[],
  entryIndex: number,
  side: 'LONG' | 'SHORT',
  atr: number,
  capitalUsd = 40
): Trade {
  const cur = klines[entryIndex];
  const entryPrice = cur.close;
  const slDist = Math.max(entryPrice * 0.006, atr * 1.25);
  const slDistPct = (slDist / entryPrice) * 100;
  const leverage = Math.min(10, Math.max(5, Math.floor(80 / slDistPct)));
  const notionalUsd = capitalUsd * leverage;

  const isLong = side === 'LONG';
  let softSl = isLong ? entryPrice - slDist : entryPrice + slDist;
  const tp1Dist = slDist * 1.8;
  const tp2Dist = slDist * 2.8;
  const takeProfit1 = isLong ? entryPrice + tp1Dist : entryPrice - tp1Dist;
  const takeProfit2 = isLong ? entryPrice + tp2Dist : entryPrice - tp2Dist;
  const makerFeeRate = 0.0002;

  let closed = false;
  let netPnlUsd = 0;
  let partialBankedUsd = 0;
  let activeSizeRatio = 1.0;
  let tp1Hit = false;
  let breakevenMoved = false;

  const maxBars = 15;
  for (let b = entryIndex + 1; b <= Math.min(klines.length - 1, entryIndex + maxBars); b++) {
    if (closed) break;
    const bar = klines[b];

    const isSlHit = isLong ? bar.low <= softSl : bar.high >= softSl;
    if (isSlHit) {
      closed = true;
      const lossDist = isLong ? softSl - entryPrice : entryPrice - softSl;
      const lossRoi = (lossDist / entryPrice) * 100 * leverage;
      const lossPnl = (lossRoi / 100) * capitalUsd * activeSizeRatio - (notionalUsd * activeSizeRatio * makerFeeRate * 2);
      netPnlUsd = Number((partialBankedUsd + lossPnl).toFixed(2));
      break;
    }

    if (!tp1Hit) {
      const isTp1Hit = isLong ? bar.high >= takeProfit1 : bar.low <= takeProfit1;
      if (isTp1Hit) {
        const winDist = tp1Dist;
        const winRoi = (winDist / entryPrice) * 100 * leverage;
        const winPnl = (winRoi / 100) * capitalUsd * 0.5 - (notionalUsd * 0.5 * makerFeeRate * 2);
        partialBankedUsd = winPnl;
        activeSizeRatio = 0.5;
        tp1Hit = true;
        breakevenMoved = true;
        softSl = isLong ? Number((entryPrice * 1.0075).toFixed(4)) : Number((entryPrice * 0.9925).toFixed(4));
      }
    }

    if (tp1Hit) {
      const isTp2Hit = isLong ? bar.high >= takeProfit2 : bar.low <= takeProfit2;
      if (isTp2Hit) {
        closed = true;
        const runnerDist = tp2Dist;
        const runnerRoi = (runnerDist / entryPrice) * 100 * leverage;
        const runnerPnl = (runnerRoi / 100) * capitalUsd * 0.5 - (notionalUsd * 0.5 * makerFeeRate * 2);
        netPnlUsd = Number((partialBankedUsd + runnerPnl).toFixed(2));
        break;
      }
    }
  }

  if (!closed) {
    closed = true;
    const lastBar = klines[Math.min(klines.length - 1, entryIndex + maxBars)];
    const finalDist = isLong ? lastBar.close - entryPrice : entryPrice - lastBar.close;
    const finalRoi = (finalDist / entryPrice) * 100 * leverage;
    const finalPnl = (finalRoi / 100) * capitalUsd * activeSizeRatio - (notionalUsd * activeSizeRatio * makerFeeRate * 2);
    netPnlUsd = Number((partialBankedUsd + finalPnl).toFixed(2));
  }

  return { side, netPnlUsd };
}

// Layer 0
function evaluateL0(klines: Kline[], i: number, side: 'LONG' | 'SHORT') {
  const slice = klines.slice(Math.max(0, i - 128), i + 1);
  const closes = slice.map(k => k.close);
  const returns: number[] = [];
  for (let j = 1; j < closes.length; j++) returns.push((closes[j] - closes[j - 1]) / closes[j - 1]);
  const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length || 1);
  const stdDev = Math.sqrt(variance) || 0.005;

  const horizonDrift = mean * 15;
  const horizonVol = stdDev * Math.sqrt(15);
  const expectedReturnPct = Number((horizonDrift * 100).toFixed(2));
  const upperBandPct = Math.abs(horizonDrift + 1.96 * horizonVol) * 100;
  const lowerBandPct = Math.abs(horizonDrift - 1.96 * horizonVol) * 100;
  const isBull = expectedReturnPct >= 0.20;
  const isBear = expectedReturnPct <= -0.20;
  const dir = isBull ? 'BULLISH' : (isBear ? 'BEARISH' : 'NEUTRAL');
  const evRatio = isBull ? upperBandPct / (lowerBandPct || 0.1) : lowerBandPct / (upperBandPct || 0.1);

  const recent = slice.slice(-4);
  const vel = (recent[recent.length - 1].close - recent[0].close) / recent[0].close;
  const knife = vel < -0.025 ? 0.85 : 0.15;
  const melt = vel > 0.025 ? 0.85 : 0.15;

  const isAligned = (side === 'LONG' && dir === 'BULLISH' && expectedReturnPct >= 0.40 && evRatio >= 1.40) ||
                    (side === 'SHORT' && dir === 'BEARISH' && expectedReturnPct <= -0.40 && evRatio >= 1.40);
  const bonusPts = isAligned ? 15 : 0;

  let veto = false;
  if (side === 'LONG' && knife >= 0.70) veto = true;
  if (side === 'SHORT' && melt >= 0.70) veto = true;
  if (side === 'LONG' && expectedReturnPct <= -1.20) veto = true;
  if (side === 'SHORT' && expectedReturnPct >= 1.20) veto = true;

  return { bonusPts, evRatio, veto };
}

// Layer 2
function evaluateL2(klines: Kline[], i: number) {
  const slice = klines.slice(Math.max(0, i - 30), i + 1);
  const lastBar = klines[i];
  const lastRange = lastBar.high - lastBar.low || 1;
  const lastBody = Math.abs(lastBar.close - lastBar.open);
  const vpin = (lastBody / lastRange) * (lastBar.volume / (slice[0].volume || 1)) * 0.25;
  const upperWick = lastBar.high - Math.max(lastBar.open, lastBar.close);
  const lowerWick = Math.min(lastBar.open, lastBar.close) - lastBar.low;
  const isSpoofed = (upperWick / lastRange > 0.65 || lowerWick / lastRange > 0.65) && lastBar.volume < slice[0].volume * 0.6;
  return { flowScore: 16, vpin, isSpoofed };
}

// Layer 3
function evaluateL3(klines: Kline[], i: number, side: 'LONG' | 'SHORT') {
  const slice20 = klines.slice(Math.max(0, i - 20), i);
  const cur = klines[i];
  const hi = Math.max(...slice20.map(k => k.high));
  const lo = Math.min(...slice20.map(k => k.low));
  const eq = (hi + lo) / 2;
  const veto = (side === 'LONG' && cur.close > eq) || (side === 'SHORT' && cur.close < eq);
  return { smcScore: 10, veto };
}

// Layer 4
function evaluateL4(cur: Kline, side: 'LONG' | 'SHORT', l2: any, l0: any) {
  const range = cur.high - cur.low || 1;
  const lowerWickPct = ((Math.min(cur.open, cur.close) - cur.low) / range) * 100;
  const upperWickPct = ((cur.high - Math.max(cur.open, cur.close)) / range) * 100;
  if (side === 'SHORT' && lowerWickPct >= 45) return false;
  if (side === 'LONG' && upperWickPct >= 45) return false;
  if (l2.isSpoofed || l2.vpin > 0.45) return false;
  if (l0.veto) return false;
  return true;
}

// Layer 1
function evaluateL1(cur: Kline, box: any, rsi: number, adx: number, side: 'LONG' | 'SHORT') {
  const distPoc = Math.abs(cur.close - box.poc) / box.poc;
  const isPoc = distPoc <= 0.006 && (side === 'LONG' ? cur.low <= box.poc && cur.close >= box.poc : cur.high >= box.poc && cur.close <= box.poc);
  let s = 5;
  if (isPoc) s += 12;
  if (adx >= 20) s += 3;
  if (side === 'LONG' && rsi >= 40 && rsi <= 65) s += 2;
  if (side === 'SHORT' && rsi <= 60 && rsi >= 35) s += 2;
  return s;
}

async function run() {
  const dataDir = path.resolve('./data');
  const pairs = [
    { name: 'BTC/USD', file: 'btc_1month_15m.json', fast: 18, slow: 64 },
    { name: 'ETH/USD', file: 'eth_1month_15m.json', fast: 14, slow: 52 },
    { name: 'SOL/USD', file: 'sol_1month_15m.json', fast: 12, slow: 48 },
    { name: 'SUI/USD', file: 'sui_1month_15m.json', fast: 9, slow: 36 },
  ];

  console.log('========================================================================================');
  console.log('📊 COMPREHENSIVE LONG VS. SHORT BREAKDOWN ANALYSIS (ALL 4 PAIRS · 30 DAYS)');
  console.log('========================================================================================\n');

  // We will collect trades for:
  // 1. Robust Island SMA Crossover Only (Engine B)
  // 2. Robust Island SMA Cross + Retest (Engine C)
  // 3. Continuous 6 Layers Scan (Engine A)

  const modes = ['ENGINE_B_STRICT_CROSS', 'ENGINE_C_CROSS_PULLBACK', 'ENGINE_A_CONTINUOUS'] as const;

  for (const mode of modes) {
    const modeLabel =
      mode === 'ENGINE_B_STRICT_CROSS'
        ? 'ENGINE B: STRICT ROBUST ISLAND SMA CROSSOVER ONLY'
        : mode === 'ENGINE_C_CROSS_PULLBACK'
        ? 'ENGINE C: ROBUST ISLAND SMA CROSSOVER + RETEST'
        : 'ENGINE A: CONTINUOUS 6-LAYER SCAN';

    console.log(`----------------------------------------------------------------------------------------`);
    console.log(`🎯 ${modeLabel}`);
    console.log(`----------------------------------------------------------------------------------------`);

    let aggLongTrades = 0, aggLongWins = 0, aggLongLosses = 0, aggLongPnl = 0;
    let aggShortTrades = 0, aggShortWins = 0, aggShortLosses = 0, aggShortPnl = 0;

    for (const p of pairs) {
      const klines: Kline[] = JSON.parse(fs.readFileSync(path.join(dataDir, p.file), 'utf8')).map((k: any) => ({
        openTime: k.openTime || k.time,
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.volume),
        closeTime: k.closeTime || (k.openTime + 15 * 60 * 1000 - 1),
      }));

      const closes = klines.map(k => k.close);
      const fSma = computeSma(closes, p.fast);
      const sSma = computeSma(closes, p.slow);
      const atrs = computeAtr(klines, 14);
      const rsis = computeRsi(closes, 14);
      const adxs = computeAdx(klines, 14);

      let pLongTrades = 0, pLongWins = 0, pLongLosses = 0, pLongPnl = 0;
      let pShortTrades = 0, pShortWins = 0, pShortLosses = 0, pShortPnl = 0;
      let lastEntryBar = -50;

      for (let i = Math.max(p.slow + 2, 80); i < klines.length - 20; i++) {
        const cur = klines[i];
        const atr = atrs[i] || cur.close * 0.008;
        const box = computeBoxPoc(klines, i, 24);

        const isGoldExact = fSma[i - 1] <= sSma[i - 1] && fSma[i] > sSma[i];
        const isDeathExact = fSma[i - 1] >= sSma[i - 1] && fSma[i] < sSma[i];
        const isRecGold = [1, 2, 3].some(o => (i - o > 0) && fSma[i - o - 1] <= sSma[i - o - 1] && fSma[i - o] > sSma[i - o]);
        const isRecDeath = [1, 2, 3].some(o => (i - o > 0) && fSma[i - o - 1] >= sSma[i - o - 1] && fSma[i - o] < sSma[i - o]);

        let side: 'LONG' | 'SHORT' | null = null;

        if (mode === 'ENGINE_B_STRICT_CROSS') {
          if (isGoldExact) side = 'LONG';
          else if (isDeathExact) side = 'SHORT';
        } else if (mode === 'ENGINE_C_CROSS_PULLBACK') {
          if (isGoldExact) side = 'LONG';
          else if (isDeathExact) side = 'SHORT';
          else if (isRecGold && cur.low <= box.poc && cur.close >= box.poc) side = 'LONG';
          else if (isRecDeath && cur.high >= box.poc && cur.close <= box.poc) side = 'SHORT';
        } else {
          // Continuous
          if (fSma[i] > sSma[i]) side = 'LONG';
          else if (fSma[i] < sSma[i]) side = 'SHORT';
        }

        if (!side) continue;
        if (i - lastEntryBar < 8) continue;

        // 6 layers evaluation
        const l0 = evaluateL0(klines, i, side);
        const l2 = evaluateL2(klines, i);
        const l3 = evaluateL3(klines, i, side);
        const l4Pass = evaluateL4(cur, side, l2, l0);

        if (!l4Pass || l3.veto) continue;

        const l1Score = evaluateL1(cur, box, rsis[i], adxs[i], side);
        const smaBonus = 15;
        const totalScore = l1Score + l2.flowScore + l3.smcScore + l0.bonusPts + smaBonus + 35;
        const gate = side === 'LONG' ? 70 : 75;
        const evPass = side === 'LONG' || l0.evRatio >= 1.40;

        if (totalScore >= gate && evPass) {
          const t = simulateTrade(klines, i, side, atr);
          lastEntryBar = i;

          if (side === 'LONG') {
            pLongTrades++;
            pLongPnl += t.netPnlUsd;
            if (t.netPnlUsd > 0.05) pLongWins++;
            else if (t.netPnlUsd < -0.05) pLongLosses++;
          } else {
            pShortTrades++;
            pShortPnl += t.netPnlUsd;
            if (t.netPnlUsd > 0.05) pShortWins++;
            else if (t.netPnlUsd < -0.05) pShortLosses++;
          }
        }
      }

      console.log(`  ${p.name.padEnd(8)}:`);
      console.log(`    🟢 LONGs  : ${pLongTrades} trades | Wins=${pLongWins} | Losses=${pLongLosses} | WR=${pLongTrades > 0 ? ((pLongWins / pLongTrades) * 100).toFixed(1) : 0}% | Net PnL=$${pLongPnl.toFixed(2)}`);
      console.log(`    🔴 SHORTs : ${pShortTrades} trades | Wins=${pShortWins} | Losses=${pShortLosses} | WR=${pShortTrades > 0 ? ((pShortWins / pShortTrades) * 100).toFixed(1) : 0}% | Net PnL=$${pShortPnl.toFixed(2)}`);

      aggLongTrades += pLongTrades;
      aggLongWins += pLongWins;
      aggLongLosses += pLongLosses;
      aggLongPnl += pLongPnl;

      aggShortTrades += pShortTrades;
      aggShortWins += pShortWins;
      aggShortLosses += pShortLosses;
      aggShortPnl += pShortPnl;
    }

    const totalTrades = aggLongTrades + aggShortTrades;
    console.log(`\n  🏆 COMBINED TOTAL FOR ${modeLabel}:`);
    console.log(`    🟢 ALL LONGS  : ${aggLongTrades} trades (${totalTrades > 0 ? ((aggLongTrades / totalTrades) * 100).toFixed(1) : 0}%) | Wins=${aggLongWins} | Losses=${aggLongLosses} | WR=${aggLongTrades > 0 ? ((aggLongWins / aggLongTrades) * 100).toFixed(1) : 0}% | Net PnL=$${aggLongPnl.toFixed(2)}`);
    console.log(`    🔴 ALL SHORTS : ${aggShortTrades} trades (${totalTrades > 0 ? ((aggShortTrades / totalTrades) * 100).toFixed(1) : 0}%) | Wins=${aggShortWins} | Losses=${aggShortLosses} | WR=${aggShortTrades > 0 ? ((aggShortWins / aggShortTrades) * 100).toFixed(1) : 0}% | Net PnL=$${aggShortPnl.toFixed(2)}`);
    console.log(`    ⚖️  RATIO      : ${(aggLongTrades / Math.max(1, aggShortTrades)).toFixed(2)} Longs per Short\n`);
  }
}

run().catch(console.error);

