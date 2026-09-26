/**
 * Verification Test: Supercharged AI Shield vs Standalone Mode
 */
import { localAIBrain } from '../src/ai/brain';
import { riskGuard } from '../src/risk/guard';
import { StandaloneSignal, StrategyDirectives } from '../src/engine/standalone-engine';
import { applySimPairDirectives } from '../src/strategy/manager';

function createMockSignal(symbol: string, action: 'LONG' | 'SHORT', upperWick = 15, lowerWick = 15, baseScore = 78): StandaloneSignal {
  return {
    symbol,
    action,
    trend: action === 'LONG' ? 'BULLISH' : 'BEARISH',
    riskLevel: 'LOW',
    triggered: true,
    entryPrice: 10.0,
    stopLoss: action === 'LONG' ? 9.5 : 10.5,
    takeProfit: action === 'LONG' ? 11.5 : 8.5,
    riskRewardRatio: 3.0,
    suggestedLeverage: 3,
    confidence: baseScore,
    baseScore,
    indicators: {
      ema9: 10.1,
      ema21: 9.8,
      ema50: 9.5,
      ema9Previous: 10.0,
      ema21Previous: 9.7,
      emaCrossover: 'BULLISH_CROSS',
      rsi14: 55,
      stochRsi14: 50,
      adx14: 25,
      atr14: 0.3,
      rvol: 1.5,
      upperWickPct: upperWick,
      lowerWickPct: lowerWick,
      bodyPct: 70,
      isTopWickRejection: upperWick > 40,
      isBottomWickRejection: lowerWick > 40,
      isPullbackBounce: true,
      distToEma25Pct: 0.5,
      pullbackStatus: 'PULLBACK_BOUNCE',
      swingHigh: 10.5,
      swingLow: 9.2,
      trend1h: 'BULLISH',
      structureTrend: 'BULLISH_STRUCTURE',
      lastPattern: 'BULLISH_ENGULFING',
      smcSignal: 'SWEEP_LOW_REVERSAL',
    },
    reasons: ['Testing mock setup'],
    strategyName: 'Turtle Soup & Liquidity Grab',
    strategyTags: ['test'],
    entryRationale: 'Testing setup',
    timestamp: Date.now(),
  };
}

