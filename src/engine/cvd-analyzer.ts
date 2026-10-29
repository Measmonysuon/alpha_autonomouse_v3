/**
 * Cumulative Volume Delta (CVD) Absorption & Divergence Engine (Client V3)
 */

export interface CandleLike {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CoinGlassCVDInput {
  cvdSlope?: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  takerBuyRatio?: number;
}

export interface CVDAnalysisResult {
  cvdSlope: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  isAbsorptionDivergence: boolean;
  isExhaustionDivergence: boolean;
  takerBuyRatio: number;
  isApproved: boolean;
  vetoReason?: string;
  convictionAdjustment: number;
  summary: string;
}

export function evaluateCVDConfirmation(
  action: 'LONG' | 'SHORT',
  klines: CandleLike[] | undefined,
  cgCvd?: CoinGlassCVDInput
): CVDAnalysisResult {
  if (!klines || klines.length < 5) {
    const cgSlope = cgCvd?.cvdSlope || 'NEUTRAL';
    const takerRatio = cgCvd?.takerBuyRatio ?? 1.0;
    const isEarlyApproved = action === 'LONG' 
      ? (cgSlope !== 'DISTRIBUTION' && takerRatio >= 0.85) 
      : (cgSlope !== 'ACCUMULATION' && takerRatio <= 1.15);
    return {
      cvdSlope: cgSlope,
      isAbsorptionDivergence: false,
      isExhaustionDivergence: false,
      takerBuyRatio: takerRatio,
      isApproved: isEarlyApproved,
      vetoReason: isEarlyApproved ? undefined : `🛑 [CVD VETO] Aggressive ${cgSlope} flow (Taker Buy Ratio: ${takerRatio.toFixed(2)}) opposes ${action} entry.`,
      convictionAdjustment: 0,
      summary: `CVD: ${cgSlope} (Taker Ratio: ${takerRatio.toFixed(2)})`,
    };
  }

  const lookback = Math.min(20, klines.length);
  const slice = klines.slice(-lookback);
  const cvdSeries: number[] = [];
  let runningCvd = 0;

  for (const bar of slice) {
    const range = Math.max(0.00001, bar.high - bar.low);
    const bodyDirection = (bar.close - bar.open) / range;
    const barDelta = bar.volume * bodyDirection;
    runningCvd += barDelta;
    cvdSeries.push(runningCvd);
  }

  const recentCvd = cvdSeries.slice(-5);
  const cvdDelta = recentCvd[recentCvd.length - 1] - recentCvd[0];
  let calculatedSlope: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL' = 'NEUTRAL';
  if (cvdDelta > 0) calculatedSlope = 'ACCUMULATION';
  else if (cvdDelta < 0) calculatedSlope = 'DISTRIBUTION';

  const finalSlope = cgCvd?.cvdSlope || calculatedSlope;
  const takerRatio = cgCvd?.takerBuyRatio ?? (cvdDelta >= 0 ? 1.05 : 0.95);

  let isAbsorptionDivergence = false;
  let isExhaustionDivergence = false;

  if (slice.length >= 8) {
    const p1 = slice[slice.length - 1].close;
    const p0 = slice[slice.length - 4].close;
    const c1 = cvdSeries[cvdSeries.length - 1];
    const c0 = cvdSeries[cvdSeries.length - 4];

    if (p1 <= p0 && c1 > c0) {
      isAbsorptionDivergence = true;
    }
    if (p1 >= p0 && c1 < c0) {
      isExhaustionDivergence = true;
    }
  }

  let isApproved = true;
  let vetoReason: string | undefined;
  let convictionAdjustment = 0;

  if (action === 'LONG') {
    if (finalSlope === 'DISTRIBUTION' && takerRatio < 0.88 && !isAbsorptionDivergence) {
      isApproved = false;
      vetoReason = `🛑 [CVD ORDERFLOW VETO] Aggressive market selling cascade (CVD Distribution, Taker Ratio: ${takerRatio.toFixed(2)} < 0.88). Passive absorption has not appeared.`;
    } else if (isAbsorptionDivergence) {
      convictionAdjustment = 7;
    } else if (finalSlope === 'ACCUMULATION') {
      convictionAdjustment = 4;
    }
  } else if (action === 'SHORT') {
    if (finalSlope === 'ACCUMULATION' && takerRatio > 1.15 && !isExhaustionDivergence) {
      isApproved = false;
      vetoReason = `🛑 [CVD ORDERFLOW VETO] Aggressive market buying cascade (CVD Accumulation, Taker Ratio: ${takerRatio.toFixed(2)} > 1.15). Selling into aggressive taker demand is vetoed.`;
    } else if (isExhaustionDivergence) {
      convictionAdjustment = 7;
    } else if (finalSlope === 'DISTRIBUTION') {
      convictionAdjustment = 4;
    }
  }

  const divStr = isAbsorptionDivergence
    ? ' [Bullish Absorption Divergence 🛡️]'
    : isExhaustionDivergence
    ? ' [Bearish Exhaustion Divergence ⚠️]'
    : '';

  const summary = `CVD Flow: ${finalSlope} (Taker Ratio: ${takerRatio.toFixed(2)})${divStr}`;

  return {
    cvdSlope: finalSlope,
    isAbsorptionDivergence,
    isExhaustionDivergence,
    takerBuyRatio: takerRatio,
    isApproved,
    vetoReason,
    convictionAdjustment,
    summary,
  };
}
