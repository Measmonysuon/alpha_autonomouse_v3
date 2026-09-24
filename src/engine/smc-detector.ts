/**
 * Smart Money Concepts (SMC) Microstructure Detector
 * 
 * Ported & enhanced from Client v1 blueprint:
 * 1. Fair Value Gaps (FVG) / Imbalances (3-bar unmitigated price voids)
 * 2. Liquidity Sweeps (Stop Hunts: Buy-Side BSL & Sell-Side SSL)
 * 3. Market Structure Shifts (Break of Structure BOS vs Change of Character CHoCH)
 * 4. Order Blocks (OB) (Institutional accumulation / distribution zones)
 * 5. Premium vs Discount 50% Equilibrium Dealing Ranges
 * 6. Equal Highs (EQH) & Equal Lows (EQL) Liquidity Stop Pools
 * 7. Turtle Soup Grabs & Body-Run Breakout Invalidation Filter
 */

import { KlineBar } from './standalone-engine';

export interface FairValueGap {
  type: 'BULLISH_FVG' | 'BEARISH_FVG';
  top: number;
  bottom: number;
  sizePct: number;
  candleIndex: number;
  mitigated: boolean;
}

export interface LiquiditySweep {
  type: 'BULLISH_SWEEP_SSL' | 'BEARISH_SWEEP_BSL' | 'NONE';
  sweptLevel: number;
  wickExtreme: number;
  rejectionPct: number;
  isConfirmed: boolean;
  summary: string;
}

export interface OrderBlock {
  type: 'BULLISH_OB' | 'BEARISH_OB';
  top: number;
  bottom: number;
  candleIndex: number;
  mitigated: boolean;
}

export interface PremiumDiscountAnalysis {
  swingHigh: number;
  swingLow: number;
  equilibrium: number;
  zone: 'DISCOUNT' | 'PREMIUM' | 'EQUILIBRIUM';
  distFromEqPct: number;
  summary: string;
}

export interface EqualHighsLows {
  hasEQH: boolean;
  eqhPrice?: number;
  hasEQL: boolean;
  eqlPrice?: number;
  summary: string;
}

export interface TurtleSoupAnalysis {
  isTurtleSoup: boolean;
  type: 'BULLISH_TURTLE_SOUP' | 'BEARISH_TURTLE_SOUP' | 'NONE';
  isBodyRunInvalidation: boolean;
  sweptLevel: number;
  rejectionWickPct: number;
  summary: string;
}

export interface SMCAnalysis {
  fvg: {
    activeFVGs: FairValueGap[];
    nearestFVG: FairValueGap | null;
    isPriceInsideFVG: boolean;
    fvgBias: 'BULLISH_FVG_SUPPORT' | 'BEARISH_FVG_RESISTANCE' | 'NEUTRAL';
  };
  liquiditySweep: LiquiditySweep;
  structureShift: {
    type: 'BULLISH_BOS' | 'BEARISH_BOS' | 'BULLISH_CHOCH' | 'BEARISH_CHOCH' | 'NONE';
    swingHigh: number;
    swingLow: number;
    structuralTrend: 'BULLISH' | 'BEARISH' | 'RANGING';
  };
  orderBlock: {
    nearestBullishOB: OrderBlock | null;
    nearestBearishOB: OrderBlock | null;
    isTestingOB: boolean;
    testingType: 'BULLISH_OB' | 'BEARISH_OB' | 'NONE';
  };
  premiumDiscount: PremiumDiscountAnalysis;
  equalHighsLows: EqualHighsLows;
  turtleSoup: TurtleSoupAnalysis;
  confluencePts: number; // Confluence impact (+20 to -25 pts)
  summary: string;
}

/**
 * Detect Fair Value Gaps across recent candles
 */
