/**
 * Strategy Studio Modular Types & Schemas
 * Defines modular layer configurations, pre-built templates, and AI evaluation models.
 */

export type LayerId = 'layer0_kronos' | 'layer1_macro' | 'layer2_liquidity' | 'layer3_smc' | 'layer4_ai' | 'layer5_execution';

export interface Layer0Config {
  enabled: boolean;
  timeframe: '5m' | '15m';
  requireTrajectoryConfluence: boolean;  // Must match trade direction (Long or Short)
  minExpectedReturnPct: number;          // Min expected return (e.g. ±0.80%)
  minEvRatio: number;                    // Min Symmetrical EV ratio (e.g. 1.40x)
  maxEntropyScore: number;               // Max allowable randomness (e.g. 0.60)
  knifeShieldEnabled?: boolean;          // Falling knife veto (>= 0.70)
  meltUpShieldEnabled?: boolean;         // Parabolic short squeeze veto (>= 0.70)
}

export interface Layer1Config {
  enabled: boolean;
  timeframe: '5m' | '15m' | '1h' | '4h';
  trendFilterEma: boolean;            // Require price aligned with 1h EMA25/50
  pullbackEmaEnvelope: boolean;       // Require price within EMA25/50 dynamic value zone
  envelopeTolerancePct: number;       // e.g. 0.20% (±0.20% from EMA)
  rsiHealthyBand: boolean;            // Require RSI between 40 and 60
  adxTrendThreshold: number;          // Minimum ADX (e.g. 20)
  stochRsiFilter: boolean;            // Block oversold shorts / overbought longs
  volumeProfileEnabled?: boolean;     // Enable Auction Market Theory Volume Profile
  boxPocTimeframe?: '15m' | '1h' | 'dual'; // Timeframe for horizontal consolidation box POC
  boxConsolidationRetest?: boolean;   // Require breakout + pullback to Box POC (anti-chasing)
  fastSmaRetestEnabled?: boolean;     // Require pullback retest of Fast Robust Island SMA as dynamic support/resistance
  fastSmaRetestTolerancePct?: number; // Tolerance distance to Fast SMA (e.g. 0.35%)
  maxBarsSinceCrossover?: number;     // Maximum completed bars since SMA crossover for entry freshness (Option A: 4 bars)
  fastPeriod?: number;                // Fast Robust Island SMA period (e.g. 9 or 20)
  slowPeriod?: number;                // Slow Robust Island SMA period (e.g. 21 or 50)
  smaSpreadThresholdPct?: number;     // Minimum spread % between fast & slow SMA (e.g. 0.05%)
  smaCrossoverWeight?: number;        // Dynamic weight multiplier for SMA crossover alignment (e.g. 15%)
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
  requireWhaleAlignment?: boolean;
  requireCvdConfirmation?: boolean;
  spotPerpCvdFilter?: boolean;
  minL2DepthRatio?: number;
}

