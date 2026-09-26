import fs from 'fs';
import path from 'path';
import { tradeExecutor, TradeRecord } from '../trades/executor';
import { mcpClient } from '../mcp/client';
import { logger } from '../utils/logger';
import { getSimPairDirective } from '../strategy/manager';

export interface DynamicVulnerabilityWeights {
  rsiOverextensionMax: number;          // default 25
  candlestickWickMax: number;           // default 25
  smcLiquiditySweep: number;            // default 25
  smcOrderBlockTest: number;            // default 20
  smcStructureBreakChoch: number;       // default 30
  volumeExhaustionMax: number;          // default 15
  stagnationProfitMax: number;          // default 15
  adverseBleedMax: number;              // default 30
  adverseBleedTriggerBars: number;      // default 6
  adverseBleedDrawdownPct: number;      // default -2.0
  trendAlignmentDiscount: number;       // default 15
  simLabBannedSidePenalty: number;      // default 35
  simLabTrapPenalty: number;            // default 25
  whaleAbsorptionPenalty: number;       // default 20
}

export const DEFAULT_DYNAMIC_VULNERABILITY_WEIGHTS: DynamicVulnerabilityWeights = {
  rsiOverextensionMax: 25,
  candlestickWickMax: 25,
  smcLiquiditySweep: 25,
  smcOrderBlockTest: 20,
  smcStructureBreakChoch: 30,
  volumeExhaustionMax: 15,
  stagnationProfitMax: 15,
  adverseBleedMax: 30,
  adverseBleedTriggerBars: 6,
  adverseBleedDrawdownPct: -2.0,
  trendAlignmentDiscount: 15,
  simLabBannedSidePenalty: 35,
  simLabTrapPenalty: 25,
  whaleAbsorptionPenalty: 20,
};

export interface HarvesterConfig {
  enabled: boolean;
  syncMode: 'SIM_LAB_SYNC' | 'LOCAL_ONLY' | 'MANUAL_LOCK';
  harvestScoreThreshold: number;
  runnerScoreThreshold: number;
  minHarvestPct: number;
  minHarvestUsd: number;
  accelerateBreakevenR: number;
  breakevenFeeBufferPct?: number;
  breakevenMinAtrMultiple?: number;
  executionStyle: 'PARTIAL_FIRST' | 'FULL_CLOSE_ONLY';
  bannedSide?: string;
  enableDefensiveCut?: boolean;
  dynamicWeights?: DynamicVulnerabilityWeights;
}

export interface PositionHarvesterInfo {
  id?: string;
  symbol: string;
  pnlPct: number;
  pnlUsd: number;
  netPnlPct: number;
  netPnlUsd: number;
  estFeeUsd: number;
  score: number;
  recommendation: 'HARVEST' | 'RUNNER' | 'HOLD';
  factors: string[];
  action?: string;
  entryPrice: number;
  currentPrice: number;
  takeProfit: number;
  stopLoss: number;
  dynamicTakeProfit: number;
  dynamicStopLoss: number;
  distanceToTpPct: number;
  distanceToSlPct: number;
  breakevenLocked: boolean;
  trailingActivated: boolean;
  riskRewardRatio: number;
  targetBreakevenR?: number;
  leverage?: number;
  allocatedUsd?: number;
  sizeBase?: number;
  isManual?: boolean;
}

export interface HarvestEvaluationRecord {
  id: string;
  symbol: string;
  action: 'LONG' | 'SHORT';
  harvestType: '50%_SCALE_OUT' | 'FULL_HARVEST' | 'MANUAL_HARVEST' | 'SWEEP_ALL' | 'POSITION_CLOSE';
  entryPrice: number;
  exitPrice: number;
  netPnlUsd: number;
  netPnlPct: number;
  score: number;
  factors: string[];
  timestamp: number;
  mfePostExitPct?: number;
  maePostExitPct?: number;
  marketOutcome?: 'REVERSED_AVOIDED_LOSS' | 'CONTINUED_RUNNER_CAPTURED' | 'CONTINUED_MISSED_PROFIT' | 'CHOP_STAGNANT';
  evaluatedAt?: number;
}

export interface PostHarvestAuditSummary {
  totalEvaluated: number;
  reversalsAvoidedCount: number;
  continuationsMissedCount: number;
  runnersCapturedCount: number;
  chopStagnantCount: number;
  avgEfficiencyPct: number;
  aiHarvesterRecommendation: string;
  evaluations: HarvestEvaluationRecord[];
}

export interface PortfolioHarvesterState {
  config: HarvesterConfig;
  status: 'ARMED' | 'MONITORING' | 'TRIGGER_READY' | 'PAUSED';
  totalNetPnlUsd: number;
  totalNetPnlPct: number;
  openPositionsCount: number;
  positions: Record<string, PositionHarvesterInfo>;
  positionsList: PositionHarvesterInfo[];
  lastHarvestAt?: number;
  audit?: PostHarvestAuditSummary;
}

export interface SimHarvesterCalibration {
  active?: boolean;
  vulnerabilityHarvestThreshold?: number; // Tailored to client equity & regime (e.g. 55-75)
  vulnerabilityRunnerThreshold?: number;  // e.g. 35-50
  minHarvestNetPnlPct?: number;          // e.g. 1.0% - 2.5%
  minHarvestNetUsd?: number;             // Minimum net $ after round-trip taker fees & gas ($0.15 for $30 acc)
  accelerateBreakevenR?: number;         // Advance SL to breakeven at 1.0R - 1.5R
  breakevenFeeBufferPct?: number;        // e.g. +0.25% fee cover buffer
  bannedSide?: string;
  recommendedStance?: string;
  dynamicWeights?: Partial<DynamicVulnerabilityWeights>;
  cryptoQuant?: {
    btcExchangeNetflow?: number;
    coinbasePremiumIndex?: number;
  };
}