export function detectFairValueGaps(klines: KlineBar[], currentPrice: number): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  if (klines.length < 3) return fvgs;

  const startIdx = Math.max(2, klines.length - 25);
  for (let i = startIdx; i < klines.length; i++) {
    const c0 = klines[i - 2];
    const c1 = klines[i - 1];
    const c2 = klines[i];

    // Bullish FVG: c0.high < c2.low and strong green impulse on c1
    if (c2.low > c0.high && c1.close > c1.open) {
      const top = c2.low;
      const bottom = c0.high;
      const sizePct = Number((((top - bottom) / bottom) * 100).toFixed(2));
      if (sizePct >= 0.08) {
        let mitigated = false;
        for (let j = i + 1; j < klines.length; j++) {
          if (klines[j].low <= bottom) {
            mitigated = true;
            break;
          }
        }
        fvgs.push({
          type: 'BULLISH_FVG',
          top,
          bottom,
          sizePct,
          candleIndex: i,
          mitigated,
        });
      }
    }

    // Bearish FVG: c0.low > c2.high and strong red impulse on c1
    if (c0.low > c2.high && c1.close < c1.open) {
      const top = c0.low;
      const bottom = c2.high;
      const sizePct = Number((((top - bottom) / bottom) * 100).toFixed(2));
      if (sizePct >= 0.08) {
        let mitigated = false;
        for (let j = i + 1; j < klines.length; j++) {
          if (klines[j].high >= top) {
            mitigated = true;
            break;
          }
        }
        fvgs.push({
          type: 'BEARISH_FVG',
          top,
          bottom,
          sizePct,
          candleIndex: i,
          mitigated,
        });
      }
    }
  }

  return fvgs;
}

/**
 * Detect Liquidity Sweeps (Stop Hunts on Buy-Side or Sell-Side Liquidity)
 */
export function detectLiquiditySweeps(klines: KlineBar[]): LiquiditySweep {
  if (klines.length < 15) {
    return {
      type: 'NONE',
      sweptLevel: 0,
      wickExtreme: 0,
      rejectionPct: 0,
      isConfirmed: false,
      summary: 'Insufficient data for sweep analysis',
    };
  }

  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const candleRange = Math.max(0.0001, last.high - last.low);
  const upperWickPct = ((last.high - Math.max(last.open, last.close)) / candleRange) * 100;
  const lowerWickPct = ((Math.min(last.open, last.close) - last.low) / candleRange) * 100;

  // Key swing high & low over previous 15 candles (excluding the last 2 candles)
  const lookback = klines.slice(Math.max(0, klines.length - 18), klines.length - 2);
  const swingHigh = Math.max(...lookback.map((k) => k.high));
  const swingLow = Math.min(...lookback.map((k) => k.low));

  // 1. Bullish Liquidity Sweep (Sell-Side Liquidity / SSL swept)
  if (last.low < swingLow && last.close >= swingLow * 0.9995 && lowerWickPct >= 35) {
    return {
      type: 'BULLISH_SWEEP_SSL',
      sweptLevel: swingLow,
      wickExtreme: last.low,
      rejectionPct: Number(lowerWickPct.toFixed(1)),
      isConfirmed: true,
      summary: `Sell-Side Liquidity (SSL) swept below $${swingLow.toFixed(4)} with ${lowerWickPct.toFixed(0)}% lower wick rejection. Institutional accumulation signature.`,
    };
  }

  // 2. Bearish Liquidity Sweep (Buy-Side Liquidity / BSL swept)
  if (last.high > swingHigh && last.close <= swingHigh * 1.0005 && upperWickPct >= 35) {
    return {
      type: 'BEARISH_SWEEP_BSL',
      sweptLevel: swingHigh,
      wickExtreme: last.high,
      rejectionPct: Number(upperWickPct.toFixed(1)),
      isConfirmed: true,
      summary: `Buy-Side Liquidity (BSL) swept above $${swingHigh.toFixed(4)} with ${upperWickPct.toFixed(0)}% upper wick rejection. Trap top signature.`,
    };
  }

  // Check prev candle formed sweep and current confirms
  const prevRange = Math.max(0.0001, prev.high - prev.low);
  const prevLowerWickPct = ((Math.min(prev.open, prev.close) - prev.low) / prevRange) * 100;
  const prevUpperWickPct = ((prev.high - Math.max(prev.open, prev.close)) / prevRange) * 100;

  if (prev.low < swingLow && prev.close >= swingLow * 0.9995 && prevLowerWickPct >= 35 && last.close > prev.close) {
    return {
      type: 'BULLISH_SWEEP_SSL',
      sweptLevel: swingLow,
      wickExtreme: prev.low,
      rejectionPct: Number(prevLowerWickPct.toFixed(1)),
      isConfirmed: true,
      summary: `Confirmed SSL Sweep: Low $${prev.low.toFixed(4)} swept key support with bullish continuation.`,
    };
  }

  if (prev.high > swingHigh && prev.close <= swingHigh * 1.0005 && prevUpperWickPct >= 35 && last.close < prev.close) {
    return {
      type: 'BEARISH_SWEEP_BSL',
      sweptLevel: swingHigh,
      wickExtreme: prev.high,
      rejectionPct: Number(prevUpperWickPct.toFixed(1)),
      isConfirmed: true,
      summary: `Confirmed BSL Sweep: High $${prev.high.toFixed(4)} swept key resistance with bearish continuation.`,
    };
  }

  return {
    type: 'NONE',
    sweptLevel: 0,
    wickExtreme: 0,
    rejectionPct: 0,
    isConfirmed: false,
    summary: 'No active liquidity sweeps detected in current window.',
  };
}