export interface Layer3Config {
  enabled: boolean;
  turtleSoupSweep: boolean;           // Require wick sweep (≥40% wick) into liquidity
  blockBodyRun: boolean;              // Invalidate counter-trend if candle body closes past cluster (>0.15%)
  premiumDiscountEquilibrium: boolean;// Never buy in Premium (>50% range) / Never sell in Discount (<50% range)
  structureShiftChoch: boolean;       // Require 15m CHoCH or BOS displacement
  fvgRetestEntry: boolean;            // Limit order entry at Fair Value Gap boundary
  equalHighsLowsMagnet: boolean;      // Target EQH/EQL stop-loss pools
  boxConsolidationRetest?: boolean;   // Require breakout + pullback to Box POC (anti-chasing)
  boxTimeframe?: '15m' | '1h' | 'dual'; // Timeframe for horizontal consolidation box
  antiChaseBreakoutFilter?: boolean;  // Veto entering late breakouts outside the value area
  volumeProfileEnabled?: boolean;     // Layer 3 Volume Profile
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
  whaleRetailDivergenceVeto?: boolean;
  futuresLeverageTrapVeto?: boolean;
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
  minMarginUsd?: number;              // Minimum margin in USD allocated per trade (defaults to $20.00)
  dualTakeProfit: boolean;            // TP1 (50% Equilibrium) + TP2 (Opposing Liquidation Pool)
  tp1CloseRatio: number;              // e.g. 0.50 (close 50% at TP1)
  moveSlToBreakevenAtTp1: boolean;    // Move SL to Entry + 0.05% when TP1 hits
  stagnationTimeStopBars: number;     // e.g. 8 bars (2 hours)
  enforcePostOnly?: boolean;          // PILLAR 1: Strictly enforce Maker PostOnly routing (TIF=1) with zero taker fee drag
  makerFillTimeoutMs?: number;       // Window to wait for resting order fill before clean cancel (e.g. 25000ms)
  allowTakerFallback?: boolean;      // If false, never convert unfilled maker orders into IOC takers
  fastSmaTrailingStopEnabled?: boolean; // Dynamically tighten Stop-Loss to Fast SMA or Breakeven when tested during trade
  fastSmaTrailingBufferPct?: number;   // Buffer distance for trailing SL (e.g. 0.15%)
  breakevenFeeBufferPct?: number;      // Breakeven fee buffer cushion (e.g. 0.75%)
  dynamicTakeProfit1R?: number;        // Dynamic TP1 target R multiple (e.g. 1.25R)
  dynamicTakeProfit2R?: number;        // Dynamic TP2 target R multiple (e.g. 2.50R)
  stagnationProfitHarvestR?: number;   // Profit threshold to harvest early on stagnation (e.g. 0.50R)
  dynamicGapLambda?: number;           // Amber Band Harvest Master Tier 1 penetration (e.g. 0.30 for 30% gap)
  dynamicGapExitLambda?: number;       // Amber Band Harvest Master Tier 2 terminal close (e.g. 0.50 for 50% midpoint)
  noFixedTp?: boolean;                 // Open-ended runner without rigid on-chain DEX TP
  exit50CloseEnabled?: boolean;        // 50% midpoint touch terminal close
  pureRobustIslandExit?: boolean;      // When true, exits are 100% pure SMA dynamic gap (L30/L50), no multi-factor interference
  allowDiscretionaryHarvest?: boolean; // When false, discretionary multi-factor vulnerability harvests are permanently locked off
  targetAssets?: string[];             // Whitelisted symbols (e.g. ['SOL/USD', 'ETH/USD'])
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
  layer0_kronos?: Layer0Config;
  layer1: Layer1Config;
  layer2: Layer2Config;
  layer3: Layer3Config;
  layer4: Layer4Config;
  layer5: Layer5Config;
  certifiedByRiskSentinel?: boolean;
  certificationScore?: number;
  optimalRegimes?: string[];
  targetAssets?: string[];
  stagedStatus?: 'ACTIVE_LIVE' | 'READY_ARSENAL' | 'DRAFT';
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
  layer0_kronos?: boolean | Partial<Layer0Config>;
  layer1?: boolean | Partial<Layer1Config>;
  layer2?: boolean | Partial<Layer2Config>;
  layer3?: boolean | Partial<Layer3Config>;
  layer4?: boolean | Partial<Layer4Config>;
  layer5?: Partial<Layer5Config>;
  fastPeriod?: number;
  slowPeriod?: number;
  fastSmaRetestEnabled?: boolean;
  fastSmaRetestTolerancePct?: number;
  fastSmaTrailingStopEnabled?: boolean;
  fastSmaTrailingBufferPct?: number;
  breakevenFeeBufferPct?: number;
  dynamicTakeProfit1R?: number;
  dynamicTakeProfit2R?: number;
  maxLeverage?: number;
  slMultiplier?: number;
  minConfidenceGate?: number;
  assignedStrategyId?: string;
  assignedStrategyName?: string;
  assignedTier?: 'TIER_1_ALPHA' | 'TIER_1_CHAMPION' | 'TIER_2_INCUBATOR' | 'TIER_2_STABLE' | 'TIER_3_PROBATION';
  tierAllocPct?: number;
  probationActive?: boolean;
  reason?: string;
  sandboxTradesRemaining?: number;
  sandboxWins?: number;
  rotationHistory?: Array<{
    timestamp: number;
    fromStrategyId?: string;
    toStrategyId?: string;
    previousStrategyId?: string;
    newStrategyId?: string;
    reason: string;
  }>;
  preset?: 'MAJOR_TREND' | 'HIGH_BETA_ALT' | 'SIM_LAB' | 'CREAMER_ORDERFLOW' | 'CUSTOM' | 'MANUAL';
  currentFastSma?: number;
  currentSlowSma?: number;
  smaSpreadPct?: number;
  smaAlignment?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  robustScore?: number;
  wfe?: number;
  barsSinceCross?: number;
  isFreshCross?: boolean;
  priceRetestLong?: boolean;
  priceRetestShort?: boolean;
  priceVsFastSmaPct?: number;
  trailingStopLong?: number;
  trailingStopShort?: number;
  executionProfile?: 'STANDARD_SWING';
  makerOffsetPct?: number;
  orderbookSpreadPct?: number;
  enforcePostOnly?: boolean;
  allowTakerFallback?: boolean;
  updatedAt?: number;
}

export interface PairAutoTuneResult {
  symbol: string;
  recommendedLayers: {
    layer0_kronos?: boolean;
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
  presetMatch: 'MAJOR_TREND' | 'HIGH_BETA_ALT' | 'SIM_LAB' | 'CREAMER_ORDERFLOW' | 'CUSTOM';
}

export interface StrategyAttribution {
  strategyId: string;
  strategyName: string;
  isPairOverride: boolean;
  layersActive: {
    layer0_kronos?: boolean;
    layer1: boolean;
    layer2: boolean;
    layer3: boolean;
    layer4: boolean;
    layer5: boolean;
  };
  pairOverrides?: PairLayerOverrides | null;
}