const SETTINGS_FILE_PATH = path.resolve(process.cwd(), 'data/settings.json');

export class PortfolioHarvester {
  private config: HarvesterConfig = {
    enabled: true,
    syncMode: 'SIM_LAB_SYNC',
    harvestScoreThreshold: 65,
    runnerScoreThreshold: 45,
    minHarvestPct: 1.5,
    minHarvestUsd: 0.15,
    accelerateBreakevenR: 1.35,
    breakevenFeeBufferPct: 0.25,
    executionStyle: 'PARTIAL_FIRST',
  };

  private lastHarvestAt?: number;
  private lastLivePrices: Record<string, number> = {};
  private lastSlPushTime: Record<string, number> = {};
  private lastPushedSl: Record<string, number> = {};

  constructor() {
    this.loadConfig();
  }

  public getConfig(): HarvesterConfig {
    return { ...this.config };
  }

  public isManualOverride(): boolean {
    return this.config.syncMode === 'MANUAL_LOCK';
  }

  public updateConfig(newConfig: Partial<HarvesterConfig>, source: 'USER' | 'SIM_LAB' = 'USER'): boolean {
    if (source === 'SIM_LAB' && this.config.syncMode === 'MANUAL_LOCK') {
      logger.info('🛡️ [HARVESTER] Rejected Sim Lab calibration: User Manual Override is ACTIVE (MANUAL_LOCK). User manual config has absolute priority.');
      return false;
    }
    // MAINNET STABILITY INVARIANT: Sim Lab cannot disable the client bot's own Harvester engine
    const sanitized = { ...newConfig };
    if (source === 'SIM_LAB') {
      delete sanitized.enabled;
    }
    this.config = { ...this.config, ...sanitized };
    this.saveConfig();
    logger.info(
      `🌾 [HARVESTER] Config updated [Source: ${source}]: enabled=${this.config.enabled}, mode=${this.config.syncMode}, ` +
      `harvestGate=${this.config.harvestScoreThreshold}, minPct=${this.config.minHarvestPct}%, minUsd=$${this.config.minHarvestUsd}, ` +
      `accelR=${this.config.accelerateBreakevenR}R, feeBuffer=${this.config.breakevenFeeBufferPct ?? 0.25}%, style=${this.config.executionStyle}`
    );
    return true;
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(SETTINGS_FILE_PATH)) {
        const raw = fs.readFileSync(SETTINGS_FILE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.harvester) {
          this.config = { ...this.config, ...parsed.harvester };
        }
      }
    } catch (err: any) {
      logger.error(`Failed to read harvester config from settings: ${err.message}`);
    }
  }

  private saveConfig(): void {
    try {
      let data: any = {};
      if (fs.existsSync(SETTINGS_FILE_PATH)) {
        data = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf8'));
      }
      data.harvester = this.config;
      fs.mkdirSync(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (err: any) {
      logger.error(`Failed to persist harvester config: ${err.message}`);
    }
  }

  /**
   * Evaluate open positions against live prices:
   * 1. Compute dynamic SL/TP and distance to target
   * 2. Apply Dynamic Breakeven Acceleration (ratchet SL when in target R multiple or minHarvestPct)
   * 3. Apply Execution Style (PARTIAL_FIRST tight lock vs FULL_CLOSE_ONLY)
   * 4. Evaluate portfolio net profit threshold for auto-harvesting
   */
  public evaluate(livePrices: Record<string, number> = {}): PortfolioHarvesterState {
    if (livePrices && Object.keys(livePrices).length > 0) {
      this.lastLivePrices = { ...this.lastLivePrices, ...livePrices };
    }
    const openTrades = tradeExecutor.getOpenTrades();
    let totalNetPnlUsd = 0;
    const positionsMap: Record<string, PositionHarvesterInfo> = {};
    const positionsList: PositionHarvesterInfo[] = [];

    for (const trade of openTrades) {
      const currentPrice = (livePrices && livePrices[trade.symbol]) || this.lastLivePrices[trade.symbol] || trade.entryPrice;
      const isLong = trade.action === 'LONG';
      const priceDiff = isLong ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
      const pnlPct = trade.entryPrice > 0 ? (priceDiff / trade.entryPrice) * 100 * trade.leverage : 0;
      const pnlUsd = (trade.allocatedUsd * pnlPct) / 100;

      // Realized / Estimated fees: Decibel DEX taker fee 0.05% open + 0.05% close = 0.10% notional + gas
      const notionalUsd = trade.sizeBase && currentPrice > 0
        ? (trade.sizeBase * currentPrice)
        : (trade.sizeUsd || (trade.allocatedUsd * (trade.leverage || 1)));
      const estFeeUsd = Math.max(0.01, Number((notionalUsd * 0.0010).toFixed(4)));
      const netPnlUsd = Number((pnlUsd - estFeeUsd).toFixed(2));
      const netPnlPct = trade.allocatedUsd > 0 ? Number(((netPnlUsd / trade.allocatedUsd) * 100).toFixed(2)) : Number(pnlPct.toFixed(2));

      totalNetPnlUsd += netPnlUsd;

      // Calculate distance to Take-Profit and Stop-Loss
      let distanceToTpPct = 0;
      let distanceToSlPct = 0;
      if (trade.takeProfit > 0 && currentPrice > 0) {
        distanceToTpPct = isLong
          ? Math.max(0, ((trade.takeProfit - currentPrice) / currentPrice) * 100)
          : Math.max(0, ((currentPrice - trade.takeProfit) / currentPrice) * 100);
      }
      if (trade.stopLoss > 0 && currentPrice > 0) {
        distanceToSlPct = isLong
          ? Math.max(0, ((currentPrice - trade.stopLoss) / currentPrice) * 100)
          : Math.max(0, ((trade.stopLoss - currentPrice) / currentPrice) * 100);
      }

      // Initial risk distance (calculated against original hard SL, not moving ratcheted stop)
      const initialSl = trade.hardStopLoss || (isLong ? trade.entryPrice * 0.985 : trade.entryPrice * 1.015);
      const stopDistance = Math.abs(trade.entryPrice - initialSl);
      const riskRMultiple = stopDistance > 0 ? (Math.abs(currentPrice - trade.entryPrice) / stopDistance) : 0;

      // Autonomous Anti-Hunt R: Check per-pair Sim Lab directive first, fallback to Harvester config
      const pairDir = this.config.syncMode === 'SIM_LAB_SYNC' ? getSimPairDirective(trade.symbol) : null;
      const targetR = pairDir?.accelerateBreakevenR || this.config.accelerateBreakevenR || 1.35;
      const feeBufferPct = (this.config.breakevenFeeBufferPct ?? 0.25);

      // Dynamic Trailing SL: Accelerate to breakeven if profit >= targetR or pnlPct >= minHarvestPct
      let breakevenLocked = false;
      const riskRewardRatio = distanceToSlPct > 0 ? Number((distanceToTpPct / distanceToSlPct).toFixed(2)) : 1.67;

      // UNIVERSAL SL CLAMP INVARIANT:
      // A LONG Stop Loss must NEVER sit on top of or above live market price.
      // A SHORT Stop Loss must NEVER sit on top of or below live market price.
      if (isLong && trade.stopLoss > 0 && currentPrice > 0 && trade.stopLoss >= currentPrice) {
        const breakevenFloor = Number((trade.entryPrice * (1 + feeBufferPct / 100)).toFixed(4));
        const maxSafeSl = Number((currentPrice * 0.997).toFixed(4));
        const clampedSl = Math.min(maxSafeSl, Math.max(breakevenFloor, Number((trade.entryPrice * 0.985).toFixed(4))));
        logger.warn(
          `⚠️ [SL CLAMP] LONG stop loss was inverted ($${trade.stopLoss} >= market $${currentPrice.toFixed(4)}) for ${trade.symbol}! ` +
          `Clamping to safe floor $${clampedSl} (entry: $${trade.entryPrice})`
        );
        trade.stopLoss = clampedSl;
        tradeExecutor.saveTrades();
      } else if (!isLong && trade.stopLoss > 0 && currentPrice > 0 && trade.stopLoss <= currentPrice) {
        const breakevenFloor = Number((trade.entryPrice * (1 - feeBufferPct / 100)).toFixed(4));
        const minSafeSl = Number((currentPrice * 1.003).toFixed(4));
        const clampedSl = Math.max(minSafeSl, Math.min(breakevenFloor, Number((trade.entryPrice * 1.015).toFixed(4))));
        logger.warn(
          `⚠️ [SL CLAMP] SHORT stop loss was inverted ($${trade.stopLoss} <= market $${currentPrice.toFixed(4)}) for ${trade.symbol}! ` +
          `Clamping to safe ceiling $${clampedSl} (entry: $${trade.entryPrice})`
        );
        trade.stopLoss = clampedSl;
        tradeExecutor.saveTrades();
      }

      // Dynamic Trailing SL: Accelerate to breakeven only when price achieves confirmed statistical breakaway
      // beyond the entry order-flow retest zone (calibrated dynamically by Sim Lab ATR multiple, e.g. 2.0x-2.5x ATR, and target R)
      const minAtrMultiple = this.config.breakevenMinAtrMultiple || 2.0;
      const priceDistance = Math.abs(currentPrice - trade.entryPrice);
      const isBreakawayConfirmed = (trade.atr && trade.atr > 0)
        ? priceDistance >= (minAtrMultiple * trade.atr)
        : riskRMultiple >= Math.max(targetR, 1.25);

      if (this.config.enabled && isBreakawayConfirmed && (riskRMultiple >= targetR || pnlPct >= (this.config.minHarvestPct || 1.5))) {
        const feeBuffer = feeBufferPct / 100;
        const breakevenFloor = Number((isLong
          ? trade.entryPrice * (1 + feeBuffer)
          : trade.entryPrice * (1 - feeBuffer)).toFixed(4));

        if (isLong && trade.stopLoss < breakevenFloor - 0.0001 && breakevenFloor < currentPrice) {
          trade.stopLoss = breakevenFloor;
          trade.softRatchetPrice = breakevenFloor;
          breakevenLocked = true;
          tradeExecutor.saveTrades();
          logger.info(`🛡️ [DYNAMIC SL RATCHET] ${trade.symbol} LONG stop loss locked at breakeven ($${trade.stopLoss}) [${riskRMultiple.toFixed(2)}R vs target ${targetR}R / +${pnlPct.toFixed(2)}%] (Mode: ${this.config.syncMode}${pairDir?.accelerateBreakevenR ? ' - Pair Autonomous R' : ''})`);
          this.pushStopLossOnChain(trade);
        } else if (!isLong && (trade.stopLoss === 0 || trade.stopLoss > breakevenFloor + 0.0001) && breakevenFloor > currentPrice) {
          trade.stopLoss = breakevenFloor;
          trade.softRatchetPrice = breakevenFloor;
          breakevenLocked = true;
          tradeExecutor.saveTrades();
          logger.info(`🛡️ [DYNAMIC SL RATCHET] ${trade.symbol} SHORT stop loss locked at breakeven ($${trade.stopLoss}) [${riskRMultiple.toFixed(2)}R vs target ${targetR}R / +${pnlPct.toFixed(2)}%] (Mode: ${this.config.syncMode}${pairDir?.accelerateBreakevenR ? ' - Pair Autonomous R' : ''})`);
          this.pushStopLossOnChain(trade);
        } else if (isLong ? trade.stopLoss >= breakevenFloor - 0.0001 : trade.stopLoss <= breakevenFloor + 0.0001) {
          breakevenLocked = true;
        }
      }

      // Execution Style Enforcement:
      const shouldHarvest = this.config.enabled &&
        pnlPct >= (this.config.minHarvestPct || 1.5) &&
        pnlUsd >= ((this.config.minHarvestUsd || 0.15) / Math.max(1, openTrades.length));

      if (shouldHarvest) {
        if (this.config.executionStyle === 'FULL_CLOSE_ONLY') {
          const symKey = trade.symbol.replace('-', '/').toUpperCase();
          tradeExecutor.markExecutionInFlight(symKey);
          trade.status = 'closed_tp';
          trade.exitPrice = currentPrice;
          trade.closedAt = Date.now();
          trade.exitReason = 'PORTFOLIO_HARVEST';
          trade.pnlPct = Number(pnlPct.toFixed(2));
          trade.pnlUsd = Number(pnlUsd.toFixed(2));

          if (!trade.lifecycleEvents) trade.lifecycleEvents = [];
          trade.lifecycleEvents.push({
            timestamp: trade.closedAt,
            stage: 'HARVEST',
            title: `🌾 Full Profit Harvest Executed @ $${currentPrice.toFixed(4)}`,
            description: `Portfolio Harvester banked +$${pnlUsd.toFixed(2)} (+${pnlPct.toFixed(2)}%) to lock in realized gains.`,
            price: currentPrice,
            pnlUsd: pnlUsd,
            details: [
              `Target profit threshold reached (+${pnlPct.toFixed(2)}%).`,
              `Execution style: FULL_CLOSE_ONLY.`,
              `Net PnL banked: +$${pnlUsd.toFixed(2)}.`
            ]
          });
          trade.exitSummary = `Portfolio Profit Harvester banked +${pnlPct.toFixed(2)}% (+$${pnlUsd.toFixed(2)}) as market conditions met harvest criteria.`;

          tradeExecutor.saveTrades();
          if (!trade.isPaper) {
            mcpClient.closePosition(trade.symbol).catch((err: any) => {
              logger.warn(`Could not close on-chain position for ${trade.symbol} during harvest: ${err.message}`);
            }).finally(() => {
              setTimeout(() => tradeExecutor.clearExecutionInFlight(symKey), 8000);
            });
          } else {
            setTimeout(() => tradeExecutor.clearExecutionInFlight(symKey), 1000);
          }
          logger.info(`🌾 [PROFIT HARVEST: FULL CLOSE] ${trade.symbol} banked at +${pnlPct.toFixed(2)}% (+$${pnlUsd.toFixed(2)} USD). Mode: ${this.config.syncMode}`);
          tradeExecutor.notifyTradeClosed(trade);
        } else {
          // PARTIAL_FIRST / Trailing tight profit lock: ratchet stop loss to lock in 80% of gains
          // INVARIANT GUARD: Stop Loss can NEVER be on top of or past live market price!
          const maxLongSl = Number((currentPrice * 0.997).toFixed(4));
          const minShortSl = Number((currentPrice * 1.003).toFixed(4));

          const rawLockedFloor = isLong
            ? trade.entryPrice + (currentPrice - trade.entryPrice) * 0.8
            : trade.entryPrice - (trade.entryPrice - currentPrice) * 0.8;

          const lockedProfitFloor = Number((isLong
            ? Math.min(maxLongSl, rawLockedFloor)
            : Math.max(minShortSl, rawLockedFloor)).toFixed(4));

          if (isLong && trade.stopLoss < lockedProfitFloor - 0.0001 && lockedProfitFloor < currentPrice) {
            trade.stopLoss = lockedProfitFloor;
            trade.softRatchetPrice = lockedProfitFloor;
            breakevenLocked = true;
            tradeExecutor.saveTrades();
            logger.info(`🌾 [PROFIT HARVEST: TIGHT TRAIL] ${trade.symbol} LONG trailing stop ratcheted to lock 80% gain ($${trade.stopLoss}) | PnL: +${pnlPct.toFixed(2)}%`);
            this.pushStopLossOnChain(trade);
          } else if (!isLong && (trade.stopLoss === 0 || trade.stopLoss > lockedProfitFloor + 0.0001) && lockedProfitFloor > currentPrice) {
            trade.stopLoss = lockedProfitFloor;
            trade.softRatchetPrice = lockedProfitFloor;
            breakevenLocked = true;
            tradeExecutor.saveTrades();
            logger.info(`🌾 [PROFIT HARVEST: TIGHT TRAIL] ${trade.symbol} SHORT trailing stop ratcheted to lock 80% gain ($${trade.stopLoss}) | PnL: +${pnlPct.toFixed(2)}%`);
            this.pushStopLossOnChain(trade);
          }
        }
      }

      // Calculate real-time vulnerability score (0-100) using autonomous dynamic weights
      const weights = this.config.dynamicWeights || DEFAULT_DYNAMIC_VULNERABILITY_WEIGHTS;
      let score = 35;
      const factors: string[] = [];

      if (pnlUsd < 0) {
        score += 20;
        factors.push('In initial drawdown');
      } else {
        factors.push('🟢 Net green');
      }

      if (breakevenLocked) {
        score -= 10;
        factors.push('🛡️ Breakeven SL active');
      } else {
        factors.push('Initial SL active');
      }

      if (riskRMultiple >= targetR) {
        score += 25;
        factors.push(`R-Multiple reached (${riskRMultiple.toFixed(2)}R vs ${targetR}R)`);
      }

      if (pnlPct >= (this.config.minHarvestPct || 1.5)) {
        score += 25;
        factors.push(`Target ROI reached (+${pnlPct.toFixed(1)}%)`);
      }

      if (distanceToSlPct > 0 && distanceToSlPct < 1.0) {
        score += 15;
        factors.push('Close to Stop Loss');
      }

      // ── Sim Lab Macro Intelligence: Banned Directional Side ─────────────────
      const macroBanned = this.config.bannedSide || (pairDir as any)?.bannedSide;
      if (macroBanned && macroBanned !== 'NONE' && (trade.action === macroBanned || macroBanned === 'BOTH')) {
        score += weights.simLabBannedSidePenalty;
        factors.push(`⚠️ Macro Banned Side (${trade.action}): Counter-trend headwind from Sim Lab (+${weights.simLabBannedSidePenalty}pts)`);
      }

      // ── 1-Hour Higher-Timeframe Trend Alignment Shield ───────────────────────
      let trend1h = (trade as any).trend1h;
      if (!trend1h) {
        try {
          const { standaloneEngine } = require('../engine/standalone-engine');
          const dirs = standaloneEngine.getDirectives();
          if (dirs.regime === 'TRENDING_BULL') trend1h = 'BULLISH_1H_TREND';
          else if (dirs.regime === 'TRENDING_BEAR') trend1h = 'BEARISH_1H_TREND';
        } catch { }
      }
      if (trend1h) {
        const isTrendAligned = (isLong && trend1h === 'BULLISH_1H_TREND') || (!isLong && trend1h === 'BEARISH_1H_TREND');
        const isTrendOpposed = (isLong && trend1h === 'BEARISH_1H_TREND') || (!isLong && trend1h === 'BULLISH_1H_TREND');
        if (isTrendAligned && pnlUsd > 0) {
          score = Math.max(10, score - weights.trendAlignmentDiscount);
          factors.push(`🛡️ 1h Trend Shield Aligned (${trend1h}): Protecting runner (-${weights.trendAlignmentDiscount}pts)`);
        } else if (isTrendOpposed) {
          const opposingPenalty = 25;
          score += opposingPenalty;
          factors.push(`⚠️ 1h Trend Opposed (${trend1h}): Fighting higher-timeframe trend (+${opposingPenalty}pts)`);
        }
      }

      // ── Adverse Bleed / Time Decay on underwater positions ────────────────────
      if (pnlPct <= weights.adverseBleedDrawdownPct && !breakevenLocked) {
        score += weights.adverseBleedMax;
        factors.push(`🩸 Adverse Bleed Decay: Drawdown ${pnlPct.toFixed(1)}% without breakeven (+${weights.adverseBleedMax}pts)`);
      }

      score = Math.min(95, Math.max(15, Math.round(score)));

      let recommendation: 'HARVEST' | 'RUNNER' | 'HOLD' = 'HOLD';
      if (score >= (this.config.harvestScoreThreshold || 65) && pnlUsd > 0) {
        recommendation = 'HARVEST';
      } else if (score < (this.config.runnerScoreThreshold || 45) && breakevenLocked) {
        recommendation = 'RUNNER';
      }

      // ── Defensive Bleed Cutting (Saves capital from slow bleed positions) ──────
      // Calibrated to 15% margin loss (matching the Dual-Layer Hard Stop Loss armor).
      // Never prematurely close trades protected by on-chain Hard SL or manual on-chain trades.
      const isManual = Boolean(trade.notes?.includes('Manual') || trade.strategyName?.includes('Manual'));
      const hasOnChainArmor = Boolean((trade.hardStopLoss && trade.hardStopLoss > 0) || isManual || trade.strategyName?.includes('On-Chain'));
      const isBleedingOut = !hasOnChainArmor && pnlPct <= -15.0 && score >= (this.config.harvestScoreThreshold || 75) && !breakevenLocked;
      if (isBleedingOut && this.config.enableDefensiveCut !== false) {
        recommendation = 'HARVEST';
        factors.push('🩸 DEFENSIVE BLEED CUT: Heavy drawdown past threshold (-15% margin), exiting to protect capital');
        if (this.config.enabled && !trade.isPaper) {
          const symKey = trade.symbol.replace('-', '/').toUpperCase();
          tradeExecutor.markExecutionInFlight(symKey);
          trade.status = 'closed_sl';
          trade.exitPrice = currentPrice;
          trade.closedAt = Date.now();
          trade.exitReason = 'DEFENSIVE_BLEED_CUT';
          trade.pnlPct = Number(pnlPct.toFixed(2));
          trade.pnlUsd = Number(pnlUsd.toFixed(2));

          if (!trade.lifecycleEvents) trade.lifecycleEvents = [];
          trade.lifecycleEvents.push({
            timestamp: trade.closedAt,
            stage: 'EXIT',
            title: `🩸 Defensive Bleed Cut @ $${currentPrice.toFixed(4)}`,
            description: `Liberated capital before max SL hit. Drawdown capped at ${pnlPct.toFixed(2)}%.`,
            price: currentPrice,
            pnlUsd: pnlUsd,
            details: [
              `Vulnerability score high (${score}/100).`,
              `Adverse bleed detected. Exited on-chain to protect capital.`
            ]
          });
          trade.exitSummary = `Defensive bleed cut executed to stop capital hemorrhage before hitting full hard stop loss. Capital liberated.`;

          tradeExecutor.saveTrades();
          mcpClient.closePosition(trade.symbol).catch((err: any) => {
            logger.warn(`Could not close on-chain position for ${trade.symbol} during defensive bleed cut: ${err.message}`);
          }).finally(() => {
            setTimeout(() => tradeExecutor.clearExecutionInFlight(symKey), 8000);
          });
          logger.warn(`🩸 [DEFENSIVE BLEED CUT] ${trade.symbol} exited at ${pnlPct.toFixed(2)}% to stop capital hemorrhage.`);
          tradeExecutor.notifyTradeClosed(trade);
        }
      }

      if (factors.length === 0) {
        factors.push('Order book liquidity healthy', 'Risk within limits');
      }

      const posInfo: PositionHarvesterInfo = {
        id: trade.id,
        symbol: trade.symbol,
        action: trade.action,
        leverage: trade.leverage || 1,
        allocatedUsd: trade.allocatedUsd || 10,
        sizeBase: trade.sizeBase || 0,
        isManual: Boolean(trade.notes?.includes('Manual') || trade.strategyName?.includes('Manual')),
        pnlPct: Number(pnlPct.toFixed(2)),
        pnlUsd: Number(pnlUsd.toFixed(2)),
        netPnlPct,
        netPnlUsd,
        estFeeUsd,
        score,
        recommendation,
        factors,
        entryPrice: trade.entryPrice,
        currentPrice: currentPrice,
        takeProfit: trade.takeProfit,
        stopLoss: trade.stopLoss,
        dynamicTakeProfit: trade.takeProfit,
        dynamicStopLoss: trade.stopLoss,
        distanceToTpPct: Number(distanceToTpPct.toFixed(2)),
        distanceToSlPct: Number(distanceToSlPct.toFixed(2)),
        breakevenLocked,
        trailingActivated: breakevenLocked,
        riskRewardRatio,
        targetBreakevenR: targetR,
      };

      positionsMap[trade.symbol] = posInfo;
      positionsMap[trade.symbol.replace('-', '/').toUpperCase()] = posInfo;
      if (trade.id) positionsMap[trade.id] = posInfo;
      positionsList.push(posInfo);
    }

    // Determine Harvester status
    let status: PortfolioHarvesterState['status'] = 'ARMED';
    if (!this.config.enabled) {
      status = 'PAUSED';
    } else if (totalNetPnlUsd > (this.config.minHarvestUsd || 0.15) && openTrades.length > 0) {
      status = 'TRIGGER_READY';
    } else if (openTrades.length > 0) {
      status = 'MONITORING';
    } else {
      status = 'ARMED';
    }

    const audit = this.auditPostHarvestExits(livePrices);

    return {
      config: this.config,
      status,
      totalNetPnlUsd: Number(totalNetPnlUsd.toFixed(2)),
      totalNetPnlPct: openTrades.length > 0 ? Number((totalNetPnlUsd / Math.max(1, openTrades.length * 20) * 100).toFixed(2)) : 0,
      openPositionsCount: openTrades.length,
      positions: positionsMap,
      positionsList,
      lastHarvestAt: this.lastHarvestAt,
      audit,
    };
  }

  private loadHarvestEvaluations(): HarvestEvaluationRecord[] {
    try {
      const EVALUATIONS_FILE_PATH = path.resolve(process.cwd(), 'data/harvest-evaluations.json');
      if (fs.existsSync(EVALUATIONS_FILE_PATH)) {
        const raw = fs.readFileSync(EVALUATIONS_FILE_PATH, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err: any) {
      logger.error(`❌ [HARVEST EVAL] Failed to load evaluations: ${err.message}`);
    }
    return [];
  }

  private saveHarvestEvaluations(records: HarvestEvaluationRecord[]): void {
    try {
      const EVALUATIONS_FILE_PATH = path.resolve(process.cwd(), 'data/harvest-evaluations.json');
      fs.mkdirSync(path.dirname(EVALUATIONS_FILE_PATH), { recursive: true });
      fs.writeFileSync(EVALUATIONS_FILE_PATH, JSON.stringify(records.slice(-200), null, 2), 'utf-8');
    } catch (err: any) {
      logger.error(`❌ [HARVEST EVAL] Failed to save evaluations: ${err.message}`);
    }
  }

  public recordHarvestEvaluation(
    record: Omit<HarvestEvaluationRecord, 'id'> & { id?: string }
  ): HarvestEvaluationRecord {
    const evaluations = this.loadHarvestEvaluations();
    const newRecord: HarvestEvaluationRecord = {
      id: record.id || `heval-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ...record,
      timestamp: record.timestamp || Date.now(),
      evaluatedAt: Date.now(),
    };
    evaluations.push(newRecord);
    this.saveHarvestEvaluations(evaluations);
    logger.info(
      `📝 [HARVEST EVAL RECORD] Recorded exit evaluation for ${newRecord.symbol} (${newRecord.harvestType}) at $${newRecord.exitPrice}. ` +
      `Net P&L: +$${newRecord.netPnlUsd.toFixed(2)} (${newRecord.netPnlPct}%). Score: ${newRecord.score}`
    );
    return newRecord;
  }

  public auditPostHarvestExits(livePrices: Record<string, number> = {}): PostHarvestAuditSummary {
    const evaluations = this.loadHarvestEvaluations();
    let changed = false;

    // Auto-ingest any closed trades from tradeExecutor into evaluations
    try {
      const closedTrades = tradeExecutor.getClosedTrades();
      for (const ct of closedTrades) {
        const exists = evaluations.some((e) => e.id === ct.id || (e.symbol === ct.symbol && Math.abs(e.timestamp - (ct.closedAt || ct.openedAt)) < 5000));
        if (!exists && ct.exitPrice && ct.exitPrice > 0) {
          evaluations.push({
            id: ct.id,
            symbol: ct.symbol,
            action: ct.action,
            harvestType: ct.exitReason?.includes('HARVEST') ? 'FULL_HARVEST' : (ct.tp1Hit ? '50%_SCALE_OUT' : 'POSITION_CLOSE'),
            entryPrice: ct.entryPrice,
            exitPrice: ct.exitPrice,
            netPnlUsd: ct.pnlUsd || 0,
            netPnlPct: ct.pnlPct || 0,
            score: ct.confidence || 75,
            factors: [ct.exitReason || ct.status || 'CLOSED'],
            timestamp: ct.closedAt || Date.now(),
            evaluatedAt: Date.now(),
          });
          changed = true;
        }
      }
    } catch {}

    let reversalsAvoided = 0;
    let continuationsMissed = 0;
    let runnersCaptured = 0;
    let chopStagnant = 0;
    const now = Date.now();

    for (const rec of evaluations) {
      const currentPrice = livePrices[rec.symbol] || livePrices[rec.symbol.replace('-', '/')] || this.lastLivePrices[rec.symbol] || rec.exitPrice;
      if (!currentPrice || rec.exitPrice <= 0) {
        if (rec.marketOutcome === 'REVERSED_AVOIDED_LOSS') reversalsAvoided++;
        else if (rec.marketOutcome === 'CONTINUED_MISSED_PROFIT') continuationsMissed++;
        else if (rec.marketOutcome === 'CONTINUED_RUNNER_CAPTURED') runnersCaptured++;
        else if (rec.marketOutcome === 'CHOP_STAGNANT') chopStagnant++;
        continue;
      }

      const isLong = rec.action === 'LONG';
      const postExitMovePct = isLong
        ? ((currentPrice - rec.exitPrice) / rec.exitPrice) * 100
        : ((rec.exitPrice - currentPrice) / rec.exitPrice) * 100;

      const pullbackToEntryPct = isLong
        ? ((rec.entryPrice - currentPrice) / rec.entryPrice) * 100
        : ((currentPrice - rec.entryPrice) / rec.entryPrice) * 100;

      if (rec.mfePostExitPct === undefined || postExitMovePct > rec.mfePostExitPct) {
        rec.mfePostExitPct = Number(postExitMovePct.toFixed(2));
        changed = true;
      }
      if (rec.maePostExitPct === undefined || -postExitMovePct > rec.maePostExitPct) {
        rec.maePostExitPct = Number((-postExitMovePct).toFixed(2));
        changed = true;
      }

      if (pullbackToEntryPct >= 0 || postExitMovePct <= -1.0) {
        rec.marketOutcome = 'REVERSED_AVOIDED_LOSS';
        reversalsAvoided++;
      } else if (postExitMovePct >= 1.5) {
        if (rec.harvestType === '50%_SCALE_OUT') {
          rec.marketOutcome = 'CONTINUED_RUNNER_CAPTURED';
          runnersCaptured++;
        } else {
          rec.marketOutcome = 'CONTINUED_MISSED_PROFIT';
          continuationsMissed++;
        }
      } else {
        rec.marketOutcome = 'CHOP_STAGNANT';
        chopStagnant++;
      }
      rec.evaluatedAt = now;
      changed = true;
    }

    if (changed) {
      this.saveHarvestEvaluations(evaluations);
    }

    const total = evaluations.length;
    const efficientExits = reversalsAvoided + runnersCaptured + chopStagnant;
    const avgEfficiencyPct = total > 0 ? Number(((efficientExits / total) * 100).toFixed(1)) : 100;

    let recommendation = 'Harvest system operating in balance. Banked profits safely while maintaining runner participation.';
    if (reversalsAvoided > continuationsMissed * 2 && reversalsAvoided > 0) {
      recommendation = `🎯 HIGH DEFENSIVE VALUE: Harvest exits prevented giving back profits in ${reversalsAvoided} trades that subsequently reversed. Keep current thresholds.`;
    } else if (continuationsMissed > reversalsAvoided && continuationsMissed >= 2) {
      recommendation = `💡 PROFIT RUNAWAY DETECTED: Market continued in favorable direction on ${continuationsMissed} full exits. Recommend switching Execution Style to '50% Scale-Out' to capture runners.`;
    }

    return {
      totalEvaluated: total,
      reversalsAvoidedCount: reversalsAvoided,
      continuationsMissedCount: continuationsMissed,
      runnersCapturedCount: runnersCaptured,
      chopStagnantCount: chopStagnant,
      avgEfficiencyPct,
      aiHarvesterRecommendation: recommendation,
      evaluations: evaluations.slice(-20).reverse(),
    };
  }

  /**
   * Execute profit harvest:
   * - HARVEST_NOW: Closes a specific position in green
   * - SWEEP_ALL: Closes all positions with positive PnL
   */
  public executeHarvest(action: 'HARVEST_NOW' | 'SWEEP_ALL', targetSymbol?: string): { success: boolean; closedCount: number; harvestedUsd: number; message: string } {
    const openTrades = tradeExecutor.getOpenTrades();
    let closedCount = 0;
    let harvestedUsd = 0;

    for (const trade of openTrades) {
      const isTarget = action === 'SWEEP_ALL' ? (trade.pnlUsd || 0) > 0 : trade.symbol === targetSymbol;
      if (isTarget) {
        const symKey = trade.symbol.replace('-', '/').toUpperCase();
        const exitPriceVal = this.lastLivePrices[trade.symbol] || trade.entryPrice;
        tradeExecutor.markExecutionInFlight(symKey);
        trade.status = 'closed_tp';
        trade.exitPrice = exitPriceVal;
        trade.closedAt = Date.now();
        trade.exitReason = action === 'SWEEP_ALL' ? 'SWEEP_ALL_PROFIT' : 'MANUAL_HARVEST';
        harvestedUsd += (trade.pnlUsd || 0);
        closedCount++;

        if (!trade.lifecycleEvents) trade.lifecycleEvents = [];
        trade.lifecycleEvents.push({
          timestamp: trade.closedAt,
          stage: 'HARVEST',
          title: `🌾 ${action === 'SWEEP_ALL' ? 'Basket Profit Sweep' : 'Manual Harvest'} @ $${exitPriceVal.toFixed(4)}`,
          description: `Banked +$${(trade.pnlUsd || 0).toFixed(2)} realized profit via Harvester command.`,
          price: exitPriceVal,
          pnlUsd: trade.pnlUsd,
          details: [
            `Operator / algorithmic harvest trigger: ${action}.`,
            `On-chain market close dispatched to Decibel DEX.`,
            `Net profit banked: +$${(trade.pnlUsd || 0).toFixed(2)}.`
          ]
        });
        trade.exitSummary = `${action === 'SWEEP_ALL' ? 'All profitable positions closed simultaneously' : 'Manual operator harvest'} banking +$${(trade.pnlUsd || 0).toFixed(2)} in net profit.`;

        if (!trade.isPaper) {
          mcpClient.closePosition(trade.symbol).catch((err: any) => {
            logger.warn(`Could not close on-chain position for ${trade.symbol} during manual harvest: ${err.message}`);
          }).finally(() => {
            setTimeout(() => tradeExecutor.clearExecutionInFlight(symKey), 8000);
          });
        } else {
          setTimeout(() => tradeExecutor.clearExecutionInFlight(symKey), 1000);
        }
      }
    }

    if (closedCount > 0) {
      this.lastHarvestAt = Date.now();
      tradeExecutor.saveTrades();
      logger.info(`🌾 [HARVEST EXECUTED] Closed ${closedCount} positions. Banked profit: +$${harvestedUsd.toFixed(2)} USD.`);
      for (const trade of openTrades) {
        const isTarget = action === 'SWEEP_ALL' ? (trade.pnlUsd || 0) > 0 : trade.symbol === targetSymbol;
        if (isTarget) {
          tradeExecutor.notifyTradeClosed(trade);
        }
      }
      return {
        success: true,
        closedCount,
        harvestedUsd: Number(harvestedUsd.toFixed(2)),
        message: `Successfully harvested ${closedCount} position(s), banking +$${harvestedUsd.toFixed(2)} profit!`,
      };
    }

    return {
      success: false,
      closedCount: 0,
      harvestedUsd: 0,
      message: action === 'SWEEP_ALL' ? 'No open positions currently in net profit.' : `Position ${targetSymbol} not found or not in profit.`,
    };
  }

  private pushStopLossOnChain(trade: TradeRecord): void {
    if (trade.isPaper) return;
    const now = Date.now();
    const sym = trade.symbol;
    const lastTime = this.lastSlPushTime[sym] || 0;
    const lastSl = this.lastPushedSl[sym] || 0;

    // Minimum 10 seconds between pushes to avoid tx queue spam & sequence number conflicts
    if (now - lastTime < 10000) return;

    // Minimum meaningful price change (0.05%)
    if (lastSl > 0 && Math.abs(trade.stopLoss - lastSl) / lastSl < 0.0005) return;

    this.lastSlPushTime[sym] = now;
    this.lastPushedSl[sym] = trade.stopLoss;

    mcpClient.setTpSl({
      symbol: trade.symbol,
      slTrigger: trade.stopLoss,
      tpTrigger: trade.takeProfit > 0 ? trade.takeProfit : undefined,
    }).then(() => {
      logger.info(`🔗 [ON-CHAIN SL SYNC] Successfully pushed ratcheted SL ($${trade.stopLoss}) to Decibel for ${trade.symbol}`);
    }).catch((err: any) => {
      logger.warn(`⚠️ [ON-CHAIN SL SYNC] Failed to push ratcheted SL to Decibel for ${trade.symbol}: ${err.message}`);
    });
  }
}

export const portfolioHarvester = new PortfolioHarvester();

/**
 * Applies dynamic harvester calibration from central Sim Lab Alpha Server.
 * Enforces live safety clamping:
 * - vulnerabilityThreshold: [50, 85]
 * - minHarvestRoiPct: [0.8, 5.0]%
 * - minHarvestProfitUsd: minimum net $ after round-trip taker fees & gas
 * - accelerateBreakevenR: advance SL to breakeven at 1.0R - 1.5R
 * - breakevenFeeBufferPct: fee cover buffer
 */
export function applySimHarvesterCalibration(cal: SimHarvesterCalibration): boolean {
  if (!cal || typeof cal !== 'object') return false;
  if (portfolioHarvester.isManualOverride()) {
    logger.info('🛡️ [HARVESTER] Rejected Sim Lab calibration: User Manual Override is ACTIVE (MANUAL_LOCK).');
    return false;
  }

  const vulnerabilityThreshold = typeof cal.vulnerabilityHarvestThreshold === 'number'
    ? Math.min(85, Math.max(50, cal.vulnerabilityHarvestThreshold))
    : 65;
  const vulnerabilityRunnerThreshold = typeof cal.vulnerabilityRunnerThreshold === 'number'
    ? Math.min(60, Math.max(20, cal.vulnerabilityRunnerThreshold))
    : 45;
  const minHarvestRoiPct = typeof cal.minHarvestNetPnlPct === 'number'
    ? Math.min(5.0, Math.max(0.8, cal.minHarvestNetPnlPct))
    : 1.5;
  const minHarvestProfitUsd = typeof cal.minHarvestNetUsd === 'number' ? cal.minHarvestNetUsd : 0.15;
  // Anti-hunt protection: Ensure accelerateBreakevenR is at least 1.25R (defaults to 1.35R) to avoid wick hunts
  const accelerateBreakevenR = typeof cal.accelerateBreakevenR === 'number'
    ? Math.max(1.20, cal.accelerateBreakevenR)
    : 1.35;
  const breakevenFeeBufferPct = typeof cal.breakevenFeeBufferPct === 'number' ? cal.breakevenFeeBufferPct : 0.25;
  const breakevenMinAtrMultiple = typeof (cal as any).breakevenMinAtrMultiple === 'number'
    ? Math.max(1.5, (cal as any).breakevenMinAtrMultiple)
    : 2.0;

  return portfolioHarvester.updateConfig({
    harvestScoreThreshold: vulnerabilityThreshold,
    runnerScoreThreshold: vulnerabilityRunnerThreshold,
    minHarvestPct: minHarvestRoiPct,
    minHarvestUsd: minHarvestProfitUsd,
    accelerateBreakevenR,
    breakevenFeeBufferPct,
    breakevenMinAtrMultiple,
  }, 'SIM_LAB');
}