/**
 * Detect Order Blocks (OB)
 */
export function detectOrderBlocks(klines: KlineBar[], currentPrice: number): {
  nearestBullishOB: OrderBlock | null;
  nearestBearishOB: OrderBlock | null;
  isTestingOB: boolean;
  testingType: 'BULLISH_OB' | 'BEARISH_OB' | 'NONE';
} {
  let nearestBullishOB: OrderBlock | null = null;
  let nearestBearishOB: OrderBlock | null = null;

  if (klines.length < 8) {
    return { nearestBullishOB: null, nearestBearishOB: null, isTestingOB: false, testingType: 'NONE' };
  }

  const startIdx = Math.max(1, klines.length - 20);
  for (let i = startIdx; i < klines.length - 1; i++) {
    const c0 = klines[i];
    const c1 = klines[i + 1];

    // Bullish OB: c0 is down candle, c1 is strong up candle (gain >= 0.35%)
    if (c0.close < c0.open && c1.close > c1.open && (c1.close - c1.open) / c1.open >= 0.0035) {
      const top = Math.max(c0.open, c0.close);
      const bottom = c0.low;
      if (currentPrice >= bottom * 0.998) {
        nearestBullishOB = {
          type: 'BULLISH_OB',
          top,
          bottom,
          candleIndex: i,
          mitigated: currentPrice < bottom,
        };
      }
    }

    // Bearish OB: c0 is up candle, c1 is strong down candle (drop >= 0.35%)
    if (c0.close > c0.open && c1.close < c1.open && (c0.open - c1.close) / c0.open >= 0.0035) {
      const top = c0.high;
      const bottom = Math.min(c0.open, c0.close);
      if (currentPrice <= top * 1.002) {
        nearestBearishOB = {
          type: 'BEARISH_OB',
          top,
          bottom,
          candleIndex: i,
          mitigated: currentPrice > top,
        };
      }
    }
  }

  let isTestingOB = false;
  let testingType: 'BULLISH_OB' | 'BEARISH_OB' | 'NONE' = 'NONE';

  if (nearestBullishOB && !nearestBullishOB.mitigated) {
    if (currentPrice >= nearestBullishOB.bottom && currentPrice <= nearestBullishOB.top * 1.002) {
      isTestingOB = true;
      testingType = 'BULLISH_OB';
    }
  }

  if (nearestBearishOB && !nearestBearishOB.mitigated) {
    if (currentPrice <= nearestBearishOB.top && currentPrice >= nearestBearishOB.bottom * 0.998) {
      isTestingOB = true;
      testingType = 'BEARISH_OB';
    }
  }

  return { nearestBullishOB, nearestBearishOB, isTestingOB, testingType };
}

/**
 * Detect Market Structure Shifts (BOS vs. CHoCH)
 */