async function runTests() {
  console.log('===========================================================');
  console.log('🧪 TESTING AI SHIELD: STANDALONE VS SUPERCHARGED');
  console.log('===========================================================');

  const directives: StrategyDirectives = {
    activeStrategy: 'Turtle Soup & Liquidity Grab',
    scoreFloor: 75,
    bullTrapUpperWickPct: 45,
    bannedSides: [],
    regime: 'TRENDING_BULL',
    source: 'SIMLAB_SUPERCHARGED',
    lastUpdated: Date.now(),
  };

  // ── TEST 1: STANDALONE MODE (Lightweight, No Sim Lab) ──────────────────────
  console.log('\n[Test 1] Standalone Mode: Clean Setup Validation...');
  const cleanSignal = createMockSignal('APT/USD', 'LONG', 15, 15, 78);
  const standaloneEval = await localAIBrain.evaluate(cleanSignal, false, directives);

  console.log(`  Confirmed: ${standaloneEval.confirmed}`);
  console.log(`  Provider:  ${standaloneEval.provider}`);
  console.log(`  Score:     ${standaloneEval.confidenceScore}`);
  console.log(`  Reason:    ${standaloneEval.reasoning}`);
  if (standaloneEval.provider !== 'local_rules' || !standaloneEval.confirmed) {
    throw new Error('Test 1 Failed: Standalone mode should use local_rules and confirm clean setup');
  }
  console.log('✅ Test 1 Passed: Standalone mode executed purely with local_rules without Sim Lab overhead.');

  // ── TEST 2: STANDALONE MODE - Rejection Wick Trap Filter ───────────────────
  console.log('\n[Test 2] Standalone Mode: Upper Wick Trap Filter (> 45%)...');
  const badWickSignal = createMockSignal('APT/USD', 'LONG', 52, 10, 78);
  const badWickEval = await localAIBrain.evaluate(badWickSignal, false, directives);

  console.log(`  Confirmed: ${badWickEval.confirmed}`);
  console.log(`  Score:     ${badWickEval.confidenceScore}`);
  console.log(`  RiskFlags: ${badWickEval.riskFlags.join(', ')}`);
  if (badWickEval.confirmed) {
    throw new Error('Test 2 Failed: Upper wick > 45% must be rejected in standalone mode');
  }
  console.log('✅ Test 2 Passed: High rejection wick cleanly rejected in standalone mode.');

  // ── TEST 3: SUPERCHARGED MODE - CVD Distribution Trap VETO ────────────────
  console.log('\n[Test 3] Supercharged Mode: CVD Distribution Trap Detection...');
  // Inject Sim Lab orderflow where CVD is in SELL distribution while signal is LONG
  applySimPairDirectives({
    'APT/USD': {
      symbol: 'APT/USD',
      coolOffActive: false,
      orderflow: {
        fundingRate: 0.0001,
        oiChange24h: 1.0,
        lsRatio: 1.1,
        cvdTrend: 'SELL', // CVD opposite to candidate LONG!
      },
    } as any,
  });

  const superSignal = createMockSignal('APT/USD', 'LONG', 20, 20, 80);
  const superEval = await localAIBrain.evaluate(superSignal, true, directives);

  console.log(`  Confirmed:    ${superEval.confirmed}`);
  console.log(`  TrapCategory: ${superEval.trapCategory}`);
  console.log(`  Reasoning:    ${superEval.reasoning}`);

  if (superEval.confirmed || superEval.trapCategory !== 'CVD_DISTRIBUTION_TRAP') {
    throw new Error('Test 3 Failed: Supercharged mode must veto when Sim Lab CVD is in SELL distribution');
  }

  // Verify that the 15-minute cool-off lock was automatically engaged in RiskGuard
  const lock = riskGuard.getActiveTrapCoolOff('APT/USD', 'LONG');
  console.log(`  15m Cool-Off Active: ${lock.locked}`);
  console.log(`  Lock Trap Category:  ${lock.trapCategory}`);
  console.log(`  Lock Minutes Left:   ${lock.remainingMinutes}m`);

  if (!lock.locked || lock.trapCategory !== 'CVD_DISTRIBUTION_TRAP') {
    throw new Error('Test 3 Failed: 15-minute cool-off lock was not properly engaged');
  }
  console.log('✅ Test 3 Passed: Sim Lab CVD Distribution Trap vetoed and 15m cool-off lock engaged.');

  // ── TEST 4: SUPERCHARGED MODE - RiskGuard Fast 0ms Veto via 15m Lock ───────
  console.log('\n[Test 4] Supercharged Mode: Pre-Trade RiskGuard 0ms Block via Active 15m Lock...');
  const riskResult = riskGuard.validateSignal(superSignal, superEval, 100, 100, 0);

  console.log(`  Approved: ${riskResult.approved}`);
  console.log(`  Reason:   ${riskResult.reason}`);

  if (riskResult.approved || !riskResult.reason.includes('Blocked by 15m AI Shield Trap Cool-Off')) {
    throw new Error('Test 4 Failed: RiskGuard must reject order in 0ms due to active 15m cool-off');
  }
  console.log('✅ Test 4 Passed: RiskGuard successfully blocked duplicate churn in 0ms.');

  // ── TEST 5: SUPERCHARGED MODE - Tactical Conviction Booster (+8%) ──────────
  console.log('\n[Test 5] Supercharged Mode: Tactical Conviction Booster (+8%)...');
  // Inject clean Sim Lab orderflow (CVD BUY + expanding OI)
  applySimPairDirectives({
    'SOL/USD': {
      symbol: 'SOL/USD',
      coolOffActive: false,
      orderflow: {
        fundingRate: 0.0001,
        oiChange24h: 3.8, // Expanding capital
        lsRatio: 1.05,
        cvdTrend: 'BUY',  // CVD confirms candidate LONG!
      },
    } as any,
  });

  const originalProv = (localAIBrain as any).activeProvider;
  (localAIBrain as any).activeProvider = 'local_rules';
  const pristineSignal = createMockSignal('SOL/USD', 'LONG', 10, 10, 80);
  const boostEval = await localAIBrain.evaluate(pristineSignal, true, directives);
  (localAIBrain as any).activeProvider = originalProv;

  console.log(`  Confirmed:       ${boostEval.confirmed}`);
  console.log(`  Original Score:  ${pristineSignal.baseScore}`);
  console.log(`  Boosted Score:   ${boostEval.confidenceScore}`);
  console.log(`  ConvictionBonus: +${boostEval.convictionBonus}%`);
  console.log(`  Reasoning:       ${boostEval.reasoning}`);

  if (!boostEval.confirmed || (boostEval.convictionBonus ?? 0) <= 0 || boostEval.confidenceScore <= pristineSignal.baseScore) {
    throw new Error('Test 5 Failed: Tactical conviction booster was not awarded for clean institutional move');
  }
  console.log('✅ Test 5 Passed: Tactical Conviction Booster (+8%) awarded for verified institutional move.');

  console.log('\n===========================================================');
  console.log('🎉 ALL 5 AI SHIELD VERIFICATION TESTS PASSED SUCCESSFULLY!');
  console.log('===========================================================');
}

runTests().catch((err) => {
  console.error('❌ Test Error:', err);
  process.exit(1);
});
