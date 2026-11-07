/**
 * Mathematical Evaluation: Price Crossover & Retest of Fast Robust SMA
 * ─────────────────────────────────────────────────────────────────────────────
 * Rigorous Statistical & Probabilistic Analysis across 11,520 real 15m candles:
 *
 * 1. PRE-TRADE EVALUATION:
 *    - Model A: Baseline Champion (POC Retest + Robust Island SMA Bias)
 *    - Model B: Price Cross Over Fast Robust SMA (Momentum Breakout)
 *    - Model C: Price Pullback Retest of Fast Robust SMA (Dynamic Support/Resistance Retest)
 *    - Model D: Dual Confluence (POC Retest AND Fast SMA Retest)
 *
 * 2. DURING-TRADE HARVEST MASTER EVALUATION:
 *    - Probability Distribution: What happens after Price crosses back against Fast SMA?
 *      P(Reaches TP2 | Price crosses Fast SMA) vs P(Reaches SL | Price crosses Fast SMA)
 *    - Harvest Rule 1: Standard Harvest Master (TP1 at 1.6R, BE Cushion +0.65R, TP2 at 2.6R)
 *    - Harvest Rule 2: Immediate Early Exit when Price Closes Across Fast SMA
 *    - Harvest Rule 3: Dynamic Stop Tightening (Trail SL to Fast SMA or Breakeven when Price touches Fast SMA)
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

interface AnalyzedBar {
  index: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  atr: number;
  poc: number;
  smaFast: number;
  smaSlow: number;
  smaFastSlope: number;
  smaBias: 'BULLISH' | 'BEARISH';
  isFreshSmaCross: boolean;
  // Price vs Fast SMA events
  priceCrossedAboveFast: boolean;
  priceCrossedBelowFast: boolean;
  priceRetestedFastAsSupport: boolean; // Low touched Fast SMA within 0.35%, Close stayed above
  priceRetestedFastAsResistance: boolean; // High touched Fast SMA within 0.35%, Close stayed below
  // 6 Layers
  l0PassLong: boolean;
  l0PassShort: boolean;
  l1PocPassLong: boolean;
  l1PocPassShort: boolean;
  l2FlowPass: boolean;
  l4TrapShieldPassLong: boolean;
  l4TrapShieldPassShort: boolean;
}

const ROBUST_ISLAND_PAIRS: Record<string, { fast: number; slow: number }> = {
  'BTC/USD': { fast: 18, slow: 64 },
  'ETH/USD': { fast: 14, slow: 52 },
  'SOL/USD': { fast: 12, slow: 48 },
  'SUI/USD': { fast: 9,  slow: 36 },
};

function computeSma(prices: number[], period: number): number[] {
  const result: number[] = new Array(prices.length).fill(0);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i];
    if (i >= period) sum -= prices[i - period];
    result[i] = i >= period - 1 ? sum / period : prices[i];
  }
  return result;
}

function computeAtr(klines: Kline[], period = 14): number[] {
  const atr: number[] = new Array(klines.length).fill(0);
  const tr: number[] = new Array(klines.length).fill(0);
  for (let i = 0; i < klines.length; i++) {
    if (i === 0) {
      tr[i] = klines[i].high - klines[i].low;
      atr[i] = tr[i];
      continue;
    }
    const hl = klines[i].high - klines[i].low;
    const hc = Math.abs(klines[i].high - klines[i - 1].close);
    const lc = Math.abs(klines[i].low - klines[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
    if (i < period) {
      atr[i] = tr.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return atr;
}

function computeBoxPoc(klines: Kline[], endIdx: number, lookback = 24): number {
  const start = Math.max(0, endIdx - lookback + 1);
  const slice = klines.slice(start, endIdx + 1);
  let minP = Infinity, maxP = -Infinity;
  for (const b of slice) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
  }
  const buckets = 10;
  const step = (maxP - minP) / buckets;
  const volAtPrice = new Array(buckets).fill(0);
  for (const b of slice) {
    const bucket = Math.min(buckets - 1, Math.max(0, Math.floor((b.close - minP) / step)));
    volAtPrice[bucket] += b.volume;
  }
  let maxV = -1, maxB = 0;
  for (let i = 0; i < buckets; i++) {
    if (volAtPrice[i] > maxV) { maxV = volAtPrice[i]; maxB = i; }
  }
  return minP + (maxB + 0.5) * step;
}

function analyzeDataset(klines: Kline[], symbol: string): AnalyzedBar[] {
  const closes = klines.map(k => k.close);
  const atr = computeAtr(klines);
  const cfg = ROBUST_ISLAND_PAIRS[symbol] || { fast: 14, slow: 50 };
  const smaFast = computeSma(closes, cfg.fast);
  const smaSlow = computeSma(closes, cfg.slow);

  const bars: AnalyzedBar[] = [];
  let lastCrossBar = -100;

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const range = k.high - k.low;
    const upperWick = k.high - Math.max(k.open, k.close);
    const lowerWick = Math.min(k.open, k.close) - k.low;
    const upperWickPct = range > 0 ? (upperWick / range) * 100 : 0;
    const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 0;

    const poc = computeBoxPoc(klines, i, 24);

    const fNow = smaFast[i];
    const sNow = smaSlow[i];
    const fPrev = i > 0 ? smaFast[i - 1] : fNow;
    const sPrev = i > 0 ? smaSlow[i - 1] : sNow;

    if ((fPrev <= sPrev && fNow > sNow) || (fPrev >= sPrev && fNow < sNow)) {
      lastCrossBar = i;
    }
    const isFreshSmaCross = (i - lastCrossBar) <= 3;
    const smaBias = fNow >= sNow ? 'BULLISH' : 'BEARISH';
    const smaFastSlope = i >= 3 ? ((fNow - smaFast[i - 3]) / smaFast[i - 3]) * 100 : 0;

    // Price vs Fast SMA crossover
    const pPrev = i > 0 ? klines[i - 1].close : k.close;
    const priceCrossedAboveFast = pPrev <= fPrev && k.close > fNow;
    const priceCrossedBelowFast = pPrev >= fPrev && k.close < fNow;

    // Fast SMA Retest mechanics:
    // Retest as Support: Low comes within 0.35% of Fast SMA or dips below it, but close recovers ABOVE Fast SMA
    const distLowToFast = Math.abs(k.low - fNow) / fNow;
    const priceRetestedFastAsSupport = (distLowToFast <= 0.0035 || (k.low <= fNow && k.close >= fNow)) && k.close >= fNow;

    // Retest as Resistance: High comes within 0.35% of Fast SMA or pierces above it, but close recovers BELOW Fast SMA
    const distHighToFast = Math.abs(k.high - fNow) / fNow;
    const priceRetestedFastAsResistance = (distHighToFast <= 0.0035 || (k.high >= fNow && k.close <= fNow)) && k.close <= fNow;

    // Layer 0 Kronos
    const roc5 = i >= 5 ? ((closes[i] - closes[i - 5]) / closes[i - 5]) * 100 : 0;
    const roc20 = i >= 20 ? ((closes[i] - closes[i - 20]) / closes[i - 20]) * 100 : 0;
    const expectedReturn = roc5 * 0.4 + roc20 * 0.6;
    const evRatio = Math.abs(expectedReturn) / Math.max(0.2, (atr[i] / k.close) * 100);
    const l0PassLong = expectedReturn >= 0.35 && evRatio >= 1.25 && !(roc5 <= -2.5 && lowerWickPct < 20);
    const l0PassShort = expectedReturn <= -0.35 && evRatio >= 1.40 && !(roc5 >= 2.5 && upperWickPct < 20);

    // Layer 1 POC
    const distPoc = Math.abs(k.close - poc) / poc;
    const l1PocPassLong = distPoc <= 0.007 && k.low <= poc && k.close >= poc;
    const l1PocPassShort = distPoc <= 0.007 && k.high >= poc && k.close <= poc;

    // Layer 2 Order Flow
    const flowRatio = range > 0 ? (k.close >= k.open ? (k.close - k.low) / range : (k.high - k.close) / range) : 0.5;
    const l2FlowPass = flowRatio >= 0.40;

    // Layer 4 TrapShield
    const l4TrapShieldPassLong = upperWickPct < 45;
    const l4TrapShieldPassShort = lowerWickPct < 45;

    bars.push({
      index: i,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      atr: atr[i],
      poc,
      smaFast: fNow,
      smaSlow: sNow,
      smaFastSlope,
      smaBias,
      isFreshSmaCross,
      priceCrossedAboveFast,
      priceCrossedBelowFast,
      priceRetestedFastAsSupport,
      priceRetestedFastAsResistance,
      l0PassLong,
      l0PassShort,
      l1PocPassLong,
      l1PocPassShort,
      l2FlowPass,
      l4TrapShieldPassLong,
      l4TrapShieldPassShort,
    });
  }
  return bars;
}

// ── Trade Simulation with Customizable Exit Protocol ─────────────────────────
interface SimTradeResult {
  netPnlUsd: number;
  exitReason: string;
  tp1Hit: boolean;
  tp2Hit: boolean;
  closedOnFastSmaCross: boolean;
  fastSmaCrossOccurred: boolean;
  eventualOutcomeIfCrossIgnored?: 'HIT_TP2' | 'HIT_BREAKEVEN' | 'HIT_SL' | 'STAGNATION';
  barsHeld: number;
}

function simulateTradeWithHarvestProtocol(
  bars: AnalyzedBar[],
  entryIdx: number,
  side: 'LONG' | 'SHORT',
  harvestMode: 'STANDARD' | 'EXIT_ON_PRICE_FAST_CROSS' | 'TIGHTEN_SL_TO_FAST_SMA'
): SimTradeResult {
  const entryBar = bars[entryIdx];
  const isLong = side === 'LONG';
  const entryPrice = entryBar.close;
  const atr = entryBar.atr;
  const slDist = Math.max(entryPrice * 0.006, atr * 1.25);
  const slDistPct = (slDist / entryPrice) * 100;
  const leverage = Math.min(10, Math.max(5, Math.floor(80 / slDistPct)));
  const capitalUsd = 40;
  const notionalUsd = capitalUsd * leverage;
  const makerFee = 0.0002;

  const tp1Mult = 1.65;
  const tp2Mult = 2.80;
  const beCushionPct = 0.0065;
  const maxHorizon = 16;

  let softSl = isLong ? entryPrice - slDist : entryPrice + slDist;
  const tp1Price = isLong ? entryPrice + slDist * tp1Mult : entryPrice - slDist * tp1Mult;
  const tp2Price = isLong ? entryPrice + slDist * tp2Mult : entryPrice - slDist * tp2Mult;

  let closed = false;
  let tp1Hit = false;
  let tp2Hit = false;
  let partialBankedUsd = 0;
  let activeRatio = 1.0;
  let exitReason = 'STAGNATION';
  let netPnlUsd = 0;
  let fastSmaCrossOccurred = false;
  let closedOnFastSmaCross = false;
  let eventualOutcomeIfCrossIgnored: SimTradeResult['eventualOutcomeIfCrossIgnored'];
  let barsHeld = 0;

  for (let b = entryIdx + 1; b <= Math.min(bars.length - 1, entryIdx + maxHorizon); b++) {
    if (closed) break;
    barsHeld++;
    const cur = bars[b];

    // Check if price crossed back against Fast SMA
    const priceViolatesFast = isLong ? cur.close < cur.smaFast : cur.close > cur.smaFast;
    if (priceViolatesFast && !fastSmaCrossOccurred) {
      fastSmaCrossOccurred = true;

      if (harvestMode === 'EXIT_ON_PRICE_FAST_CROSS') {
        closed = true;
        closedOnFastSmaCross = true;
        exitReason = 'FAST_SMA_CROSS_CUT';
        const dist = isLong ? cur.close - entryPrice : entryPrice - cur.close;
        const roi = (dist / entryPrice) * 100 * leverage;
        const pnl = (roi / 100) * capitalUsd * activeRatio - (notionalUsd * activeRatio * makerFee * 2);
        netPnlUsd = Number((partialBankedUsd + pnl).toFixed(2));
        break;
      } else if (harvestMode === 'TIGHTEN_SL_TO_FAST_SMA') {
        // Tighten SL to Fast SMA or Breakeven
        if (isLong) {
          softSl = Math.max(softSl, Math.min(cur.close, cur.smaFast));
        } else {
          softSl = Math.min(softSl, Math.max(cur.close, cur.smaFast));
        }
      }
    }

    // Normal SL check
    const isSlHit = isLong ? cur.low <= softSl : cur.high >= softSl;
    if (isSlHit) {
      closed = true;
      exitReason = tp1Hit ? 'BREAKEVEN_CUSHION' : 'FULL_SL';
      const dist = isLong ? softSl - entryPrice : entryPrice - softSl;
      const roi = (dist / entryPrice) * 100 * leverage;
      const pnl = (roi / 100) * capitalUsd * activeRatio - (notionalUsd * activeRatio * makerFee * 2);
      netPnlUsd = Number((partialBankedUsd + pnl).toFixed(2));
      break;
    }

    // TP1 check
    if (!tp1Hit) {
      const isTp1 = isLong ? cur.high >= tp1Price : cur.low <= tp1Price;
      if (isTp1) {
        tp1Hit = true;
        const dist = Math.abs(tp1Price - entryPrice);
        const roi = (dist / entryPrice) * 100 * leverage;
        const winPnl = (roi / 100) * capitalUsd * 0.5 - (notionalUsd * 0.5 * makerFee * 2);
        partialBankedUsd = winPnl;
        activeRatio = 0.5;
        // Advance SL to Breakeven + Cushion
        softSl = isLong ? entryPrice * (1 + beCushionPct) : entryPrice * (1 - beCushionPct);
      }
    }

    // TP2 check
    if (tp1Hit) {
      const isTp2 = isLong ? cur.high >= tp2Price : cur.low <= tp2Price;
      if (isTp2) {
        closed = true;
        tp2Hit = true;
        exitReason = 'TP2_RUNNER';
        const dist = Math.abs(tp2Price - entryPrice);
        const roi = (dist / entryPrice) * 100 * leverage;
        const winPnl = (roi / 100) * capitalUsd * 0.5 - (notionalUsd * 0.5 * makerFee * 2);
        netPnlUsd = Number((partialBankedUsd + winPnl).toFixed(2));
        break;
      }
    }
  }

  if (!closed) {
    closed = true;
    exitReason = 'STAGNATION_HARVEST';
    const lastBar = bars[Math.min(bars.length - 1, entryIdx + maxHorizon)];
    const dist = isLong ? lastBar.close - entryPrice : entryPrice - lastBar.close;
    const roi = (dist / entryPrice) * 100 * leverage;
    const pnl = (roi / 100) * capitalUsd * activeRatio - (notionalUsd * activeRatio * makerFee * 2);
    netPnlUsd = Number((partialBankedUsd + pnl).toFixed(2));
  }

  // If cross occurred, simulate what WOULD have happened if ignored
  if (fastSmaCrossOccurred && harvestMode === 'EXIT_ON_PRICE_FAST_CROSS') {
    const shadow = simulateTradeWithHarvestProtocol(bars, entryIdx, side, 'STANDARD');
    if (shadow.tp2Hit) eventualOutcomeIfCrossIgnored = 'HIT_TP2';
    else if (shadow.exitReason === 'BREAKEVEN_CUSHION') eventualOutcomeIfCrossIgnored = 'HIT_BREAKEVEN';
    else if (shadow.exitReason === 'FULL_SL') eventualOutcomeIfCrossIgnored = 'HIT_SL';
    else eventualOutcomeIfCrossIgnored = 'STAGNATION';
  }

  return {
    netPnlUsd,
    exitReason,
    tp1Hit,
    tp2Hit,
    closedOnFastSmaCross,
    fastSmaCrossOccurred,
    eventualOutcomeIfCrossIgnored,
    barsHeld,
  };
}

// ── Run Main Investigation ───────────────────────────────────────────────────
async function runInvestigation() {
  console.log('================================================================================');
  console.log(' 🔬 MATHEMATICAL EVALUATION: PRICE CROSSOVER & RETEST OF FAST ROBUST SMA');
  console.log('================================================================================');

  const dataDir = path.resolve(__dirname, '../../data/historical-replay');
  const files: Record<string, string> = {
    'BTC/USD': path.join(dataDir, 'btc_1month_15m.json'),
    'ETH/USD': path.join(dataDir, 'eth_1month_15m.json'),
    'SOL/USD': path.join(dataDir, 'sol_1month_15m.json'),
    'SUI/USD': path.join(dataDir, 'sui_1month_15m.json'),
  };

  const pairBars: Record<string, AnalyzedBar[]> = {};
  for (const [sym, file] of Object.entries(files)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const klines: Kline[] = raw.map((d: any) => ({
      openTime: d.openTime || d.timestamp || d.t,
      open: Number(d.open || d.o),
      high: Number(d.high || d.h),
      low: Number(d.low || d.l),
      close: Number(d.close || d.c),
      volume: Number(d.volume || d.v),
      closeTime: d.closeTime || 0,
    }));
    pairBars[sym] = analyzeDataset(klines, sym);
  }

  // ===========================================================================
  // PART 1: PRE-TRADE ENTRY MODELS COMPARISON
  // ===========================================================================
  console.log('\n================================================================================');
  console.log(' 📈 PART 1: PRE-TRADE ENTRY MODELS (EVALUATION ON 11,520 CANDLES)');
  console.log('================================================================================');

  interface EntryModel {
    id: string;
    name: string;
    trades: SimTradeResult[];
  }

  const models: EntryModel[] = [
    { id: 'M1_POC_BASELINE', name: 'Model 1: Baseline Champion (POC Retest + Robust SMA Bias)', trades: [] },
    { id: 'M2_PRICE_CROSS_FAST', name: 'Model 2: Price Crosses Over Fast SMA (Breakout Trigger)', trades: [] },
    { id: 'M3_FAST_SMA_RETEST', name: 'Model 3: Pullback Retest of Fast SMA as Support/Resistance', trades: [] },
    { id: 'M4_DUAL_POC_FAST', name: 'Model 4: Dual Confluence (Both POC Retest AND Fast SMA Retest)', trades: [] },
  ];

  for (const model of models) {
    for (const [sym, bars] of Object.entries(pairBars)) {
      let lastBar = -50;
      for (let i = 80; i < bars.length - 20; i++) {
        if (i - lastBar < 8) continue;
        const cur = bars[i];

        for (const side of ['LONG', 'SHORT'] as const) {
          const isLong = side === 'LONG';
          const isAligned = (isLong && cur.smaBias === 'BULLISH') || (!isLong && cur.smaBias === 'BEARISH');
          if (!isAligned && !cur.isFreshSmaCross) continue;

          // Layer checks (L0, L2, L4)
          const l0 = isLong ? cur.l0PassLong : cur.l0PassShort;
          const l2 = cur.l2FlowPass;
          const l4 = isLong ? cur.l4TrapShieldPassLong : cur.l4TrapShieldPassShort;
          if (!l0 || !l2 || !l4) continue;

          // Model-Specific Trigger
          let triggers = false;
          if (model.id === 'M1_POC_BASELINE') {
            triggers = isLong ? cur.l1PocPassLong : cur.l1PocPassShort;
          } else if (model.id === 'M2_PRICE_CROSS_FAST') {
            triggers = isLong ? cur.priceCrossedAboveFast : cur.priceCrossedBelowFast;
          } else if (model.id === 'M3_FAST_SMA_RETEST') {
            triggers = isLong ? cur.priceRetestedFastAsSupport : cur.priceRetestedFastAsResistance;
          } else if (model.id === 'M4_DUAL_POC_FAST') {
            const pocOk = isLong ? cur.l1PocPassLong : cur.l1PocPassShort;
            const fastOk = isLong ? cur.priceRetestedFastAsSupport : cur.priceRetestedFastAsResistance;
            triggers = pocOk && fastOk;
          }

          if (triggers) {
            const res = simulateTradeWithHarvestProtocol(bars, i, side, 'STANDARD');
            model.trades.push(res);
            lastBar = i;
            break;
          }
        }
      }
    }
  }

  console.log(
    'Entry Model'.padEnd(36) + ' | ' +
    'Trades'.padEnd(8) + ' | ' +
    'Win Rate'.padEnd(10) + ' | ' +
    'Net PnL'.padEnd(12) + ' | ' +
    'Profit Factor'.padEnd(14) + ' | ' +
    'TP1 Rate'.padEnd(10) + ' | ' +
    'TP2 Runner'
  );
  console.log('-'.repeat(105));

  for (const m of models) {
    const total = m.trades.length;
    const wins = m.trades.filter(t => t.netPnlUsd > 0).length;
    const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
    const netPnl = m.trades.reduce((sum, t) => sum + t.netPnlUsd, 0).toFixed(2);
    const grossW = m.trades.filter(t => t.netPnlUsd > 0).reduce((sum, t) => sum + t.netPnlUsd, 0);
    const grossL = Math.abs(m.trades.filter(t => t.netPnlUsd < 0).reduce((sum, t) => sum + t.netPnlUsd, 0));
    const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '99.0';
    const tp1 = total > 0 ? ((m.trades.filter(t => t.tp1Hit).length / total) * 100).toFixed(1) : '0.0';
    const tp2 = total > 0 ? ((m.trades.filter(t => t.tp2Hit).length / total) * 100).toFixed(1) : '0.0';

    console.log(
      m.name.slice(0, 36).padEnd(36) + ' | ' +
      `${total}`.padEnd(8) + ' | ' +
      `${wr}%`.padEnd(10) + ' | ' +
      `+$${netPnl}`.padEnd(12) + ' | ' +
      `${pf}x`.padEnd(14) + ' | ' +
      `${tp1}%`.padEnd(10) + ' | ' +
      `${tp2}%`
    );
  }

  // ===========================================================================
  // PART 2: DURING-TRADE HARVEST MASTER IMPACT (PRICE CROSSING FAST SMA)
  // ===========================================================================
  console.log('\n================================================================================');
  console.log(' 🌾 PART 2: DURING-TRADE HARVEST MASTER IMPACT (PRICE CROSSING FAST SMA)');
  console.log('================================================================================');

  const harvestProtocols = [
    { id: 'H1_STANDARD', name: 'Protocol A: Standard Champion (TP1 1.6R, BE Cushion, TP2 Runner)', mode: 'STANDARD' as const, trades: [] as SimTradeResult[] },
    { id: 'H2_EARLY_CUT', name: 'Protocol B: Immediate Exit when Price Closes across Fast SMA', mode: 'EXIT_ON_PRICE_FAST_CROSS' as const, trades: [] as SimTradeResult[] },
    { id: 'H3_TIGHTEN_SL', name: 'Protocol C: Dynamic Stop Tightening (Trail SL to Fast SMA)', mode: 'TIGHTEN_SL_TO_FAST_SMA' as const, trades: [] as SimTradeResult[] },
  ];

  for (const hp of harvestProtocols) {
    for (const [sym, bars] of Object.entries(pairBars)) {
      let lastBar = -50;
      for (let i = 80; i < bars.length - 20; i++) {
        if (i - lastBar < 8) continue;
        const cur = bars[i];
        for (const side of ['LONG', 'SHORT'] as const) {
          const isLong = side === 'LONG';
          const isAligned = (isLong && cur.smaBias === 'BULLISH') || (!isLong && cur.smaBias === 'BEARISH');
          if (!isAligned && !cur.isFreshSmaCross) continue;
          const l0 = isLong ? cur.l0PassLong : cur.l0PassShort;
          const l1 = isLong ? cur.l1PocPassLong : cur.l1PocPassShort;
          const l2 = cur.l2FlowPass;
          const l4 = isLong ? cur.l4TrapShieldPassLong : cur.l4TrapShieldPassShort;
          if (!l0 || !l1 || !l2 || !l4) continue;

          const res = simulateTradeWithHarvestProtocol(bars, i, side, hp.mode);
          hp.trades.push(res);
          lastBar = i;
          break;
        }
      }
    }
  }

  console.log(
    'Harvest Protocol'.padEnd(38) + ' | ' +
    'Win Rate'.padEnd(10) + ' | ' +
    'Total PnL'.padEnd(12) + ' | ' +
    'Profit Factor'.padEnd(14) + ' | ' +
    'TP2 Runner %'.padEnd(14) + ' | ' +
    'Avg Hold (bars)'
  );
  console.log('-'.repeat(105));

  for (const hp of harvestProtocols) {
    const total = hp.trades.length;
    const wins = hp.trades.filter(t => t.netPnlUsd > 0).length;
    const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
    const netPnl = hp.trades.reduce((sum, t) => sum + t.netPnlUsd, 0).toFixed(2);
    const grossW = hp.trades.filter(t => t.netPnlUsd > 0).reduce((sum, t) => sum + t.netPnlUsd, 0);
    const grossL = Math.abs(hp.trades.filter(t => t.netPnlUsd < 0).reduce((sum, t) => sum + t.netPnlUsd, 0));
    const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '99.0';
    const tp2 = total > 0 ? ((hp.trades.filter(t => t.tp2Hit).length / total) * 100).toFixed(1) : '0.0';
    const avgHold = total > 0 ? (hp.trades.reduce((sum, t) => sum + t.barsHeld, 0) / total).toFixed(1) : '0.0';

    console.log(
      hp.name.slice(0, 38).padEnd(38) + ' | ' +
      `${wr}%`.padEnd(10) + ' | ' +
      `+$${netPnl}`.padEnd(12) + ' | ' +
      `${pf}x`.padEnd(14) + ' | ' +
      `${tp2}%`.padEnd(14) + ' | ' +
      `${avgHold} bars`
    );
  }

  // ===========================================================================
  // PART 3: CONDITIONAL PROBABILITY OF FAST SMA CROSSOVER DURING TRADE
  // ===========================================================================
  console.log('\n================================================================================');
  console.log(' 🎲 PART 3: CONDITIONAL PROBABILITY: WHAT HAPPENS WHEN PRICE TOUCHES FAST SMA?');
  console.log('================================================================================');

  const standardTrades = harvestProtocols[0].trades;
  const tradesWithCross = standardTrades.filter(t => t.fastSmaCrossOccurred);
  const tradesWithoutCross = standardTrades.filter(t => !t.fastSmaCrossOccurred);

  console.log(`• Total Baseline Trades: ${standardTrades.length}`);
  console.log(`• Trades where Price Crossed Back across Fast SMA during trade: ${tradesWithCross.length} (${((tradesWithCross.length / standardTrades.length) * 100).toFixed(1)}%)`);
  console.log(`• Trades where Price Never Violated Fast SMA: ${tradesWithoutCross.length} (${((tradesWithoutCross.length / standardTrades.length) * 100).toFixed(1)}%)`);

  // Outcomes of trades when price crosses Fast SMA
  const crossHitTp2 = tradesWithCross.filter(t => t.tp2Hit).length;
  const crossHitBe = tradesWithCross.filter(t => t.exitReason === 'BREAKEVEN_CUSHION').length;
  const crossHitSl = tradesWithCross.filter(t => t.exitReason === 'FULL_SL').length;
  const crossStag = tradesWithCross.filter(t => t.exitReason === 'STAGNATION_HARVEST').length;

  console.log('\nConditional Probability Distribution [Event: Price Crosses Fast SMA]:');
  console.log(`  P(Full Stop Loss Hit       | Price Crosses Fast SMA) = ${((crossHitSl / tradesWithCross.length) * 100).toFixed(1)}%`);
  console.log(`  P(Breakeven Cushion Banked  | Price Crosses Fast SMA) = ${((crossHitBe / tradesWithCross.length) * 100).toFixed(1)}%`);
  console.log(`  P(Still Reaches TP2 Runner  | Price Crosses Fast SMA) = ${((crossHitTp2 / tradesWithCross.length) * 100).toFixed(1)}%`);
  console.log(`  P(Stagnation Time Stop Exit | Price Crosses Fast SMA) = ${((crossStag / tradesWithCross.length) * 100).toFixed(1)}%`);

  // Outcome of trades when price NEVER violates Fast SMA
  const noCrossTp2 = tradesWithoutCross.filter(t => t.tp2Hit).length;
  const noCrossWr = tradesWithoutCross.filter(t => t.netPnlUsd > 0).length;
  console.log('\nConditional Probability Distribution [Event: Price Stays on Correct Side of Fast SMA]:');
  console.log(`  Win Rate when Fast SMA held: ${((noCrossWr / tradesWithoutCross.length) * 100).toFixed(1)}%`);
  console.log(`  P(Full TP2 Runner Hit | Fast SMA held) = ${((noCrossTp2 / tradesWithoutCross.length) * 100).toFixed(1)}%`);

  // ===========================================================================
  // PART 4: ULTIMATE SYNERGY (MODEL 3 RETEST ENTRY + PROTOCOL C HARVEST)
  // ===========================================================================
  console.log('\n================================================================================');
  console.log(' 🏆 PART 4: SYNERGISTIC COMBINATION (MODEL 3 RETEST ENTRY + PROTOCOL C HARVEST)');
  console.log('================================================================================');
  const synergyTrades: SimTradeResult[] = [];
  for (const [sym, bars] of Object.entries(pairBars)) {
    let lastBar = -50;
    for (let i = 80; i < bars.length - 20; i++) {
      if (i - lastBar < 8) continue;
      const cur = bars[i];
      for (const side of ['LONG', 'SHORT'] as const) {
        const isLong = side === 'LONG';
        const isAligned = (isLong && cur.smaBias === 'BULLISH') || (!isLong && cur.smaBias === 'BEARISH');
        if (!isAligned && !cur.isFreshSmaCross) continue;
        const l0 = isLong ? cur.l0PassLong : cur.l0PassShort;
        const l2 = cur.l2FlowPass;
        const l4 = isLong ? cur.l4TrapShieldPassLong : cur.l4TrapShieldPassShort;
        if (!l0 || !l2 || !l4) continue;

        const triggers = isLong ? cur.priceRetestedFastAsSupport : cur.priceRetestedFastAsResistance;
        if (triggers) {
          const res = simulateTradeWithHarvestProtocol(bars, i, side, 'TIGHTEN_SL_TO_FAST_SMA');
          synergyTrades.push(res);
          lastBar = i;
          break;
        }
      }
    }
  }

  const sTotal = synergyTrades.length;
  const sWins = synergyTrades.filter(t => t.netPnlUsd > 0).length;
  const sWr = ((sWins / sTotal) * 100).toFixed(1);
  const sNetPnl = synergyTrades.reduce((sum, t) => sum + t.netPnlUsd, 0).toFixed(2);
  const sGrossW = synergyTrades.filter(t => t.netPnlUsd > 0).reduce((sum, t) => sum + t.netPnlUsd, 0);
  const sGrossL = Math.abs(synergyTrades.filter(t => t.netPnlUsd < 0).reduce((sum, t) => sum + t.netPnlUsd, 0));
  const sPf = (sGrossW / sGrossL).toFixed(2);
  const sTp1 = ((synergyTrades.filter(t => t.tp1Hit).length / sTotal) * 100).toFixed(1);
  const sTp2 = ((synergyTrades.filter(t => t.tp2Hit).length / sTotal) * 100).toFixed(1);

  console.log(`• Total Synergy Trades:  ${sTotal}`);
  console.log(`• Win Rate:              ${sWr}%`);
  console.log(`• Net PnL:               +$${sNetPnl}`);
  console.log(`• Profit Factor:         ${sPf}x`);
  console.log(`• TP1 Hit Rate:          ${sTp1}%`);
  console.log(`• TP2 Runner Hit Rate:   ${sTp2}%`);
}

runInvestigation().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