export function detectStructureShifts(klines: KlineBar[]): {
  type: 'BULLISH_BOS' | 'BEARISH_BOS' | 'BULLISH_CHOCH' | 'BEARISH_CHOCH' | 'NONE';
  swingHigh: number;
  swingLow: number;
  structuralTrend: 'BULLISH' | 'BEARISH' | 'RANGING';
} {
  if (klines.length < 15) {
    return { type: 'NONE', swingHigh: 0, swingLow: 0, structuralTrend: 'RANGING' };
  }

  const window = klines.slice(-15, -1);
  const swingHigh = Math.max(...window.map((k) => k.high));
  const swingLow  = Math.min(...window.map((k) => k.low));
  const last = klines[klines.length - 1];

  const closes = klines.map((k) => k.close);
  const ema20 = closes.slice(-20).reduce((s, c) => s + c, 0) / Math.min(20, closes.length);
  const structuralTrend = last.close > ema20 * 1.002 ? 'BULLISH' : last.close < ema20 * 0.998 ? 'BEARISH' : 'RANGING';

  let type: 'BULLISH_BOS' | 'BEARISH_BOS' | 'BULLISH_CHOCH' | 'BEARISH_CHOCH' | 'NONE' = 'NONE';

  if (last.close > swingHigh) {
    type = structuralTrend === 'BEARISH' ? 'BULLISH_CHOCH' : 'BULLISH_BOS';
  } else if (last.close < swingLow) {
    type = structuralTrend === 'BULLISH' ? 'BEARISH_CHOCH' : 'BEARISH_BOS';
  }

  return { type, swingHigh, swingLow, structuralTrend };
}

/**
 * Detect Premium vs. Discount 50% Equilibrium Dealing Range
 */
export function detectPremiumDiscount(klines: KlineBar[], currentPrice: number): PremiumDiscountAnalysis {
  if (!klines || klines.length < 5) {
    return {
      swingHigh: currentPrice,
      swingLow: currentPrice,
      equilibrium: currentPrice,
      zone: 'EQUILIBRIUM',
      distFromEqPct: 0,
      summary: 'Equilibrium neutral (insufficient candle depth)',
    };
  }

  const lookback = Math.min(25, klines.length);
  const recent = klines.slice(-lookback);
  const swingHigh = Math.max(...recent.map((k) => k.high));
  const swingLow = Math.min(...recent.map((k) => k.low));
  const range = swingHigh - swingLow;
  const equilibrium = swingLow + range * 0.5;

  const distFromEqPct = range > 0 ? ((currentPrice - equilibrium) / equilibrium) * 100 : 0;
  let zone: 'DISCOUNT' | 'PREMIUM' | 'EQUILIBRIUM' = 'EQUILIBRIUM';

  if (currentPrice > equilibrium * 1.001) {
    zone = 'PREMIUM';
  } else if (currentPrice < equilibrium * 0.999) {
    zone = 'DISCOUNT';
  }

  const summary = `${zone} ZONE: Price ($${currentPrice.toFixed(4)}) is ${distFromEqPct >= 0 ? '+' : ''}${distFromEqPct.toFixed(2)}% from 50% Equilibrium ($${equilibrium.toFixed(4)})`;

  return { swingHigh, swingLow, equilibrium, zone, distFromEqPct, summary };
}

/**
 * Detect Equal Highs (EQH) and Equal Lows (EQL) Liquidity Pools
 */
export function detectEqualHighsLows(klines: KlineBar[]): EqualHighsLows {
  if (!klines || klines.length < 8) {
    return { hasEQH: false, hasEQL: false, summary: 'EQH/EQL inactive' };
  }

  const lookback = Math.min(20, klines.length - 1);
  const sample = klines.slice(-lookback, -1);

  let hasEQH = false;
  let eqhPrice: number | undefined;
  let hasEQL = false;
  let eqlPrice: number | undefined;

  const highs = sample.map((k) => k.high);
  const maxHigh = Math.max(...highs);
  const closeToHigh = highs.filter((h) => Math.abs(h - maxHigh) / maxHigh <= 0.0015);
  if (closeToHigh.length >= 2) {
    hasEQH = true;
    eqhPrice = maxHigh;
  }

  const lows = sample.map((k) => k.low);
  const minLow = Math.min(...lows);
  const closeToLow = lows.filter((l) => Math.abs(l - minLow) / minLow <= 0.0015);
  if (closeToLow.length >= 2) {
    hasEQL = true;
    eqlPrice = minLow;
  }

  let summary = 'No distinct EQH/EQL stop pools detected';
  if (hasEQH && hasEQL) {
    summary = `Double Liquidity Pools: EQH Buy Stops at $${eqhPrice?.toFixed(4)} | EQL Sell Stops at $${eqlPrice?.toFixed(4)}`;
  } else if (hasEQH) {
    summary = `Buy-Side Stop Pool: EQH Equal Highs resting at $${eqhPrice?.toFixed(4)}`;
  } else if (hasEQL) {
    summary = `Sell-Side Stop Pool: EQL Equal Lows resting at $${eqlPrice?.toFixed(4)}`;
  }

  return { hasEQH, eqhPrice, hasEQL, eqlPrice, summary };
}

