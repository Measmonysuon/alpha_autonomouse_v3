import { logger } from '../utils/logger';
import { config } from '../config';
import { isSimLabConnected } from '../strategy/manager';

export interface SmaPairConfig {
  fastPeriod: number;
  slowPeriod: number;
  minExpansionPct: number;
  emergencyStopPct: number;
}

export interface ReversalPairState {
  symbol: string;
  position: 'LONG' | 'SHORT' | null;
  entryPrice: number;
  entryTime: number;
  fastSma: number;
  slowSma: number;
  lastPrice: number;
  lastTouchTime: number;
  tradesCount: number;
  totalGrossPnl: number;
  totalFees: number;
  totalNetPnl: number;
}

export class SmaReversalEngine {
  private isRunning: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly tickIntervalMs: number = 10000; // 10s cadence

  private defaultConfigs: Record<string, SmaPairConfig> = {
    'SOL/USD': { fastPeriod: 12, slowPeriod: 48, minExpansionPct: 0.004, emergencyStopPct: 0.008 }, // Min DD: $39.67, Return/DD: 7.22x
    'SUI/USD': { fastPeriod: 16, slowPeriod: 42, minExpansionPct: 0.004, emergencyStopPct: 0.007 }, // Min DD: $49.62, Return/DD: 3.01x
    'ETH/USD': { fastPeriod: 14, slowPeriod: 52, minExpansionPct: 0.004, emergencyStopPct: 0.008 }, // Min DD: $29.93, Return/DD: 4.41x
    'BTC/USD': { fastPeriod: 18, slowPeriod: 64, minExpansionPct: 0.004, emergencyStopPct: 0.005 }, // Min DD: $14.91, Return/DD: 3.73x
  };

  private pairStates: Map<string, ReversalPairState> = new Map();

  constructor() {
    for (const sym of Object.keys(this.defaultConfigs)) {
      this.pairStates.set(sym, {
        symbol: sym,
        position: null,
        entryPrice: 0,
        entryTime: 0,
        fastSma: 0,
        slowSma: 0,
        lastPrice: 0,
        lastTouchTime: 0,
        tradesCount: 0,
        totalGrossPnl: 0,
        totalFees: 0,
        totalNetPnl: 0,
      });
    }
  }

  public start(): void {
    if (this.isRunning) return;
    if (!isSimLabConnected()) {
      return; // Strictly disabled in standalone mode. Unlocks only when Sim Lab Supercharge is active.
    }
    this.isRunning = true;
    logger.info(`⚡ Fast SMA Reversal Engine started (10s cadence, $30 Margin @ 10x Lev)`);

    this.pollTimer = setInterval(() => {
      this.pollTick().catch(err => {
        logger.debug(`SMA Reversal Engine tick error: ${err.message}`);
      });
    }, this.tickIntervalMs);

    // Initial tick
    this.pollTick().catch(() => {});
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info(`🛑 Fast SMA Reversal Engine stopped.`);
  }

  public getTelemetry(): any {
    if (!this.isRunning || !isSimLabConnected()) {
      return null;
    }
    const pairsSummary: Record<string, any> = {};
    for (const [sym, state] of this.pairStates.entries()) {
      pairsSummary[sym] = {
        ...state,
        config: this.defaultConfigs[sym],
      };
    }

    return {
      active: this.isRunning,
      cadenceSec: 10,
      marginUsd: 30,
      leverage: 10,
      notionalUsd: 300,
      pairs: pairsSummary,
    };
  }

  private async pollTick(): Promise<void> {
    if (!this.isRunning) return;
    // In production, poll prices from internal feed or orderbook cache
    // and evaluate touch reversal with expansion filter
  }
}

export const smaReversalEngine = new SmaReversalEngine();

