/**
 * Strategy Studio Modular Types & Schemas
 * Defines modular layer configurations, pre-built templates, and AI evaluation models.
 */

export type LayerId = 'layer1_macro' | 'layer2_liquidity' | 'layer3_smc' | 'layer4_ai' | 'layer5_execution';

export interface Layer1Config {
  enabled: boolean;
  timeframe: '15m' | '1h' | '4h';
  trendFilterEma: boolean;            // Require price aligned with 1h EMA25/50
  pullbackEmaEnvelope: boolean;       // Require price within EMA25/50 dynamic value zone
  envelopeTolerancePct: number;       // e.g. 0.20% (±0.20% from EMA)
  rsiHealthyBand: boolean;            // Require RSI between 40 and 60
  adxTrendThreshold: number;          // Minimum ADX (e.g. 20)
  stochRsiFilter: boolean;            // Block oversold shorts / overbought longs
}

export interface Layer2Config {
  enabled: boolean;
  useLiquidationClusters: boolean;    // Use CoinGlass high-density clusters as magnets
  minClusterUsd: number;              // Minimum cluster size in USD (e.g. $5,000,000)
  requireDeltaOiFlush: boolean;       // Require ΔOI < 0 on sweep candle (exhaustion)
  deltaOiThresholdPct: number;        // e.g. -2.0%
  fundingRateAsymmetry: boolean;      // Require favorable funding skew
  maxFundingAbsPct: number;           // e.g. 0.03% (block extreme carry cost)
  whaleRetailDivergence: boolean;     // Contrast top traders vs retail
}

export interface Layer3Config {
  enabled: boolean;
  turtleSoupSweep: boolean;           // Require wick sweep (≥40% wick) into liquidity
  blockBodyRun: boolean;              // Invalidate counter-trend if candle body closes past cluster (>0.15%)
  premiumDiscountEquilibrium: boolean;// Never buy in Premium (>50% range) / Never sell in Discount (<50% range)
  structureShiftChoch: boolean;       // Require 15m CHoCH or BOS displacement
  fvgRetestEntry: boolean;            // Limit order entry at Fair Value Gap boundary
  equalHighsLowsMagnet: boolean;      // Target EQH/EQL stop-loss pools
}

export interface Layer4Config {
  enabled: boolean;
  qwenTrapShield: boolean;            // Run adversarial Qwen 2.5 trap validator
  vetoOnSpoofing: boolean;            // Veto if L2 order book shows phantom walls
  macroNewsFreeze: boolean;           // Freeze trading -5m to +30m around CPI/FOMC/NFP
  coinStatsSecurityAudit: boolean;    // Check smart contract honeypot/mint risks
  convictionBoostAllowed: boolean;    // Allow AI to award +5% to +10% for A+ setups
  defillamaBorrowVeto?: boolean;      // Veto late longs when DefiLlama borrow APY is overheated (>18-22%)
  maxBorrowApyThreshold?: number;     // e.g. 20% (defaults to 20%)
}

export type LeverageMode = 
  | 'RISK_PARITY_SAFETY_CAP'  // Option C (Default): Scales with confidence + caps leverage so trade cannot liquidate before SL
  | 'DYNAMIC_LINEAR'          // Option A: Smooth linear scaling from min to max between 80% and 100% confidence
  | 'DYNAMIC_TIERS'           // Option B: 4 Discrete conviction brackets (80-84%, 85-89%, 90-94%, 95-100%)
  | 'FIXED';                  // Fixed static leverage (legacy mode)

export interface Layer5Config {
  enabled: boolean;
  minConfidenceGate?: number;         // Minimum strategy confidence threshold to open trade (e.g. 50% - 85%, defaults to 80%)
  minRiskRewardRatio: number;         // Minimum R:R (e.g. 2.50)
  leverageMode?: LeverageMode;        // Dynamic scaling mode (defaults to RISK_PARITY_SAFETY_CAP)
  minLeverage?: number;               // Dynamic lower bound (e.g. 2x - 3x)
  maxLeverage?: number;               // Dynamic upper bound (e.g. 8x - 15x)
  leverage: number;                   // Fallback / fixed value (e.g. 5x)
  minAllocPct: number;                // e.g. 20% of budget ($10.10)
  maxAllocPct: number;                // e.g. 40% of budget ($20.20)
  dualTakeProfit: boolean;            // TP1 (50% Equilibrium) + TP2 (Opposing Liquidation Pool)
  tp1CloseRatio: number;              // e.g. 0.50 (close 50% at TP1)
  moveSlToBreakevenAtTp1: boolean;    // Move SL to Entry + 0.05% when TP1 hits
  stagnationTimeStopBars: number;     // e.g. 8 bars (2 hours)
}

export interface StrategyConfig {
  id: string;
  name: string;
  description: string;
  version: string;
  isPrebuilt?: boolean;
  isSimLab?: boolean;
  isCustom?: boolean;
  author?: string;
  winRatePct?: number;
  createdAt: number;
  updatedAt: number;
  layerOrder: LayerId[];              // Drag-and-drop layer order
  layer1: Layer1Config;
  layer2: Layer2Config;
  layer3: Layer3Config;
  layer4: Layer4Config;
  layer5: Layer5Config;
}

export interface AIEvaluationResult {
  strategyId: string;
  evaluatedAt: number;
  score: number;                      // Overall quantitative score (0-100)
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  suitability: 'TREND' | 'VOLATILITY' | 'RANGE_CHOP' | 'ALL_REGIMES';
  projectedWinRatePct: number;        // e.g. 68%
  projectedSharpeRatio: number;       // e.g. 2.1
  riskProfile: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
  strengths: string[];
  vulnerabilities: string[];
  recommendations: string[];
  readyForDeployment: boolean;
  summary: string;
}

export interface PairLayerOverrides {
  layer1?: boolean;
  layer2?: boolean;
  layer3?: boolean;
  layer4?: boolean;
  maxLeverage?: number;
  slMultiplier?: number;
  minConfidenceGate?: number;
  preset?: 'MAJOR_TREND' | 'HIGH_BETA_ALT' | 'SIM_LAB' | 'CUSTOM' | 'MANUAL';
  updatedAt?: number;
}

export interface PairAutoTuneResult {
  symbol: string;
  recommendedLayers: {
    layer1: boolean;
    layer2: boolean;
    layer3: boolean;
    layer4: boolean;
  };
  recommendedMaxLeverage: number;
  recommendedSlMultiplier: number;
  recommendedGate: number;
  confidence: number;
  rationale: string;
  presetMatch: 'MAJOR_TREND' | 'HIGH_BETA_ALT' | 'SIM_LAB' | 'CUSTOM';
}

export interface StrategyAttribution {
  strategyId: string;
  strategyName: string;
  isPairOverride: boolean;
  layersActive: {
    layer1: boolean;
    layer2: boolean;
    layer3: boolean;
    layer4: boolean;
    layer5: boolean;
  };
  pairOverrides?: PairLayerOverrides | null;
}
