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
  structureBreakCutEnabled?: boolean;
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
  enableDefensiveCut?: boolean;
  structureBreakCutEnabled?: boolean;
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
    accelerateBreakevenR: 1.75,
    breakevenFeeBufferPct: 0.75,
    breakevenMinAtrMultiple: 2.0,
    executionStyle: 'PARTIAL_FIRST',
    enableDefensiveCut: true,
    structureBreakCutEnabled: true,
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
      `accelR=${this.config.accelerateBreakevenR}R, feeBuffer=${this.config.breakevenFeeBufferPct ?? 0.75}%, style=${this.config.executionStyle}`
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
      for (const [k, v] of Object.entries(livePrices)) {
        if (v && v > 0) {
          this.lastLivePrices[k] = v;
          if (k.includes('-')) this.lastLivePrices[k.replace('-', '/')] = v;
          if (k.includes('/')) this.lastLivePrices[k.replace('/', '-')] = v;
        }
      }
    }
    const openTrades = tradeExecutor.getOpenTrades();
    let totalNetPnlUsd = 0;
    const positionsMap: Record<string, PositionHarvesterInfo> = {};
    const positionsList: PositionHarvesterInfo[] = [];

    for (const trade of openTrades) {
      const sym = trade.symbol;
      const symSlash = sym.replace('-', '/');
      const symDash = sym.replace('/', '-');
      const currentPrice = (livePrices && (livePrices[sym] || livePrices[symSlash] || livePrices[symDash]))
        || this.lastLivePrices[sym]
        || this.lastLivePrices[symSlash]
        || this.lastLivePrices[symDash]
        || (trade.currentPrice && trade.currentPrice > 0 ? trade.currentPrice : 0);

      if (!currentPrice || currentPrice <= 0) {
        continue;
      }
      const isLong = trade.action === 'LONG';
      const priceDiff = isLong ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
      const pnlPct = trade.entryPrice > 0 ? (priceDiff / trade.entryPrice) * 100 * trade.leverage : 0;
      const pnlUsd = (trade.allocatedUsd * pnlPct) / 100;

      // Realized / Estimated fees: Decibel DEX taker fee 0.05% open + 0.05% close = 0.10% notional + gas (0.05% if maker on entry)
      const notionalUsd = trade.sizeBase && currentPrice > 0
        ? (trade.sizeBase * currentPrice)
        : (trade.sizeUsd || (trade.allocatedUsd * (trade.leverage || 1)));
      const feeRate = (trade as any).isMaker ? 0.0005 : 0.0010;
      const estFeeUsd = Math.max(0.01, Number((notionalUsd * feeRate).toFixed(4)));
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
      const feeBufferPct = (this.config.breakevenFeeBufferPct ?? 0.75);

      // Dynamic Trailing SL: Accelerate to breakeven if profit >= targetR or pnlPct >= minHarvestPct
      let breakevenLocked = false;
      const riskRewardRatio = distanceToSlPct > 0 ? Number((distanceToTpPct / distanceToSlPct).toFixed(2)) : 1.67;

      // TRAILING / BREAKEVEN STOP LOSS HIT TRIGGER:
      // If a trade already locked in breakeven or trailing profit and live price touches the ratchet:
      const isTrailingOrBeHit = isLong
        ? (trade.stopLoss > 0 && currentPrice > 0 && currentPrice <= trade.stopLoss && (trade.breakevenMoved || trade.stopLoss >= trade.entryPrice))
        : (trade.stopLoss > 0 && currentPrice > 0 && currentPrice >= trade.stopLoss && (trade.breakevenMoved || trade.stopLoss <= trade.entryPrice));

      if (isTrailingOrBeHit) {
        logger.info(`🌾 [TRAILING / BREAKEVEN HIT] ${trade.symbol} ${trade.action} price ($${currentPrice}) touched soft ratchet ($${trade.stopLoss})! Securing profit/breakeven exit...`);
        const symKey = trade.symbol.replace('-', '/').toUpperCase();
        tradeExecutor.markExecutionInFlight(symKey);
        const priceDiff = isLong ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
        const estPnlUsd = (trade.allocatedUsd * ((priceDiff / trade.entryPrice) * trade.leverage));
        const isActuallyProfitable = estPnlUsd > 0.05;
        const isBreakeven = estPnlUsd >= 0;
        trade.status = (isActuallyProfitable || isBreakeven) ? 'closed_tp' : 'closed_sl';
        trade.exitPrice = currentPrice;
        trade.exitReason = isActuallyProfitable ? 'TRAILING_TP' : (isBreakeven ? 'BREAKEVEN' : 'STOP_LOSS');
        trade.closedAt = Date.now();
        tradeExecutor.saveTrades();
        if (!trade.isPaper) {
          mcpClient.closePosition(trade.symbol).catch((err: any) => {
            logger.warn(`Could not close on-chain position for ${trade.symbol} during trailing exit: ${err.message}`);
          }).finally(() => {
            setTimeout(() => tradeExecutor.clearExecutionInFlight(symKey), 8000);
          });
        }
        tradeExecutor.notifyTradeClosed(trade);
        continue;
      }

      // INITIAL SOFT STOP LOSS HIT TRIGGER (pre-breakeven):
      // If live market price touches or breaches the structural stop loss, execute defensive market close.
      const tradeAgeMs = Date.now() - (trade.openedAt || 0);
      const isPastSlGrace = tradeAgeMs >= 5_000;

      const isInitialSlHit = isPastSlGrace && (isLong
        ? (trade.stopLoss > 0 && currentPrice > 0 && currentPrice <= trade.stopLoss)
        : (trade.stopLoss > 0 && currentPrice > 0 && currentPrice >= trade.stopLoss));

      if (isInitialSlHit) {
        const isProfitableRatchet = pnlUsd > 0.04;
        logger.info(`🛑 [${isProfitableRatchet ? 'STRUCTURAL RATCHET EXIT' : 'SOFT SL HIT'}] ${trade.symbol} ${trade.action} price ($${currentPrice}) touched stop ($${trade.stopLoss})! PnL: $${pnlUsd.toFixed(2)}`);
        const symKey = trade.symbol.replace('-', '/').toUpperCase();
        tradeExecutor.markExecutionInFlight(symKey);
        trade.status = isProfitableRatchet ? 'closed_tp' : 'closed_sl';
        trade.exitPrice = currentPrice;
        trade.exitReason = isProfitableRatchet ? 'STRUCTURAL_RATCHET_TP' : 'SOFT_STOP_LOSS';
        trade.closedAt = Date.now();
        tradeExecutor.saveTrades();
        if (!trade.isPaper) {
          mcpClient.closePosition(trade.symbol).catch((err: any) => {
            logger.warn(`Could not close on-chain position for ${trade.symbol} during SL/ratchet exit: ${err.message}`);
          }).finally(() => {
            setTimeout(() => tradeExecutor.clearExecutionInFlight(symKey), 8000);
          });
        }
        tradeExecutor.notifyTradeClosed(trade);
        continue;
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
          trade.breakevenMoved = true;
          breakevenLocked = true;
          tradeExecutor.saveTrades();
          logger.info(`🛡️ [DYNAMIC SL RATCHET] ${trade.symbol} LONG soft stop loss locked at breakeven ($${trade.stopLoss}) [${riskRMultiple.toFixed(2)}R vs target ${targetR}R / +${pnlPct.toFixed(2)}%] (Soft SL on-system, On-Chain Hard SL remains $${trade.hardStopLoss})`);
        } else if (!isLong && (trade.stopLoss === 0 || trade.stopLoss > breakevenFloor + 0.0001) && breakevenFloor > currentPrice) {
          trade.stopLoss = breakevenFloor;
          trade.softRatchetPrice = breakevenFloor;
          trade.breakevenMoved = true;
          breakevenLocked = true;
          tradeExecutor.saveTrades();
          logger.info(`🛡️ [DYNAMIC SL RATCHET] ${trade.symbol} SHORT soft stop loss locked at breakeven ($${trade.stopLoss}) [${riskRMultiple.toFixed(2)}R vs target ${targetR}R / +${pnlPct.toFixed(2)}%] (Soft SL on-system, On-Chain Hard SL remains $${trade.hardStopLoss})`);
        } else if (isLong ? trade.stopLoss >= breakevenFloor - 0.0001 : trade.stopLoss <= breakevenFloor + 0.0001) {
          trade.breakevenMoved = true;
          breakevenLocked = true;
        }
      }

      // ── Windfall Stretcher: Dynamic Volatility Cone Expansion ────────────────
      // Only stretch TP on confirmed runaway runners that have already banked TP1 or achieved >= 8% leveraged profit.
      // Strict Guards:
      //  1. Never stretch on Dual TP trades (must respect fast exit targets).
      //  2. Clamp stretched TP to within a realistic ceiling (max 3.5% from entry price) to avoid squishing chart candles and fighting with reconciliation.
      const isScalpOrFixed = trade.isDualTp;
      if (!isScalpOrFixed && pnlPct >= 8.0 && (trade.tp1Hit || riskRMultiple >= 1.5) && pairDir) {
        const coneP95 = pairDir.dynamicProtection?.coneP95Resistance || (pairDir as any).kronosForecast?.dynamicProtection?.coneP95Resistance;
        const coneP05 = pairDir.dynamicProtection?.coneP05Support || (pairDir as any).kronosForecast?.dynamicProtection?.coneP05Support;
        const maxRealisticLongTp = Number((trade.entryPrice * 1.035).toFixed(4));
        const minRealisticShortTp = Number((trade.entryPrice * 0.965).toFixed(4));

        if (isLong && coneP95 && coneP95 > trade.takeProfit * 1.005) {
          const oldTp = trade.takeProfit;
          const candidateTp = Math.min(Number(coneP95.toFixed(4)), maxRealisticLongTp);
          if (candidateTp > trade.takeProfit * 1.002) {
            trade.takeProfit = candidateTp;
            trade.dynamicTakeProfit = candidateTp;
            tradeExecutor.saveTrades();
            logger.info(
              `🌊 [WINDFALL STRETCHER] Volatility Cone expanded for ${trade.symbol} LONG! ` +
              `Stretched Take-Profit from $${oldTp} to $${candidateTp}.`
            );
            if (!trade.isPaper) {
              const levVal = Math.max(1, trade.leverage || 1);
              const staticHardSl = trade.hardStopLoss || Number((trade.entryPrice * (1 - 0.15 / levVal)).toFixed(4));
              mcpClient.setTpSl({ symbol: trade.symbol, tpTrigger: candidateTp, slTrigger: staticHardSl }).catch(() => {});
            }
          }
        } else if (!isLong && coneP05 && coneP05 < trade.takeProfit * 0.995 && coneP05 > 0) {
          const oldTp = trade.takeProfit;
          const candidateTp = Math.max(Number(coneP05.toFixed(4)), minRealisticShortTp);
          if (candidateTp < trade.takeProfit * 0.998) {
            trade.takeProfit = candidateTp;
            trade.dynamicTakeProfit = candidateTp;
            tradeExecutor.saveTrades();
            logger.info(
              `🌊 [WINDFALL STRETCHER] Volatility Cone expanded for ${trade.symbol} SHORT! ` +
              `Stretched Take-Profit from $${oldTp} to $${candidateTp}.`
            );
            if (!trade.isPaper) {
              const levVal = Math.max(1, trade.leverage || 1);
              const staticHardSl = trade.hardStopLoss || Number((trade.entryPrice * (1 + 0.15 / levVal)).toFixed(4));
              mcpClient.setTpSl({ symbol: trade.symbol, tpTrigger: candidateTp, slTrigger: staticHardSl }).catch(() => {});
            }
          }
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
          // PARTIAL_FIRST / Trailing profit lock: dynamically driven by Sim Lab pair directives and market regime
          // Regime-aware retracement buffer ensures trades have breathing room for natural market pullbacks
          const pairDir = getSimPairDirective(trade.symbol);
          const simRegime = trade.regime || (pairDir as any)?.regime?.type;
          const isHighVol = simRegime === 'HIGH_VOLATILITY';
          const isChop = simRegime === 'RANGING_CHOP';
          const slMult = (pairDir && typeof pairDir.slMultiplier === 'number') ? pairDir.slMultiplier : 1.0;

          // Adaptive Profit Lock Ratio (leaving 40% - 50% room for trend retracement)
          const profitLockRatio = isHighVol ? 0.50 : isChop ? 0.60 : 0.55;
          // Adaptive Safe Buffer: Widened in High Vol / proportional to pair SL multiplier
          const slBufferPct = (isHighVol ? 0.012 : isChop ? 0.006 : 0.008) * slMult;

          const maxLongSl = Number((currentPrice * (1 - slBufferPct)).toFixed(4));
          const minShortSl = Number((currentPrice * (1 + slBufferPct)).toFixed(4));

          const rawLockedFloor = isLong
            ? trade.entryPrice + (currentPrice - trade.entryPrice) * profitLockRatio
            : trade.entryPrice - (trade.entryPrice - currentPrice) * profitLockRatio;

          const lockedProfitFloor = Number((isLong
            ? Math.min(maxLongSl, rawLockedFloor)
            : Math.max(minShortSl, rawLockedFloor)).toFixed(4));

          if (isLong && trade.stopLoss < lockedProfitFloor - 0.0001 && lockedProfitFloor < currentPrice) {
            trade.stopLoss = lockedProfitFloor;
            trade.softRatchetPrice = lockedProfitFloor;
            breakevenLocked = true;
            tradeExecutor.saveTrades();
            logger.info(`🌾 [PROFIT HARVEST: ADAPTIVE TRAIL] ${trade.symbol} LONG soft trailing stop ratcheted to lock ${(profitLockRatio * 100).toFixed(0)}% gain ($${trade.stopLoss}) | PnL: +${pnlPct.toFixed(2)}% | Buffer: ${(slBufferPct * 100).toFixed(2)}% (Soft SL on-system, On-Chain Hard SL remains $${trade.hardStopLoss})`);
          } else if (!isLong && (trade.stopLoss === 0 || trade.stopLoss > lockedProfitFloor + 0.0001) && lockedProfitFloor > currentPrice) {
            trade.stopLoss = lockedProfitFloor;
            trade.softRatchetPrice = lockedProfitFloor;
            breakevenLocked = true;
            tradeExecutor.saveTrades();
            logger.info(`🌾 [PROFIT HARVEST: ADAPTIVE TRAIL] ${trade.symbol} SHORT soft trailing stop ratcheted to lock ${(profitLockRatio * 100).toFixed(0)}% gain ($${trade.stopLoss}) | PnL: +${pnlPct.toFixed(2)}% | Buffer: ${(slBufferPct * 100).toFixed(2)}% (Soft SL on-system, On-Chain Hard SL remains $${trade.hardStopLoss})`);
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

      // ── Kronos Foundation Adverse Trajectory Defense ─────────────────────────
      const kf = (pairDir as any)?.kronosForecast;
      if (kf) {
        if (isLong && kf.knifeRiskScore >= 0.70) {
          score += 35;
          factors.push(`🔪 Kronos Knife Trajectory: Neural down-tail probability ${(kf.knifeRiskScore * 100).toFixed(0)}% (+35pts safe harvest)`);
        } else if (!isLong && kf.meltUpRiskScore && kf.meltUpRiskScore >= 0.70) {
          score += 35;
          factors.push(`🚀 Kronos Squeeze Trajectory: Squeeze impulse velocity ${(kf.meltUpRiskScore * 100).toFixed(0)}% (+35pts safe harvest)`);
        } else if (pnlPct > 0.8 && ((isLong && kf.predictedDirection === 'BULLISH') || (!isLong && kf.predictedDirection === 'BEARISH'))) {
          score = Math.max(10, score - 10);
          factors.push(`🛡️ Kronos Trend Aligned (${kf.predictedDirection}): Protecting runner (-10pts)`);
        }

        // Bar 5 (75m / 1.25h): Accelerated Entropy Exit if market dissolves into random walk chop
        const holdHoursEarly = trade.openedAt ? (Date.now() - trade.openedAt) / (1000 * 60 * 60) : (trade.barsHeld ? trade.barsHeld * 0.25 : 0);
        if (holdHoursEarly >= 1.25 && kf.entropyScore >= 0.65 && Math.abs(pnlPct) < 0.25) {
          score += 25;
          factors.push(`🌪️ Kronos Bar 5 Entropy Exit: Random walk chop detected (${(kf.entropyScore * 100).toFixed(0)}%) with flat ROI (${pnlPct.toFixed(2)}%). Freeing margin (+25pts)`);
        }
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

      // ── SMC Structure Break Invalidation under Sim Lab Directive ─────────────
      // Evaluates real-time 15m orderflow structure shifts (CHoCH / BOS)
      // Strictly gated under Sim Lab Layer 3 directive and harvester directives
      const isLayer3EnabledBySimLab = (pairDir?.layer3 !== false) &&
        (pairDir?.smcPolicy?.structureBreakCutEnabled !== false) &&
        (this.config.structureBreakCutEnabled !== false);
      let hasStructureBreak = false;

      if (isLayer3EnabledBySimLab) {
        try {
          const { standaloneEngine } = require('../engine/standalone-engine');
          const ind = standaloneEngine.getLatestIndicators(trade.symbol);
          const smc = ind?.smc;
          if (smc && smc.structureShift) {
            const shiftType = smc.structureShift.type;
            const pts = weights.smcStructureBreakChoch || 30;
            if (isLong && (shiftType === 'BEARISH_CHOCH' || shiftType === 'BEARISH_BOS')) {
              score += pts;
              hasStructureBreak = true;
              factors.push(`💥 SMC Structure Break (${shiftType}): Bullish thesis broken under Sim Lab Layer 3 directive (+${pts}pts)`);
            } else if (!isLong && (shiftType === 'BULLISH_CHOCH' || shiftType === 'BULLISH_BOS')) {
              score += pts;
              hasStructureBreak = true;
              factors.push(`💥 SMC Structure Break (${shiftType}): Bearish thesis broken under Sim Lab Layer 3 directive (+${pts}pts)`);
            }
          }
        } catch { }
      }

      // ── Time Stagnation Decay: +5 pts per hour after 2 hours without breakeven ──
      const holdTimeMs = trade.openedAt ? Date.now() - trade.openedAt : 0;
      const holdHours = holdTimeMs > 0 ? (holdTimeMs / (1000 * 60 * 60)) : (trade.barsHeld ? trade.barsHeld * 0.25 : 0);

      if (holdHours >= 2.0 && !breakevenLocked) {
        const hoursPast2 = holdHours - 2.0;
        const stagnationPts = Math.min(25, Math.floor(hoursPast2) * 5 + 5);
        score += stagnationPts;
        factors.push(`⏱️ Stagnation Decay: Open ${holdHours.toFixed(1)}h without breakeven (+${stagnationPts}pts)`);
      }

      // ── Stagnation SL Ratchet (Tightens SL closer on prolonged adverse chop after 2.5h) ─────
      // ONE-TIME EXECUTION GUARD: Must NEVER compound recursively across evaluation loops!
      const stagnationHoldHours = (this.config as any).stagnationHoursThreshold || 2.5;
      if (!trade.stagnationRatchetApplied && holdHours >= stagnationHoldHours && pnlPct < 0 && score >= 75 && !breakevenLocked && currentPrice > 0) {
        // Anchor to fixed Hard SL or original risk distance — NEVER mutable trade.stopLoss!
        const fixedHardSl = trade.hardStopLoss || (isLong ? trade.entryPrice * 0.95 : trade.entryPrice * 1.05);
        const originalRiskDistance = Math.abs(trade.entryPrice - fixedHardSl);
        if (originalRiskDistance > 0) {
          const pairDir = getSimPairDirective(trade.symbol);
          const slMult = (pairDir && typeof pairDir.slMultiplier === 'number') ? pairDir.slMultiplier : 1.0;
          // Retracement room guard: stop loss must NEVER be closer than 1.2% - 1.5% from current price
          const minSafeDistance = Math.max(
            (trade.atr || 0) * 1.5,
            currentPrice * (0.012 * slMult)
          );

          // Reduce original risk window by 40% (leaves 60% of original distance)
          const rawTightenedPrice = isLong
            ? trade.entryPrice - (originalRiskDistance * 0.6)
            : trade.entryPrice + (originalRiskDistance * 0.6);

          // Clamp to ensure breathing room is strictly preserved
          const clampedTightenedPrice = isLong
            ? Math.min(rawTightenedPrice, currentPrice - minSafeDistance)
            : Math.max(rawTightenedPrice, currentPrice + minSafeDistance);

          const isTighter = isLong
            ? (clampedTightenedPrice > (trade.stopLoss || 0) && clampedTightenedPrice < currentPrice)
            : (clampedTightenedPrice < (trade.stopLoss || Infinity) && clampedTightenedPrice > currentPrice);

          if (isTighter) {
            const finalSl = Number(clampedTightenedPrice.toFixed(4));
            trade.stopLoss = finalSl;
            trade.softRatchetPrice = finalSl;
            trade.stagnationRatchetApplied = true;
            tradeExecutor.saveTrades();
            factors.push(`⏱️ Stagnation SL Tightened: Risk window reduced by 40% after ${holdHours.toFixed(1)}h chop (preserved ${(minSafeDistance / currentPrice * 100).toFixed(2)}% retracement room)`);
            logger.info(`⏱️ [STAGNATION RATCHET] ${trade.symbol} soft stop loss safely tightened to $${trade.stopLoss} after ${holdHours.toFixed(1)}h stagnation (One-Time applied, Soft SL on-system, On-Chain Hard SL remains $${trade.hardStopLoss}).`);
          }
        }
      }

      score = Math.min(95, Math.max(15, Math.round(score)));

      let recommendation: 'HARVEST' | 'RUNNER' | 'HOLD' = 'HOLD';
      if (score >= (this.config.harvestScoreThreshold || 65) && pnlUsd > 0) {
        recommendation = 'HARVEST';
      } else if (score < (this.config.runnerScoreThreshold || 45) && breakevenLocked) {
        recommendation = 'RUNNER';
      }

      // ByKaranteli Liquidity Magnet Proximity Hold: If trade is in profit and within 0.45% of the primary liquidation magnet, let it run to collect full flush!
      const bkDirectives = (pairDir as any)?.bykaranteli?.executionDirectives;
      if (recommendation === 'HARVEST' && pnlUsd > 0 && bkDirectives?.primaryMagnetPrice) {
        const magPrice = bkDirectives.primaryMagnetPrice;
        const currentP = currentPrice || trade.entryPrice;
        const distToMagnetPct = Math.abs((magPrice - currentP) / currentP) * 100;
        const isApproachingMagnet = (trade.action === 'SHORT' && magPrice < currentP) || (trade.action === 'LONG' && magPrice > currentP);
        if (isApproachingMagnet && distToMagnetPct <= 0.45) {
          recommendation = 'HOLD';
          factors.push(`🧲 LIQUIDITY MAGNET RUNNER: Position is only ${distToMagnetPct.toFixed(2)}% from primary liquidation magnet ($${magPrice}). Letting trade run to capture full flush!`);
        }
      }

      const isManual = Boolean(trade.notes?.includes('Manual') || trade.strategyName?.includes('Manual'));

      // ── Stagnation Profit Capture: Bank profit before adverse chop reversal ──
      // If position has been held for >= 45m with positive profit and elevated vulnerability, harvest!
      const isStagnantProfit = !isManual && holdHours >= 0.75 && pnlUsd >= 0.35 && score >= 58;
      if (isStagnantProfit && recommendation !== 'HARVEST') {
        recommendation = 'HARVEST';
        factors.push(`💰 STAGNATION PROFIT HARVEST: Held ${holdHours.toFixed(1)}h with +$${pnlUsd.toFixed(2)} gain. Securing profit before range chop reversal.`);
      }

      // ── Defensive Bleed, Stagnation & Structure Break Cutting (Saves capital before max SL hit) ──
      const hasOnChainArmor = Boolean((trade.hardStopLoss && trade.hardStopLoss > 0) || isManual || trade.strategyName?.includes('On-Chain'));
      
      // Structure Break Invalidation under Sim Lab Directive:
      // If Sim Lab Layer 3 detects structural break against the position while in adverse drawdown (pnlPct <= -1.0%), cut immediately!
      const isStructureBreakCut = !isManual && isLayer3EnabledBySimLab && hasStructureBreak && pnlPct <= -1.0 && score >= (this.config.harvestScoreThreshold || 65);
      const isBleedingOut = !hasOnChainArmor && pnlPct <= -15.0 && score >= (this.config.harvestScoreThreshold || 75) && !breakevenLocked;
      const isStagnantBleed = !isManual && holdHours >= 3.5 && pnlPct <= -3.0 && score >= 85 && !breakevenLocked;

      if ((isStructureBreakCut || isBleedingOut || isStagnantBleed) && this.config.enableDefensiveCut !== false) {
        recommendation = 'HARVEST';
        const isStagCut = isStagnantBleed && !isBleedingOut && !isStructureBreakCut;
        const cutReason = isStructureBreakCut
          ? 'DEFENSIVE_STRUCTURE_BREAK_CUT'
          : (isStagCut ? 'STAGNATION_TIME_CUT' : 'DEFENSIVE_BLEED_CUT');

        factors.push(isStructureBreakCut
          ? `💥 DEFENSIVE STRUCTURE BREAK CUT: Market structure broke against thesis under Sim Lab directive, exiting at ${pnlPct.toFixed(1)}% to save capital`
          : (isStagCut
              ? `⏱️ STAGNATION TIME-CUT: Prolonged adverse chop (${holdHours.toFixed(1)}h, ${pnlPct.toFixed(1)}% PnL), liberating capital`
              : '🩸 DEFENSIVE BLEED CUT: Heavy drawdown past threshold (-15% margin), exiting to protect capital')
        );
        if (this.config.enabled && !trade.isPaper) {
          const symKey = trade.symbol.replace('-', '/').toUpperCase();
          tradeExecutor.markExecutionInFlight(symKey);
          trade.status = 'closed_sl';
          trade.exitPrice = currentPrice;
          trade.closedAt = Date.now();
          trade.exitReason = cutReason;
          trade.pnlPct = Number(pnlPct.toFixed(2));
          trade.pnlUsd = Number(pnlUsd.toFixed(2));

          const cutTitle = isStructureBreakCut
            ? `💥 Structure Break Cut @ $${currentPrice.toFixed(4)}`
            : (isStagCut ? `⏱️ Stagnation Time-Cut @ $${currentPrice.toFixed(4)}` : `🩸 Defensive Bleed Cut @ $${currentPrice.toFixed(4)}`);

          if (!trade.lifecycleEvents) trade.lifecycleEvents = [];
          trade.lifecycleEvents.push({
            timestamp: trade.closedAt,
            stage: 'EXIT',
            title: cutTitle,
            description: isStructureBreakCut
              ? `Market structure broke against trade under Sim Lab directive. Drawdown capped at ${pnlPct.toFixed(2)}%.`
              : `Liberated capital after ${holdHours.toFixed(1)}h stagnation. Drawdown capped at ${pnlPct.toFixed(2)}%.`,
            price: currentPrice,
            pnlUsd: pnlUsd,
            details: [
              `Vulnerability score high (${score}/100).`,
              isStructureBreakCut
                ? `Sim Lab Layer 3 structure shift triggered early invalidation cut.`
                : `Stagnation time decay limit exceeded (${holdHours.toFixed(1)}h). Exited on-chain to protect capital.`
            ]
          });
          trade.exitSummary = `${cutReason} executed. Drawdown capped at ${pnlPct.toFixed(2)}% to preserve trading capital under Sim Lab directive.`;

          tradeExecutor.saveTrades();
          mcpClient.closePosition(trade.symbol).catch((err: any) => {
            logger.warn(`Could not close on-chain position for ${trade.symbol} during ${trade.exitReason}: ${err.message}`);
          }).finally(() => {
            setTimeout(() => tradeExecutor.clearExecutionInFlight(symKey), 8000);
          });
          logger.warn(`💥 [${trade.exitReason}] ${trade.symbol} exited at ${pnlPct.toFixed(2)}% to preserve capital under Sim Lab directive.`);
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

  // Ratchet SL is purely soft SL on our system — do NOT push to on-chain DEX order book.
  // On-chain SL is strictly reserved for the catastrophic Hard SL (15% margin risk).
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
  const minHarvestProfitUsd = typeof cal.minHarvestNetUsd === 'number'
    ? Math.max(0.60, cal.minHarvestNetUsd)
    : 0.60;
  // Anti-hunt protection: Ensure accelerateBreakevenR is at least 1.50R (defaults to 1.75R) to avoid wick hunts
  const accelerateBreakevenR = typeof cal.accelerateBreakevenR === 'number'
    ? Math.max(1.50, cal.accelerateBreakevenR)
    : 1.75;
  const breakevenFeeBufferPct = typeof cal.breakevenFeeBufferPct === 'number' ? Math.max(0.75, cal.breakevenFeeBufferPct) : 0.75;
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
    structureBreakCutEnabled: cal.structureBreakCutEnabled !== false,
    enableDefensiveCut: cal.enableDefensiveCut !== false,
  }, 'SIM_LAB');
}
