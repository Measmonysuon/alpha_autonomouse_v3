/**
 * Pre-Built Institutional Strategy Templates
 * 4 Battle-tested combinations ready for instant 1-click deployment.
 */

import { StrategyConfig } from './types';

export const PREBUILT_TEMPLATES: StrategyConfig[] = [
  // ── Template 1: Turtle Soup & Liquidity Grab (The 4-Layer Flagship) ────────
  {
    id: 'template_turtle_soup',
    name: 'Turtle Soup & Liquidity Grab',
    description: 'Flagship 4-layer institutional model. Sweeps CoinGlass liquidation clusters with ΔOI < 0, confirms CHoCH displacement, and limits into FVG with dual TP1/TP2 scaling.',
    version: '2.0.0',
    isPrebuilt: true,
    author: 'Institutional Desk',
    createdAt: 1789200000000,
    updatedAt: 1789200000000,
    layerOrder: ['layer1_macro', 'layer2_liquidity', 'layer3_smc', 'layer4_ai', 'layer5_execution'],
    layer1: {
      enabled: true,
      timeframe: '15m',
      trendFilterEma: true,
      pullbackEmaEnvelope: true,
      envelopeTolerancePct: 0.20,
      rsiHealthyBand: true,
      adxTrendThreshold: 20,
      stochRsiFilter: true,
    },
    layer2: {
      enabled: true,
      useLiquidationClusters: true,
      minClusterUsd: 5000000,
      requireDeltaOiFlush: true,
      deltaOiThresholdPct: -2.0,
      fundingRateAsymmetry: true,
      maxFundingAbsPct: 0.03,
      whaleRetailDivergence: true,
    },
    layer3: {
      enabled: true,
      turtleSoupSweep: true,
      blockBodyRun: true,
      premiumDiscountEquilibrium: true,
      structureShiftChoch: true,
      fvgRetestEntry: true,
      equalHighsLowsMagnet: true,
    },
    layer4: {
      enabled: true,
      qwenTrapShield: true,
      vetoOnSpoofing: true,
      macroNewsFreeze: true,
      coinStatsSecurityAudit: true,
      convictionBoostAllowed: true,
      defillamaBorrowVeto: true,
      maxBorrowApyThreshold: 20,
    },
    layer5: {
      enabled: true,
      minConfidenceGate: 80,
      minRiskRewardRatio: 2.5,
      leverageMode: 'RISK_PARITY_SAFETY_CAP',
      minLeverage: 3,
      maxLeverage: 8,
      leverage: 5,
      minAllocPct: 20,
      maxAllocPct: 40,
      dualTakeProfit: true,
      tp1CloseRatio: 0.50,
      moveSlToBreakevenAtTp1: true,
      stagnationTimeStopBars: 8,
    },
  },

  // ── Template 2: MTF Pullback Trend Sniper (Conservative) ───────────────────
  {
    id: 'template_trend_sniper',
    name: 'MTF Trend Pullback Sniper',
    description: 'Conservative trend-following sniper. Strictly trades in direction of 1h Macro Trend, entering on 15m EMA 25/50 dynamic value bounce in discount with institutional BOS.',
    version: '2.0.0',
    isPrebuilt: true,
    author: 'Quant Trend Systems',
    createdAt: 1789200000000,
    updatedAt: 1789200000000,
    layerOrder: ['layer1_macro', 'layer3_smc', 'layer2_liquidity', 'layer4_ai', 'layer5_execution'],
    layer1: {
      enabled: true,
      timeframe: '15m',
      trendFilterEma: true,
      pullbackEmaEnvelope: true,
      envelopeTolerancePct: 0.20,
      rsiHealthyBand: true,
      adxTrendThreshold: 25,
      stochRsiFilter: true,
    },
    layer2: {
      enabled: true,
      useLiquidationClusters: true,
      minClusterUsd: 3000000,
      requireDeltaOiFlush: false,
      deltaOiThresholdPct: 0.0,
      fundingRateAsymmetry: false,
      maxFundingAbsPct: 0.025,
      whaleRetailDivergence: false,
    },
    layer3: {
      enabled: true,
      turtleSoupSweep: false,
      blockBodyRun: false,
      premiumDiscountEquilibrium: true,
      structureShiftChoch: true,
      fvgRetestEntry: true,
      equalHighsLowsMagnet: false,
    },
    layer4: {
      enabled: true,
      qwenTrapShield: true,
      vetoOnSpoofing: true,
      macroNewsFreeze: true,
      coinStatsSecurityAudit: true,
      convictionBoostAllowed: true,
      defillamaBorrowVeto: true,
      maxBorrowApyThreshold: 20,
    },
    layer5: {
      enabled: true,
      minConfidenceGate: 68,
      minRiskRewardRatio: 2.2,
      leverageMode: 'RISK_PARITY_SAFETY_CAP',
      minLeverage: 3,
      maxLeverage: 7,
      leverage: 5,
      minAllocPct: 20,
      maxAllocPct: 35,
      dualTakeProfit: true,
      tp1CloseRatio: 0.50,
      moveSlToBreakevenAtTp1: true,
      stagnationTimeStopBars: 8,
    },
  },

  // ── Template 3: Funding Rate Squeeze & Liquidation Cascade Hunter ───────────
  {
    id: 'template_squeeze_hunter',
    name: 'Funding Squeeze & Cascade Hunter',
    description: 'Aggressive derivatives volatility hunter. Exploits crowded retail herd skew with extreme positive/negative funding, entering on forced liquidation cascade breakouts.',
    version: '2.0.0',
    isPrebuilt: true,
    author: 'Derivatives Alpha',
    createdAt: 1789200000000,
    updatedAt: 1789200000000,
    layerOrder: ['layer2_liquidity', 'layer1_macro', 'layer3_smc', 'layer4_ai', 'layer5_execution'],
    layer1: {
      enabled: true,
      timeframe: '15m',
      trendFilterEma: false,
      pullbackEmaEnvelope: false,
      envelopeTolerancePct: 0.35,
      rsiHealthyBand: false,
      adxTrendThreshold: 20,
      stochRsiFilter: false,
    },
    layer2: {
      enabled: true,
      useLiquidationClusters: true,
      minClusterUsd: 8000000,
      requireDeltaOiFlush: true,
      deltaOiThresholdPct: -3.0,
      fundingRateAsymmetry: true,
      maxFundingAbsPct: 0.05,
      whaleRetailDivergence: true,
    },
    layer3: {
      enabled: true,
      turtleSoupSweep: true,
      blockBodyRun: true,
      premiumDiscountEquilibrium: false,
      structureShiftChoch: true,
      fvgRetestEntry: false,
      equalHighsLowsMagnet: true,
    },
    layer4: {
      enabled: true,
      qwenTrapShield: true,
      vetoOnSpoofing: true,
      macroNewsFreeze: true,
      coinStatsSecurityAudit: true,
      convictionBoostAllowed: true,
      defillamaBorrowVeto: true,
      maxBorrowApyThreshold: 20,
    },
    layer5: {
      enabled: true,
      minConfidenceGate: 65,
      minRiskRewardRatio: 2.8,
      leverageMode: 'RISK_PARITY_SAFETY_CAP',
      minLeverage: 3,
      maxLeverage: 10,
      leverage: 5,
      minAllocPct: 20,
      maxAllocPct: 40,
      dualTakeProfit: true,
      tp1CloseRatio: 0.50,
      moveSlToBreakevenAtTp1: true,
      stagnationTimeStopBars: 6,
    },
  },

  // ── Template 4: Mean-Reversion Equilibrium Scalper (Chop Regime) ────────────
  {
    id: 'template_range_scalper',
    name: 'Mean-Reversion Equilibrium Scalper',
    description: 'Designed for low-ADX (<20) sideways chop. Fades range extremes by buying at range discount support and shorting at premium resistance targeting the 50% equilibrium midline.',
    version: '2.0.0',
    isPrebuilt: true,
    author: 'Market Maker Neutral',
    createdAt: 1789200000000,
    updatedAt: 1789200000000,
    layerOrder: ['layer3_smc', 'layer1_macro', 'layer2_liquidity', 'layer4_ai', 'layer5_execution'],
    layer1: {
      enabled: true,
      timeframe: '15m',
      trendFilterEma: false,
      pullbackEmaEnvelope: false,
      envelopeTolerancePct: 0.25,
      rsiHealthyBand: false,
      adxTrendThreshold: 15,
      stochRsiFilter: true,
    },
    layer2: {
      enabled: false,
      useLiquidationClusters: false,
      minClusterUsd: 2000000,
      requireDeltaOiFlush: false,
      deltaOiThresholdPct: 0.0,
      fundingRateAsymmetry: false,
      maxFundingAbsPct: 0.02,
      whaleRetailDivergence: false,
    },
    layer3: {
      enabled: true,
      turtleSoupSweep: true,
      blockBodyRun: true,
      premiumDiscountEquilibrium: true,
      structureShiftChoch: true,
      fvgRetestEntry: true,
      equalHighsLowsMagnet: true,
    },
    layer4: {
      enabled: true,
      qwenTrapShield: true,
      vetoOnSpoofing: true,
      macroNewsFreeze: true,
      coinStatsSecurityAudit: true,
      convictionBoostAllowed: false,
      defillamaBorrowVeto: true,
      maxBorrowApyThreshold: 20,
    },
    layer5: {
      enabled: true,
      minConfidenceGate: 50,
      minRiskRewardRatio: 2.0,
      leverageMode: 'RISK_PARITY_SAFETY_CAP',
      minLeverage: 2,
      maxLeverage: 5,
      leverage: 5,
      minAllocPct: 20,
      maxAllocPct: 30,
      dualTakeProfit: false,
      tp1CloseRatio: 1.0,
      moveSlToBreakevenAtTp1: true,
      stagnationTimeStopBars: 8,
    },
  },

  // ── Template 5: FOMO Velocity & Quick Hit-and-Run Scalper ──────────────────
  {
    id: 'template_fomo_scalper',
    name: 'FOMO Velocity & Hit-and-Run Scalper',
    description: 'High-frequency momentum scalper. Catches sudden FOMO volume expansion and breakout impulses, locking in fast profits with tight 70% scale-outs and high multi-position concurrency.',
    version: '2.0.0',
    isPrebuilt: true,
    author: 'Momentum Velocity Desk',
    createdAt: 1789200000000,
    updatedAt: 1789200000000,
    layerOrder: ['layer1_macro', 'layer2_liquidity', 'layer3_smc', 'layer4_ai', 'layer5_execution'],
    layer1: {
      enabled: true,
      timeframe: '15m',
      trendFilterEma: true,              // Follow the FOMO surge direction
      pullbackEmaEnvelope: false,        // Don't wait for deep pullbacks — enter on velocity expansion!
      envelopeTolerancePct: 0.35,        // Generous tolerance
      rsiHealthyBand: false,             // Don't cap high-momentum RSI (>60)
      adxTrendThreshold: 18,             // Early momentum trigger (ADX >= 18)
      stochRsiFilter: false,             // Allow overbought/oversold continuation runs
    },
    layer2: {
      enabled: true,
      useLiquidationClusters: true,
      minClusterUsd: 2000000,            // $2.0M cluster (lower threshold so it fires across more pairs)
      requireDeltaOiFlush: false,        // Ride the initial OI surge before exhaustion
      deltaOiThresholdPct: 0.0,
      fundingRateAsymmetry: false,
      maxFundingAbsPct: 0.04,
      whaleRetailDivergence: false,
    },
    layer3: {
      enabled: true,
      turtleSoupSweep: false,            // Breakout momentum, not a reversal fade
      blockBodyRun: false,               // Do NOT block strong candle body breakout runs!
      premiumDiscountEquilibrium: false, // Don't block momentum expansion out of equilibrium
      structureShiftChoch: true,         // Ensure real micro displacement (BOS/CHoCH)
      fvgRetestEntry: true,              // Quick limit entry at micro FVG boundary
      equalHighsLowsMagnet: true,        // Uses overhead/underlying stops as quick fuel
    },
    layer4: {
      enabled: true,
      qwenTrapShield: true,              // Tactical Defense AI protects from rug/pump-and-dump traps
      vetoOnSpoofing: true,              // Blocks fake phantom walls
      macroNewsFreeze: true,             // Freezes during CPI/FOMC shock volatility
      coinStatsSecurityAudit: true,
      convictionBoostAllowed: true,
      defillamaBorrowVeto: true,
      maxBorrowApyThreshold: 20,
    },
    layer5: {
      enabled: true,
      minConfidenceGate: 60,
      minRiskRewardRatio: 1.8,           // Quick hit-and-run R:R target (1:1.8)
      leverageMode: 'RISK_PARITY_SAFETY_CAP',
      minLeverage: 3,
      maxLeverage: 10,
      leverage: 5,
      minAllocPct: 15,                   // Lower 15% allocation = accommodates 3+ simultaneous open positions!
      maxAllocPct: 25,
      dualTakeProfit: true,
      tp1CloseRatio: 0.70,               // 70% immediate scale-out to secure quick profit
      moveSlToBreakevenAtTp1: true,      // Lock in risk-free status immediately
      stagnationTimeStopBars: 4,         // 4 bars (60m) - fast time-stop if momentum stalls
    },
  },
];
