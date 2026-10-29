import { riskGuard } from '../src/risk/guard';

describe('Production Risk Hardening Suite (Client V3)', () => {
  const dummyAiEval: any = {
    action: 'LONG',
    confirmed: true,
    confidenceScore: 90,
    provider: 'local_engine',
    regime: 'STANDARD',
    tradeUrgency: 'NORMAL',
    marketCoolingActive: false,
    reasoning: 'Signals aligned with momentum',
  };

  const baseSignal: any = {
    symbol: 'BTC-USD',
    action: 'LONG',
    entryPrice: 65000,
    suggestedStopLoss: 63700,
    suggestedTakeProfit: 68000,
    confidence: 90,
    suggestedLeverage: 10,
    reason: 'Hardened risk test signal',
    timestamp: Date.now(),
    indicators: {
      upperWickPct: 10,
      lowerWickPct: 35,
      candleColor: 'GREEN',
    },
  };

  it('rejects trade if minimum margin forces loss exceeding $0.85 ceiling', () => {
    // If account equity is $100, and stop loss distance is 10% with minimum margin $35 at 5x leverage
    const wideSlSignal: any = {
      ...baseSignal,
      entryPrice: 100,
      suggestedStopLoss: 90, // 10% distance
      suggestedLeverage: 5,
    };

    const risk = riskGuard.validateSignal(wideSlSignal, dummyAiEval, 100, 100, 0, 0);
    expect(risk.approved).toBe(false);
    expect(risk.reason).toContain('[HARD RISK REJECTION]');
  });

  it('caps allocation so max possible loss at stop loss strictly stays <= $0.85', () => {
    const tightSlSignal: any = {
      ...baseSignal,
      entryPrice: 65000,
      suggestedStopLoss: 64675, // 0.5% distance
      suggestedLeverage: 5,
    };

    const risk = riskGuard.validateSignal(tightSlSignal, dummyAiEval, 100, 100, 0, 0);
    if (risk.approved) {
      const bufferedDist = (Math.abs(tightSlSignal.entryPrice - tightSlSignal.suggestedStopLoss) / tightSlSignal.entryPrice) + 0.0030;
      const potentialLoss = (risk.allocatedUsd || 0) * bufferedDist * (tightSlSignal.suggestedLeverage || 1);
      expect(potentialLoss).toBeLessThanOrEqual(0.8501);
    }
  });
});
