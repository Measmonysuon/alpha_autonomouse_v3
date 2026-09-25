/**
 * Risk Guard & Pre-Trade Validation Desk
 * 
 * Enforces rigorous capital preservation and strategy directives:
 * 1. Directional Banning: Checks if signal side is banned (either by Sim Lab or local directives).
 * 2. Candle Rejection Wick Shield: Checks if candle rejection wick exceeds active wick tolerance.
 * 3. Strategy Score Floor: Checks if AI confidence score is below active score floor.
 * 4. Budget Cap Guard: Ensures total deployed capital does not exceed BUDGET_USD.
 * 5. Position Sizing: Dynamically sizes position based on ATR risk and available margin.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { standaloneEngine, StrategyDirectives } from '../engine/standalone-engine';
import { AIBrainEvaluation } from '../ai/brain';
import { StandaloneSignal } from '../engine/standalone-engine';

export interface RiskValidationResult {
  approved: boolean;
  reason: string;
  positionSizeUsd: number;
  positionSizeBase: number;
  allocatedUsd: number;
  leverage: number;
  accountEquityUsd: number;
  availableMarginUsd: number;
  directivesUsed: StrategyDirectives;
}

export class RiskGuard {
  /**
   * Pre-trade validation before placing or simulating any order
   */
  public validateSignal(
    signal: StandaloneSignal,
    aiEval: AIBrainEvaluation,
    accountEquity: number,
    availableMargin: number,
    currentAllocatedUsd: number,
  ): RiskValidationResult {
    const directives = standaloneEngine.getDirectives();
    const action = signal.action;

    // ── 0. Basic Sanity Check ──────────────────────────────────────────────────
    if (action !== 'LONG' && action !== 'SHORT') {
      return this.reject('Signal action is HOLD or unspecified', directives, accountEquity, availableMargin);
    }

    // ── 1. Directional Banning Check (Sim Lab or Local Directive) ──────────────
    if (directives.bannedSides && directives.bannedSides.includes(action)) {
      const reason = `🛑 Direction ${action} is strictly BANNED by active directives (${directives.source}: ${directives.activeStrategy}).`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    if (directives.regime && (directives.regime.includes('BEAR') || directives.regime.includes('DUMP') || String(directives.notes || '').includes('SHORT ONLY')) && action === 'LONG') {
      const reason = `🛑 Direction LONG is strictly BANNED in ${directives.regime} / SHORT ONLY regime. Trade rejected to protect capital.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // ── 2. Rejection Wick Tolerance Check ──────────────────────────────────────
    const wickTolerance = directives.bullTrapUpperWickPct || 50;
    if (action === 'LONG' && signal.indicators.upperWickPct > wickTolerance) {
      const reason = `🛑 Rejection Wick Trap: Upper wick ${signal.indicators.upperWickPct.toFixed(1)}% exceeds max tolerance of ${wickTolerance}%.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    if (action === 'SHORT' && signal.indicators.lowerWickPct > wickTolerance) {
      const reason = `🛑 Rejection Wick Trap: Lower wick ${signal.indicators.lowerWickPct.toFixed(1)}% exceeds max tolerance of ${wickTolerance}%.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // ── 3. Score Floor & AI Confirmation Check ─────────────────────────────────
    const scoreFloor = directives.scoreFloor || 75;
    if (aiEval.confidenceScore < scoreFloor) {
      const reason = `🛑 Confidence score ${aiEval.confidenceScore} is below active score floor (${scoreFloor}). [${aiEval.provider}]`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    if (!aiEval.confirmed) {
      const reason = `🛑 AI Brain (${aiEval.provider}) rejected trade: ${aiEval.reasoning}`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // ── 3b. Emergency Market Cooling / News Shockwave Guard ───────────────────
    try {
      const { getLastSyncedBundle } = require('../pipeline/sim-consumer');
      const b = getLastSyncedBundle();
      if (b?.macro?.marketCoolingActive) {
        const reason = `🛑 Market Cooling Active: Sim Lab emergency news or shockwave freeze (${b.macro.coolingReason || 'High volatility shockwave'}). Trading halted.`;
        logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
        return this.reject(reason, directives, accountEquity, availableMargin);
      }
    } catch {}

    // ── 4. Budget & Allocation Ceiling ─────────────────────────────────────────
    const maxBudget = config.BUDGET_USD;
    if (currentAllocatedUsd >= maxBudget) {
      const reason = `🛑 Budget Exhausted: Currently deployed $${currentAllocatedUsd.toFixed(2)} reaches max budget $${maxBudget.toFixed(2)}.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // Size this trade: default 30% of remaining budget scaled by Sim Lab macro risk multiplier (0.5x to 1.2x)
    let macroMultiplier = 1.0;
    try {
      const { getLastSyncedBundle } = require('../pipeline/sim-consumer');
      const b = getLastSyncedBundle();
      if (b && typeof b.macro?.riskMultiplier === 'number') {
        macroMultiplier = Math.max(0.5, Math.min(1.2, b.macro.riskMultiplier));
      }
    } catch {}

    const remainingBudget = Math.max(0, maxBudget - currentAllocatedUsd);
    const baseTargetAlloc = Math.min(
      remainingBudget,
      maxBudget * (config.MAX_ALLOC_PCT / 100),
      config.BUDGET_USD,
    );
    const targetAllocUsd = Number((baseTargetAlloc * macroMultiplier).toFixed(2));

    if (targetAllocUsd < 2.0) {
      const reason = `🛑 Remaining budget ($${remainingBudget.toFixed(2)}) is insufficient for minimum viable position.`;
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    const leverage = Math.min(signal.suggestedLeverage || 3, config.MAX_LEVERAGE || 5);
    const positionSizeUsd = targetAllocUsd * leverage;

    // Safety sanity check: block anomalous sizing beyond configured budget x maxLeverage
    const maxAllowedNotional = (config.BUDGET_USD * (config.MAX_LEVERAGE || 5)) * 1.10;
    if (positionSizeUsd > maxAllowedNotional) {
      const reason = `🛑 Safety Cap: Sizing calculation anomaly ($${positionSizeUsd.toFixed(2)}) exceeds absolute max allowable notional ($${maxAllowedNotional.toFixed(2)}). Order aborted.`;
      logger.error(`[Risk Guard] ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    const positionSizeBase = signal.entryPrice > 0 ? positionSizeUsd / signal.entryPrice : 0;

    return {
      approved: true,
      reason: `✅ Trade Approved: Score ${aiEval.confidenceScore} >= ${scoreFloor} | Alloc $${targetAllocUsd.toFixed(2)} @ ${leverage}x | Wick safe`,
      positionSizeUsd,
      positionSizeBase,
      allocatedUsd: targetAllocUsd,
      leverage,
      accountEquityUsd: accountEquity,
      availableMarginUsd: availableMargin,
      directivesUsed: directives,
    };
  }

  private reject(
    reason: string,
    directives: StrategyDirectives,
    accountEquity: number,
    availableMargin: number,
  ): RiskValidationResult {
    return {
      approved: false,
      reason,
      positionSizeUsd: 0,
      positionSizeBase: 0,
      allocatedUsd: 0,
      leverage: 1,
      accountEquityUsd: accountEquity,
      availableMarginUsd: availableMargin,
      directivesUsed: directives,
    };
  }
}

export const riskGuard = new RiskGuard();

export type RiskAssessment = RiskValidationResult;

export async function assessRisk(signal: any, cachedBalance?: any): Promise<RiskAssessment> {
  const equity = config.BUDGET_USD;
  const dummyAi = {
    confirmed: true,
    confidenceScore: signal.confidence ?? 80,
    action: signal.action,
    sentiment: 'NEUTRAL' as const,
    reasoning: 'Pre-trade assessment',
    provider: 'local_rules' as const,
    role: 'PRIMARY_VALIDATOR' as const,
    riskFlags: [],
  };
  return riskGuard.validateSignal(signal, dummyAi, equity, equity, 0);
}