/**
 * Detect Turtle Soup Sweep vs Body Run Invalidation
 */
export function detectTurtleSoupSweep(
  klines: KlineBar[],
  sweep: LiquiditySweep,
  currentPrice: number,
): TurtleSoupAnalysis {
  if (!klines || klines.length < 3 || sweep.type === 'NONE') {
    return {
      isTurtleSoup: false,
      type: 'NONE',
      isBodyRunInvalidation: false,
      sweptLevel: 0,
      rejectionWickPct: 0,
      summary: 'No active liquidity grab pattern.',
    };
  }

  const lastCandle = klines[klines.length - 1];
  const candleRange = lastCandle.high - lastCandle.low;
  if (candleRange <= 0) {
    return {
      isTurtleSoup: false,
      type: 'NONE',
      isBodyRunInvalidation: false,
      sweptLevel: 0,
      rejectionWickPct: 0,
      summary: 'Neutral candle dynamics.',
    };
  }

  const bodySize = Math.abs(lastCandle.close - lastCandle.open);
  const bodyRatio = bodySize / candleRange;

  // Body Run Invalidation: Candle body firmly closes past the swept level with >60% solid body
  if (sweep.type === 'BEARISH_SWEEP_BSL' && lastCandle.close > sweep.sweptLevel && bodyRatio >= 0.60) {
    return {
      isTurtleSoup: false,
      type: 'NONE',
      isBodyRunInvalidation: true,
      sweptLevel: sweep.sweptLevel,
      rejectionWickPct: sweep.rejectionPct,
      summary: `🚨 BREAKOUT RUN INVALIDATION: Candle closed firmly past $${sweep.sweptLevel.toFixed(4)} with ${(bodyRatio * 100).toFixed(0)}% body. Counter-trading strictly banned.`,
    };
  }

  if (sweep.type === 'BULLISH_SWEEP_SSL' && lastCandle.close < sweep.sweptLevel && bodyRatio >= 0.60) {
    return {
      isTurtleSoup: false,
      type: 'NONE',
      isBodyRunInvalidation: true,
      sweptLevel: sweep.sweptLevel,
      rejectionWickPct: sweep.rejectionPct,
      summary: `🚨 BREAKOUT RUN INVALIDATION: Candle closed firmly past $${sweep.sweptLevel.toFixed(4)} with ${(bodyRatio * 100).toFixed(0)}% body. Counter-trading strictly banned.`,
    };
  }

  // Valid Turtle Soup Sweep: Wick >= 40% and closed back inside range
  if (sweep.type === 'BULLISH_SWEEP_SSL' && sweep.rejectionPct >= 40 && lastCandle.close >= sweep.sweptLevel * 0.999) {
    return {
      isTurtleSoup: true,
      type: 'BULLISH_TURTLE_SOUP',
      isBodyRunInvalidation: false,
      sweptLevel: sweep.sweptLevel,
      rejectionWickPct: sweep.rejectionPct,
      summary: `🐢 BULLISH TURTLE SOUP: Liquidity grabbed below $${sweep.sweptLevel.toFixed(4)} (${sweep.rejectionPct}% wick rejection) and reclaimed!`,
    };
  }

  if (sweep.type === 'BEARISH_SWEEP_BSL' && sweep.rejectionPct >= 40 && lastCandle.close <= sweep.sweptLevel * 1.001) {
    return {
      isTurtleSoup: true,
      type: 'BEARISH_TURTLE_SOUP',
      isBodyRunInvalidation: false,
      sweptLevel: sweep.sweptLevel,
      rejectionWickPct: sweep.rejectionPct,
      summary: `🐢 BEARISH TURTLE SOUP: Liquidity grabbed above $${sweep.sweptLevel.toFixed(4)} (${sweep.rejectionPct}% wick rejection) and rejected!`,
    };
  }

  return {
    isTurtleSoup: false,
    type: 'NONE',
    isBodyRunInvalidation: false,
    sweptLevel: sweep.sweptLevel,
    rejectionWickPct: sweep.rejectionPct,
    summary: 'Standard sweep without full Turtle Soup reclaim criteria.',
  };
}

