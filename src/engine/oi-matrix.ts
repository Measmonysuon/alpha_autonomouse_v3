/**
 * Institutional Open Interest (OI) Co-Movement Matrix Engine
 */

export type OICoMovementQuadrant =
  | 'ORGANIC_ACCUMULATION'
  | 'SHORT_COVERING_RALLY'
  | 'ORGANIC_DISTRIBUTION'
  | 'LONG_LIQUIDATION_FLUSH'
  | 'NEUTRAL';

export interface OICoMovementAnalysis {
  quadrant: OICoMovementQuadrant;
  priceDeltaPct: number;
  oiDeltaPct: number;
  isLongApproved: boolean;
  isShortApproved: boolean;
  convictionBonus: number;
  vetoReason?: string;
  summary: string;
}

export function evaluateOICoMovement(
  priceDeltaPct: number,
  oiDeltaPct: number | undefined,
  action: 'LONG' | 'SHORT'
): OICoMovementAnalysis {
  if (oiDeltaPct === undefined || isNaN(oiDeltaPct)) {
    return {
      quadrant: 'NEUTRAL',
      priceDeltaPct,
      oiDeltaPct: 0,
      isLongApproved: true,
      isShortApproved: true,
      convictionBonus: 0,
      summary: 'OI Co-Movement: N/A (Optional feed in backup mode)',
    };
  }

  const isPriceUp = priceDeltaPct > 0.4;
  const isPriceDown = priceDeltaPct < -0.4;
  const isOIUp = oiDeltaPct > 0.8;
  const isOIDown = oiDeltaPct < -0.8;

  let quadrant: OICoMovementQuadrant = 'NEUTRAL';

  if (isPriceUp && isOIUp) {
    quadrant = 'ORGANIC_ACCUMULATION';
  } else if (isPriceUp && isOIDown) {
    quadrant = 'SHORT_COVERING_RALLY';
  } else if (isPriceDown && isOIUp) {
    quadrant = 'ORGANIC_DISTRIBUTION';
  } else if (isPriceDown && isOIDown) {
    quadrant = 'LONG_LIQUIDATION_FLUSH';
  }

  let isLongApproved = true;
  let isShortApproved = true;
  let convictionBonus = 0;
  let vetoReason: string | undefined;

  switch (quadrant) {
    case 'ORGANIC_ACCUMULATION':
      if (action === 'LONG') {
        convictionBonus = 6;
      } else {
        isShortApproved = false;
        vetoReason = `🛑 [OI MATRIX VETO] Shorting into Organic Accumulation (Price +${priceDeltaPct.toFixed(2)}%, OI +${oiDeltaPct.toFixed(2)}%). Institutional capital is expanding longs.`;
      }
      break;

    case 'SHORT_COVERING_RALLY':
      if (action === 'LONG' && priceDeltaPct >= 1.5) {
        isLongApproved = false;
        vetoReason = `🛑 [OI MATRIX VETO] Bull Trap (Short Covering): Price up +${priceDeltaPct.toFixed(2)}% while Open Interest is dropping (${oiDeltaPct.toFixed(2)}%). Breakout lacks fresh buyer capital.`;
      }
      break;

    case 'ORGANIC_DISTRIBUTION':
      if (action === 'LONG') {
        isLongApproved = false;
        vetoReason = `🛑 [OI MATRIX VETO] Aggressive Seller Drive: Price falling (${priceDeltaPct.toFixed(2)}%) while Open Interest is surging (+${oiDeltaPct.toFixed(2)}%). Pullback is driven by new institutional short positions.`;
      } else {
        convictionBonus = 6;
      }
      break;

    case 'LONG_LIQUIDATION_FLUSH':
      if (action === 'SHORT' && priceDeltaPct <= -1.5) {
        isShortApproved = false;
        vetoReason = `🛑 [OI MATRIX VETO] Bear Trap (Liquidation Exhaustion): Price dumped (${priceDeltaPct.toFixed(2)}%) but Open Interest collapsed (${oiDeltaPct.toFixed(2)}%). Selling pressure is exhausted weak hands.`;
      } else if (action === 'LONG') {
        convictionBonus = 3;
      }
      break;

    case 'NEUTRAL':
    default:
      convictionBonus = 0;
      break;
  }

  const signOI = oiDeltaPct >= 0 ? '+' : '';
  const signP = priceDeltaPct >= 0 ? '+' : '';
  const summary = `OI Matrix: ${quadrant} (Price ${signP}${priceDeltaPct.toFixed(2)}%, OI ${signOI}${oiDeltaPct.toFixed(2)}%)`;

  return {
    quadrant,
    priceDeltaPct,
    oiDeltaPct,
    isLongApproved,
    isShortApproved,
    convictionBonus,
    vetoReason,
    summary,
  };
}