/**
 * Main SMC Analysis Orchestrator
 */
export function analyzeSMC(klines15m: KlineBar[], currentPrice: number): SMCAnalysis {
  if (!klines15m || klines15m.length < 8) {
    return {
      fvg: {
        activeFVGs: [],
        nearestFVG: null,
        isPriceInsideFVG: false,
        fvgBias: 'NEUTRAL',
      },
      liquiditySweep: {
        type: 'NONE',
        sweptLevel: 0,
        wickExtreme: 0,
        rejectionPct: 0,
        isConfirmed: false,
        summary: 'Insufficient kline history for SMC evaluation.',
      },
      structureShift: {
        type: 'NONE',
        swingHigh: 0,
        swingLow: 0,
        structuralTrend: 'RANGING',
      },
      orderBlock: {
        nearestBullishOB: null,
        nearestBearishOB: null,
        isTestingOB: false,
        testingType: 'NONE',
      },
      premiumDiscount: {
        swingHigh: currentPrice,
        swingLow: currentPrice,
        equilibrium: currentPrice,
        zone: 'EQUILIBRIUM',
        distFromEqPct: 0,
        summary: 'Neutral',
      },
      equalHighsLows: {
        hasEQH: false,
        hasEQL: false,
        summary: 'None',
      },
      turtleSoup: {
        isTurtleSoup: false,
        type: 'NONE',
        isBodyRunInvalidation: false,
        sweptLevel: 0,
        rejectionWickPct: 0,
        summary: 'None',
      },
      confluencePts: 0,
      summary: 'SMC analysis pending kline stream initialization.',
    };
  }

  // 1. Fair Value Gaps
  const allFVGs = detectFairValueGaps(klines15m, currentPrice);
  const activeFVGs = allFVGs.filter((f) => !f.mitigated);
  let nearestFVG: FairValueGap | null = null;
  let isPriceInsideFVG = false;
  let fvgBias: 'BULLISH_FVG_SUPPORT' | 'BEARISH_FVG_RESISTANCE' | 'NEUTRAL' = 'NEUTRAL';

  if (activeFVGs.length > 0) {
    activeFVGs.sort((a, b) => {
      const distA = Math.min(Math.abs(currentPrice - a.top), Math.abs(currentPrice - a.bottom));
      const distB = Math.min(Math.abs(currentPrice - b.top), Math.abs(currentPrice - b.bottom));
      return distA - distB;
    });
    nearestFVG = activeFVGs[0];

    if (currentPrice >= nearestFVG.bottom && currentPrice <= nearestFVG.top) {
      isPriceInsideFVG = true;
      fvgBias = nearestFVG.type === 'BULLISH_FVG' ? 'BULLISH_FVG_SUPPORT' : 'BEARISH_FVG_RESISTANCE';
    }
  }

  // 2. Liquidity Sweeps
  const sweep = detectLiquiditySweeps(klines15m);

  // 3. Order Blocks
  const ob = detectOrderBlocks(klines15m, currentPrice);

  // 4. Structure Shifts
  const structure = detectStructureShifts(klines15m);

  // 5. Premium / Discount Equilibrium
  const premiumDiscount = detectPremiumDiscount(klines15m, currentPrice);

  // 6. Equal Highs / Lows Pools
  const equalHighsLows = detectEqualHighsLows(klines15m);

  // 7. Turtle Soup Sweep Analysis
  const turtleSoup = detectTurtleSoupSweep(klines15m, sweep, currentPrice);

  // 8. Compute Confluence Score Impact (+20 to -25 pts)
  let confluencePts = 0;
  const summaryParts: string[] = [];

  // Turtle Soup Confirmation (+18 pts)
  if (turtleSoup.isTurtleSoup) {
    confluencePts += 18;
    summaryParts.push(turtleSoup.summary);
  } else if (turtleSoup.isBodyRunInvalidation) {
    confluencePts -= 25;
    summaryParts.push(turtleSoup.summary);
  }

  // Premium / Discount Alignment
  if (premiumDiscount.zone === 'DISCOUNT') {
    confluencePts += 5;
    summaryParts.push(`🟩 Discount Zone (${premiumDiscount.distFromEqPct.toFixed(1)}% below Eq)`);
  } else if (premiumDiscount.zone === 'PREMIUM') {
    summaryParts.push(`🛑 Premium Zone (+${premiumDiscount.distFromEqPct.toFixed(1)}% above Eq)`);
  }

  // Equal Highs / Lows Stop Pools
  if (equalHighsLows.hasEQH || equalHighsLows.hasEQL) {
    summaryParts.push(`🎯 ${equalHighsLows.summary}`);
  }

  // Confluence for LONG:
  if (sweep.type === 'BULLISH_SWEEP_SSL') {
    confluencePts += 15;
    summaryParts.push(`⚡ Confirmed SSL Sweep (${sweep.rejectionPct}% wick)`);
  }
  if (fvgBias === 'BULLISH_FVG_SUPPORT') {
    confluencePts += 10;
    summaryParts.push(`🟩 Retesting 15m Bullish FVG [$${nearestFVG?.bottom.toFixed(4)} - $${nearestFVG?.top.toFixed(4)}]`);
  }
  if (ob.isTestingOB && ob.testingType === 'BULLISH_OB') {
    confluencePts += 10;
    summaryParts.push(`🧱 Testing Bullish Order Block [$${ob.nearestBullishOB?.bottom.toFixed(4)} - $${ob.nearestBullishOB?.top.toFixed(4)}]`);
  }
  if (structure.type === 'BULLISH_CHOCH') {
    confluencePts += 12;
    summaryParts.push(`🔄 Bullish Change of Character (CHoCH) structural reversal`);
  } else if (structure.type === 'BULLISH_BOS') {
    confluencePts += 8;
    summaryParts.push(`📈 Bullish Break of Structure (BOS) trend continuation`);
  }

  // Traps & Penalties against LONG:
  if (sweep.type === 'BEARISH_SWEEP_BSL') {
    confluencePts -= 18;
    summaryParts.push(`⚠️ Bearish BSL Sweep (Fakeout top / liquidity hunt above $${sweep.sweptLevel.toFixed(4)})`);
  }
  if (fvgBias === 'BEARISH_FVG_RESISTANCE') {
    confluencePts -= 12;
    summaryParts.push(`🛑 Trading into Bearish FVG Resistance zone`);
  }
  if (ob.isTestingOB && ob.testingType === 'BEARISH_OB') {
    confluencePts -= 12;
    summaryParts.push(`🧱 Testing Bearish Order Block supply`);
  }
  if (structure.type === 'BEARISH_CHOCH') {
    confluencePts -= 15;
    summaryParts.push(`⚠️ Bearish Change of Character (CHoCH) breakdown`);
  }

  const finalSummary = summaryParts.length > 0
    ? summaryParts.join(' | ')
    : 'Market structure balanced; no immediate unmitigated FVGs or liquidity sweeps active.';

  return {
    fvg: {
      activeFVGs,
      nearestFVG,
      isPriceInsideFVG,
      fvgBias,
    },
    liquiditySweep: sweep,
    structureShift: structure,
    orderBlock: ob,
    premiumDiscount,
    equalHighsLows,
    turtleSoup,
    confluencePts: Math.max(-25, Math.min(20, confluencePts)),
    summary: finalSummary,
  };
}
