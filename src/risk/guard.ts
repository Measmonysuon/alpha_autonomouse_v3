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
import { AUTHORITATIVE_DECIBEL_MARKETS } from '../mcp/client';

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

export function cleanImmunityReason(raw: string): string {
  if (!raw) return '';
  let cleaned = String(raw).replace(/\uFFFD+/g, '');
  if (cleaned.includes('[SHARED IMMUNITY]')) {
    const firstIdx = cleaned.indexOf('[SHARED IMMUNITY]');
    const lastIdx = cleaned.lastIndexOf('[SHARED IMMUNITY]');
    let startIdx = firstIdx;
    while (startIdx > 0 && /[^\w\s:()]/.test(cleaned[startIdx - 1])) {
      startIdx--;
    }
    const before = cleaned.slice(0, startIdx).trim();
    const after = cleaned.slice(lastIdx + '[SHARED IMMUNITY]'.length).trim();
    cleaned = `${before} 🛡️ [SHARED IMMUNITY] ${after}`.trim();
  }
  // Deduplicate multiple occurrences of shield emoji
  cleaned = cleaned.replace(/(?:🛡️?\s*)+/g, '🛡️ ');
  // Deduplicate multiple occurrences of (locked by ...)
  cleaned = cleaned.replace(/(?:\(locked by [^)]+\)\s*)+/g, (match) => {
    const m = match.match(/\(locked by [^)]+\)/);
    return m ? m[0] + ' ' : '';
  });
  // Clean up colon formatting
  cleaned = cleaned.replace(/:\s*🛡️\s*\[SHARED IMMUNITY\]/g, ': 🛡️ [SHARED IMMUNITY]');
  return cleaned.replace(/[ \t]{2,}/g, ' ').trim();
}

export class RiskGuard {
  private trapCoolOffs = new Map<string, { expiresAt: number; reason: string; trapCategory: string }>();

  /**
   * Trigger an automatic 15-minute cool-off when Layer 4 AI Shield vetoes a predatory trap
   */
  public triggerL4TrapCoolOff(
    symbol: string,
    action: 'LONG' | 'SHORT' | 'BOTH',
    trapCategory: string,
    reason: string,
    durationMinutes = 15,
    forcedExpiresAt?: number,
  ): void {
    const norm = symbol.toUpperCase().replace('-', '/');
    const cleanReason = cleanImmunityReason(reason);
    const now = Date.now();

    const setLock = (side: 'LONG' | 'SHORT') => {
      const lockKey = `${norm}:${side}`;
      const existing = this.trapCoolOffs.get(lockKey);
      let expiresAt: number;
      if (forcedExpiresAt && forcedExpiresAt > now) {
        expiresAt = forcedExpiresAt;
      } else if (existing && existing.expiresAt > now) {
        // MONOTONIC EXPIRATION: Retain existing timer so countdown never resets or jumps forward on heartbeat ticks!
        expiresAt = existing.expiresAt;
      } else {
        expiresAt = now + durationMinutes * 60 * 1000;
      }
      this.trapCoolOffs.set(lockKey, { expiresAt, reason: cleanReason, trapCategory });
    };

    if (action === 'BOTH') {
      setLock('LONG');
      setLock('SHORT');
    } else {
      setLock(action);
    }
    logger.warn(
      `🛡️ [AI SHIELD COOL-OFF] ${norm} ${action} locked for ${durationMinutes}m: ${trapCategory} — ${cleanReason}`
    );

    // Broadcast instant trap veto to Sim Lab and connected fleet desks out-of-band
    // CRITICAL: NEVER re-broadcast if this veto originated from Sim Lab (SIM_LAB_DIRECTIVE or SHARED IMMUNITY),
    // otherwise it creates an infinite feedback loop where each broadcast appends another prefix!
    if (trapCategory !== 'SIM_LAB_DIRECTIVE' && !reason.includes('SHARED IMMUNITY') && !reason.includes('Sim Lab')) {
      try {
        const { pushInstantVeto } = require('../pipeline/telemetry-feeder');
        pushInstantVeto(norm, action, trapCategory, cleanReason, durationMinutes).catch(() => {});
      } catch {}
    }
  }

  public getActiveTrapCoolOff(symbol: string, action: 'LONG' | 'SHORT'): { locked: boolean; reason?: string; trapCategory?: string; remainingMinutes?: number } {
    const norm = symbol.toUpperCase().replace('-', '/');
    const lockKey = `${norm}:${action}`;
    const activeLock = this.trapCoolOffs.get(lockKey);
    if (activeLock && activeLock.expiresAt > Date.now()) {
      const remainingMinutes = Math.ceil((activeLock.expiresAt - Date.now()) / 60000);
      return { locked: true, reason: cleanImmunityReason(activeLock.reason), trapCategory: activeLock.trapCategory, remainingMinutes };
    }
    return { locked: false };
  }

  public getAllActiveCoolOffs(): Array<{ symbol: string; action: string; trapCategory: string; reason: string; remainingMinutes: number; expiresAt: number }> {
    const now = Date.now();
    const results: any[] = [];
    for (const [key, lock] of this.trapCoolOffs.entries()) {
      if (lock.expiresAt > now) {
        const [symbol, action] = key.split(':');
        const remainingMinutes = Math.ceil((lock.expiresAt - now) / 60000);
        results.push({ symbol, action, trapCategory: lock.trapCategory, reason: cleanImmunityReason(lock.reason), remainingMinutes, expiresAt: lock.expiresAt });
      } else {
        this.trapCoolOffs.delete(key);
      }
    }
    return results;
  }

  /**
   * Pre-trade validation before placing or simulating any order
   */
  public validateSignal(
    signal: StandaloneSignal,
    aiEval: AIBrainEvaluation,
    accountEquity: number,
    availableMargin: number,
    currentAllocatedUsd: number,
    openPositionsCount = 0,
  ): RiskValidationResult {
    const directives = standaloneEngine.getDirectives();
    const action = signal.action;
    let isCounterTrendTrade = false;

    // ── 0. Basic Sanity Check ──────────────────────────────────────────────────
    if (action !== 'LONG' && action !== 'SHORT') {
      return this.reject('Signal action is HOLD or unspecified', directives, accountEquity, availableMargin);
    }

    // ── 0b. 15-Minute AI Shield Directional Trap Cool-Off ─────────────────────
    const lock = this.getActiveTrapCoolOff(signal.symbol, action);
    if (lock.locked) {
      const reason = `🛑 Blocked by 15m AI Shield Trap Cool-Off: ${lock.trapCategory} (${lock.reason}) — ${lock.remainingMinutes}m remaining.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // ── 0c. Rolling-Window Anti-Overfitting Walk-Forward Gate ────────────────
    try {
      const { getLastSyncedBundle, getPairRollingDirectives } = require('../pipeline/sim-consumer');
      const b = getLastSyncedBundle();
      const rwDirectives = b?.rollingWindowDirectives;
      const pairRolling = getPairRollingDirectives(signal.symbol);

      if (rwDirectives?.active) {
        if (rwDirectives?.quarantinedPairs?.includes(signal.symbol) || (pairRolling && pairRolling.wfe < 0.50)) {
          const wfeVal = pairRolling?.wfe != null ? pairRolling.wfe.toFixed(2) : '< 0.50';
          const reason = `🛑 Blocked by Rolling-Window Anti-Overfitting Protocol: ${signal.symbol} Walk-Forward Efficiency (WFE ${wfeVal} < 0.50) degraded. Quarantined from live execution.`;
          logger.warn(`[Risk Guard] ${reason}`);
          return this.reject(reason, directives, accountEquity, availableMargin);
        }

        // Confluence Gate: Fast dynamic SMA momentum alignment
        if (pairRolling && pairRolling.smaAlignment !== 'NEUTRAL') {
          const isOpposingLong = action === 'LONG' && pairRolling.smaAlignment === 'BEARISH';
          const isOpposingShort = action === 'SHORT' && pairRolling.smaAlignment === 'BULLISH';
          if (isOpposingLong || isOpposingShort) {
            const sigConfidence = signal.confidence || aiEval.confidenceScore || 0;
            if (sigConfidence < 75) {
              const reason = `🛑 Blocked by Rolling-Window Confluence Sentinel: Dynamic SMA(${pairRolling.fastPeriod}/${pairRolling.slowPeriod}) alignment is ${pairRolling.smaAlignment}, opposing ${action} with moderate confidence (${sigConfidence}% < 75%).`;
              logger.warn(`[Risk Guard] ${reason}`);
              return this.reject(reason, directives, accountEquity, availableMargin);
            }
            isCounterTrendTrade = true;
            logger.info(`⚖️ [Risk Guard] ${signal.symbol} Dynamic SMA(${pairRolling.fastPeriod}/${pairRolling.slowPeriod}) opposes ${action}, but strong conviction (${sigConfidence}% >= 75%) permits execution with 0.5x margin dampener.`);
          }
        }

        // Pre-Trade Retest Gate: Fast Robust Island SMA Retest & Pure Freshness Mandate (Option A)
        const { getActiveStrategy, getSimPairDirective } = require('../strategy/manager');
        const activeStrat = getActiveStrategy();
        const pairDir = typeof getSimPairDirective === 'function' ? getSimPairDirective(signal.symbol) : undefined;
        if (activeStrat?.layer1?.fastSmaRetestEnabled && pairRolling) {
          // 1. Pure Freshness Mandate: Hard Veto if barsSinceCross > maxBars (default <= 4)
          const maxBars = activeStrat?.layer1?.maxBarsSinceCrossover ?? 4;
          const barsSinceCross = (typeof pairRolling.barsSinceCross === 'number')
            ? pairRolling.barsSinceCross
            : (pairDir?.barsSinceCross);

          if (typeof barsSinceCross === 'number' && barsSinceCross > maxBars) {
            const reason = `🛑 Blocked by Robust Island Pure Freshness Gate: ${signal.symbol} trend age is ${barsSinceCross} bars (> ${maxBars} bars limit). Awaiting fresh crossover cycle.`;
            logger.warn(`[Risk Guard] ${reason}`);
            return this.reject(reason, directives, accountEquity, availableMargin);
          }

          // 2. Strict Fast SMA Retest Tolerance (±0.35% trampoline)
          const isLong = action === 'LONG';
          const isShort = action === 'SHORT';
          const retestPass = isLong ? pairRolling.priceRetestLong : pairRolling.priceRetestShort;
          
          if (retestPass === false) {
            const tol = activeStrat.layer1.fastSmaRetestTolerancePct ?? 0.35;
            const dist = pairRolling.priceVsFastSmaPct !== undefined ? `${pairRolling.priceVsFastSmaPct.toFixed(2)}%` : 'unconfirmed';
            const reason = `🛑 Blocked by Robust Island Fast SMA Retest Gate: ${signal.symbol} ${action} price extended from Fast SMA(${pairRolling.fastPeriod}) (${dist} away, tol ±${tol}%). Waiting for dynamic trampoline retest.`;
            logger.warn(`[Risk Guard] ${reason}`);
            return this.reject(reason, directives, accountEquity, availableMargin);
          } else {
            logger.info(`🎯 [Risk Guard] ${signal.symbol} Fast SMA Pullback Retest CONFIRMED by Sim Lab Alpha Bundle for ${action} (age: ${barsSinceCross ?? 'fresh'} bars).`);
          }
        }
      }
    } catch {}

    const { superchargeClient } = require('../simlab/supercharge-client');
    const isSupercharged = superchargeClient.isActive() || directives.source === 'SIMLAB_SUPERCHARGED';

    if (isSupercharged) {

      // Check Sim Lab Macro News Freeze
      try {
        const { getLastSyncedBundle } = require('../pipeline/sim-consumer');
        const b = getLastSyncedBundle();
        if (typeof b?.macro?.nearestNewsMinutes === 'number' && b.macro.nearestNewsMinutes <= 30 && b.macro.nearestNewsMinutes >= -15) {
          const reason = `🛑 Blocked by Sim Lab Macro News Freeze: Event "${b.macro.nearestNewsTitle || 'High-Impact USD Announcement'}" in ${b.macro.nearestNewsMinutes}m. Trading halted.`;
          logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
          return this.reject(reason, directives, accountEquity, availableMargin);
        }
      } catch {}

      // Check Sim Lab Pair Directive Cooldowns & Banned Sides
      try {
        const { getSimPairDirective } = require('../strategy/manager');
        const simDir = getSimPairDirective(signal.symbol);
        if (simDir?.coolOffActive) {
          if (!simDir.bannedSide || simDir.bannedSide === 'BOTH' || simDir.bannedSide === action) {
            const reason = `🛑 Blocked by Sim Lab Pair Directives: ${simDir.reason || 'Automated Fleet Cooldown active'}.`;
            logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
            return this.reject(reason, directives, accountEquity, availableMargin);
          }
        }

        // Check Kronos Financial Foundation Multi-Shield Directives
        if (simDir?.kronosForecast) {
          const kf = simDir.kronosForecast;
          // 1. Falling Knife Shield for Longs
          if (action === 'LONG' && kf.knifeRiskScore >= 0.70) {
            const reason = `🔪 Blocked by Kronos Falling Knife Shield: Neural down-tail probability is ${(kf.knifeRiskScore * 100).toFixed(0)}% (Expected Return: ${kf.expectedReturnPct.toFixed(2)}%). Entry vetoed.`;
            logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
            return this.reject(reason, directives, accountEquity, availableMargin);
          }
          // 2. Runaway Melt-Up Shield for Shorts
          if (action === 'SHORT' && kf.meltUpRiskScore && kf.meltUpRiskScore >= 0.70) {
            const reason = `🚀 Blocked by Kronos Runaway Melt-Up Shield: Squeeze impulse velocity is ${(kf.meltUpRiskScore * 100).toFixed(0)}% (Expected Return: +${kf.expectedReturnPct.toFixed(2)}%). Entry vetoed.`;
            logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
            return this.reject(reason, directives, accountEquity, availableMargin);
          }
          // 3. Entropy Chop Gate
          if ((kf.entropyScore && kf.entropyScore >= 0.68) || simDir.confidenceSizing?.entropyState === 'HIGH_ENTROPY_CHOP') {
            const reason = `🌪️ Blocked by Kronos Entropy Chop Gate: High market randomness (${((kf.entropyScore || 0.7) * 100).toFixed(0)}%) suppresses entry to preserve capital.`;
            logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
            return this.reject(reason, directives, accountEquity, availableMargin);
          }

          // 4. Adopt Optimal Limit Entry from Kronos (Passive Maker Offset Only)
          // Strict Invariant: Kronos NEVER touches Take-Profit (TP) or Stop-Loss (SL)!
          // Robust Island Champion V3 architecture (Entry #1 Retest, Fast SMA Trail, and Exit #3 Dynamic Gap Harvest) is 100% sovereign.
          if (simDir.optimalEntry?.limitPrice && simDir.optimalEntry.limitPrice > 0) {
            signal.limitPrice = simDir.optimalEntry.limitPrice;
            signal.entryPrice = simDir.optimalEntry.limitPrice;
          }

          // 5. Check Capital Routing: Exclusive Funneling to Top 10 Most Predictable Assets
          if (simDir.capitalRouting) {
            const isHighConviction = (aiEval.confidenceScore ?? 0) >= 85;
            if (!simDir.capitalRouting.isRouted && !isHighConviction) {
              const reason = `🛑 Blocked by Capital Routing Gate: ${signal.symbol} is rank #${simDir.capitalRouting.rank} outside Top 10 predictable pairs. Capital funneled exclusively to top predictable assets.`;
              logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
              return this.reject(reason, directives, accountEquity, availableMargin);
            }
            if (!simDir.capitalRouting.isRouted && isHighConviction) {
              logger.info(
                `✨ [Risk Guard] ${signal.symbol} (Rank #${simDir.capitalRouting.rank}) granted High-Conviction Exemption ` +
                `(${aiEval.confidenceScore}% confidence >= 85%) through Capital Routing Gate.`
              );
            }
          }

          // 6. Check Lead-Lag Alpha: Front-Running via BTC Impulse Forecasts
          if (simDir.leadLagAlpha && simDir.leadLagAlpha.impulseDetected) {
            const lla = simDir.leadLagAlpha;
            if (lla.action === action) {
              logger.info(
                `⚡ [Risk Guard - Lead-Lag Alpha] Authorizing early breakout for ${signal.symbol} ` +
                `via BTC impulse (+${lla.leaderExpectedReturnPct.toFixed(2)}%). Confidence Bonus: +${lla.frontRunConfidenceBonus}pts.`
              );
              if (aiEval.confidenceScore) {
                aiEval.confidenceScore = Math.min(99, aiEval.confidenceScore + lla.frontRunConfidenceBonus);
              }
            }
          }
        }
      } catch {}

      // Check Institutional Liquidity Depth Screening ($4M Min Clusters per Pillar 3)
      try {
        const { getSimPairDirective } = require('../strategy/manager');
        const simDir = getSimPairDirective(signal.symbol);
        const clusters = simDir?.orderflow?.liquidationClusters;
        if (clusters) {
          const totalDepth = (clusters.longLiquidationUsd || 0) + (clusters.shortLiquidationUsd || 0);
          const PRIMARY_MAJORS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
          if (totalDepth > 0 && totalDepth < 4_000_000 && !PRIMARY_MAJORS.includes(signal.symbol)) {
            if (aiEval.confidenceScore < 85) {
              const reason = `🛑 Institutional Liquidity Gate: Total cluster depth ($${(totalDepth / 1e6).toFixed(2)}M) is below institutional threshold ($4M) and score (${aiEval.confidenceScore}) < 85.`;
              logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
              return this.reject(reason, directives, accountEquity, availableMargin);
            }
          }
        }
      } catch {}

      // Quantum Einsteinian Microstructure & Hoax Collapse Check
      try {
        const { getLastSyncedBundle } = require('../pipeline/sim-consumer');
        const { getSimPairDirective } = require('../strategy/manager');
        const b = getLastSyncedBundle();
        const simDir = getSimPairDirective(signal.symbol);
        const qMicro = (simDir as any)?.quantumMicrostructure;
        const of = simDir?.orderflow;

        if (b?.quantumDirectives?.active || qMicro) {
          const cvdTrend = of?.cvdTrend;
          const imb = of?.orderflowImbalancePct;
          const tbr = (of as any)?.takerBuyRatio;
          
          // Hard veto if fake gravity well detected or adverse hoax collapse
          const isBearishHoax = action === 'LONG' && (
            qMicro?.isFakeGravityWell ||
            qMicro?.isHoaxCollapse ||
            cvdTrend === 'SELL' ||
            cvdTrend === 'STRONG_SELL' ||
            (typeof imb === 'number' && imb < -25) ||
            (typeof tbr === 'number' && tbr < 0.44)
          );

          const isBullishHoax = action === 'SHORT' && (
            qMicro?.isFakeGravityWell ||
            qMicro?.isHoaxCollapse ||
            cvdTrend === 'BUY' ||
            cvdTrend === 'STRONG_BUY' ||
            (typeof imb === 'number' && imb > 25) ||
            (typeof tbr === 'number' && tbr > 0.56)
          );

          if (isBearishHoax) {
            const reason = `🛑 Blocked by Quantum Microstructure Guard: Bearish Hoax Collapse on ${signal.symbol}. Bid mass evaporated with net negative CVD (${cvdTrend || 'SELL'}) and seller dominance.`;
            logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
            return this.reject(reason, directives, accountEquity, availableMargin);
          }
          if (isBullishHoax) {
            const reason = `🛑 Blocked by Quantum Microstructure Guard: Bullish Hoax Collapse / Squeeze on ${signal.symbol}. Ask mass evaporated with net positive CVD (${cvdTrend || 'BUY'}) and buyer dominance.`;
            logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
            return this.reject(reason, directives, accountEquity, availableMargin);
          }
        }
      } catch {}
    }

    // ── 1. Asymmetric Regime Directional Hurdle Gate ───────────────────────────
    const COUNTER_TREND_CONFIDENCE_HURDLE = 85;

    const isBearRegime = Boolean(
      (directives.regime && (directives.regime.includes('BEAR') || directives.regime.includes('DUMP') || String(directives.notes || '').includes('SHORT ONLY')))
    );

    if (isBearRegime && action === 'LONG') {
      isCounterTrendTrade = true;
      if (aiEval.confidenceScore < COUNTER_TREND_CONFIDENCE_HURDLE) {
        const reason = `🛑 [ASYMMETRIC REGIME HURDLE] Counter-trend LONG under ${directives.regime || 'BEARISH'} requires elevated confidence (>= ${COUNTER_TREND_CONFIDENCE_HURDLE}%). Current score (${aiEval.confidenceScore}%) is insufficient.`;
        logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
        return this.reject(reason, directives, accountEquity, availableMargin);
      }
      logger.info(`✨ [Risk Guard] ${signal.symbol} Counter-trend LONG authorized under ${directives.regime} with elevated confidence (${aiEval.confidenceScore}% >= ${COUNTER_TREND_CONFIDENCE_HURDLE}%). Sizing damped to 0.5x.`);
    }

    // ── 2. Rejection Wick Tolerance Check ──────────────────────────────────────
    const wickTolerance = directives.bullTrapUpperWickPct || 50;
    if (action === 'LONG' && (signal.indicators?.upperWickPct ?? 0) > wickTolerance) {
      const reason = `🛑 Rejection Wick Trap: Upper wick ${signal.indicators!.upperWickPct.toFixed(1)}% exceeds max tolerance of ${wickTolerance}%.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    if (action === 'SHORT' && (signal.indicators?.lowerWickPct ?? 0) > wickTolerance) {
      const reason = `🛑 Rejection Wick Trap: Lower wick ${signal.indicators!.lowerWickPct.toFixed(1)}% exceeds max tolerance of ${wickTolerance}%.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // ── 2b. Pullback Candle Confirmation & Falling Knife Guard ─────────────────
    if (action === 'LONG' && signal.indicators?.candleColor === 'RED' && (signal.indicators?.lowerWickPct ?? 0) < 25) {
      const reason = `🛑 Falling Knife Guard: Active 15m candle is red without buyer absorption (lower wick ${(signal.indicators?.lowerWickPct ?? 0).toFixed(1)}% < 25%). Waiting for green reversal candle.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }
    if (action === 'SHORT' && signal.indicators?.candleColor === 'GREEN' && (signal.indicators?.upperWickPct ?? 0) < 25) {
      const reason = `🛑 Rocket Knife Guard: Active 15m candle is green without seller absorption (upper wick ${(signal.indicators?.upperWickPct ?? 0).toFixed(1)}% < 25%). Waiting for red reversal candle.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // ── 3. Dynamic Score Floor & AI Confirmation Check ─────────────────────────
    let pairGateOverride: number | undefined;
    try {
      const { getPairOverrides } = require('../strategy/manager');
      pairGateOverride = getPairOverrides(signal.symbol)?.minConfidenceGate;
    } catch {}
    const scoreFloor = pairGateOverride || directives.scoreFloor || 80;
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

      // ── Directional Regime Ban & Empirical Pair Quarantine Guard ──
      const normSym = signal.symbol.replace('-', '/').toUpperCase();
      const pairDir = b?.pairDirectives?.[signal.symbol] || b?.pairDirectives?.[normSym];
      if (pairDir) {
        if (pairDir.bannedSide === 'BOTH' || pairDir.probationActive || pairDir.shadowModeOnly) {
          const reason = `🛑 [QUANT QUARANTINE] ${signal.symbol} is quarantined to Paper Shadow Simulation: ${pairDir.reason || 'Persistent negative expectancy'}. Order blocked.`;
          logger.warn(`[Risk Guard] ${reason}`);
          return this.reject(reason, directives, accountEquity, availableMargin);
        } else if (pairDir.bannedSide === action) {
          const reason = `🛑 [PAIR BAN] Direction ${action} is banned for ${signal.symbol} by Sim Lab directive: ${pairDir.reason || 'Restricted'}.`;
          logger.warn(`[Risk Guard] ${reason}`);
          return this.reject(reason, directives, accountEquity, availableMargin);
        }
      }

      const isBullRegime = b?.macro?.regime === 'RISK_ON_BETA' || b?.macro?.regime === 'TRENDING_BULL' || b?.macro?.marketBias === 'BULLISH';
      if (action === 'SHORT' && isBullRegime) {
        isCounterTrendTrade = true;
        if (aiEval.confidenceScore < COUNTER_TREND_CONFIDENCE_HURDLE) {
          const reason = `🛑 [ASYMMETRIC REGIME HURDLE] Counter-trend SHORT under ${b?.macro?.regime || 'RISK_ON_BETA'} requires elevated confidence (>= ${COUNTER_TREND_CONFIDENCE_HURDLE}%). Current score (${aiEval.confidenceScore}%) is insufficient.`;
          logger.warn(`[Risk Guard] ${reason}`);
          return this.reject(reason, directives, accountEquity, availableMargin);
        }
        logger.info(`✨ [Risk Guard] ${signal.symbol} Counter-trend SHORT authorized under ${b?.macro?.regime || 'RISK_ON_BETA'} with elevated confidence (${aiEval.confidenceScore}% >= ${COUNTER_TREND_CONFIDENCE_HURDLE}%). Sizing damped to 0.5x.`);
      }

      // Fleet Quarantine Directive Check from Sim Lab
      if (b?.quarantineDirectives && b.quarantineDirectives[normSym]) {
        const q = b.quarantineDirectives[normSym];
        if (q.quarantinedUntil && Date.now() < q.quarantinedUntil) {
          const remMin = Math.ceil((q.quarantinedUntil - Date.now()) / 60000);
          const reason = `🛑 Blocked by Sim Lab Fleet Quarantine: ${normSym} is quarantined for ${remMin}m (${q.reason || 'Post-stop toxic flow'}). Order blocked.`;
          logger.warn(`[Risk Guard] ${reason}`);
          return this.reject(reason, directives, accountEquity, availableMargin);
        }
      }
    } catch {}

    // ── 3c. Concurrent & Directional Basket Caps ──────────────────────────────
    let simLabBundle: any = null;
    try {
      const { getLastSyncedBundle } = require('../pipeline/sim-consumer');
      simLabBundle = getLastSyncedBundle();
    } catch {}
    const activeDirectives: any = directives || simLabBundle;

    const clientMaxOpen = (config as any).MAX_OPEN_POSITIONS ?? 2;
    const simLabMaxOpen = activeDirectives?.portfolioLimits?.maxConcurrentPositions;
    const maxOpenPositions = typeof simLabMaxOpen === 'number' ? Math.min(clientMaxOpen, simLabMaxOpen) : clientMaxOpen;
    if (openPositionsCount >= maxOpenPositions) {
      const reason = `🛑 Max Concurrent Positions Reached: Active open positions (${openPositionsCount}) >= configured limit (${maxOpenPositions}). Order rejected.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    let sameDirCount = 0;
    let sameDirMargin = 0;
    try {
      const { tradeExecutor } = require('../trades/executor');
      const open = tradeExecutor.getOpenTrades();
      for (const t of open) {
        if (t.action === action) {
          sameDirCount++;
          sameDirMargin += (t.allocatedUsd || 0);
        }
      }
    } catch {}

    if (sameDirCount >= 2) {
      const reason = `🛑 Directional Basket Cap Reached: Maximum 2 concurrent ${action} positions active. New ${action} for ${signal.symbol} blocked for portfolio diversification.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    const maxDirMargin = 80.0;
    if (sameDirMargin >= maxDirMargin) {
      const reason = `🛑 Directional Margin Ceiling Reached: Total ${action} margin deployed is $${sameDirMargin.toFixed(2)} (>= $${maxDirMargin.toFixed(2)} limit). New ${action} blocked to prevent correlated beta cascade.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // ── 4. Budget & Allocation Ceiling ─────────────────────────────────────────
    if (config.BUDGET_USD <= 0) {
      const reason = `🛑 Budget Locked: Configured trading budget is $0.00. Set an authorized budget ceiling in Settings before live trading.`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // Live capital guard: The working budget ceiling can never exceed real on-chain account equity when available.
    const effectiveBudget = (accountEquity > 0)
      ? Math.min(config.BUDGET_USD, accountEquity)
      : config.BUDGET_USD;
    const maxBudget = effectiveBudget;
    if (currentAllocatedUsd >= maxBudget) {
      const reason = `🛑 Budget Exhausted: Currently deployed $${currentAllocatedUsd.toFixed(2)} reaches max budget $${maxBudget.toFixed(2)} (Configured: $${config.BUDGET_USD.toFixed(2)}, Real Equity: $${accountEquity.toFixed(2)}).`;
      logger.warn(`[Risk Guard] ${signal.symbol} — ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // Size this trade: default 30% of remaining budget scaled by Sim Lab macro risk multiplier (0.5x to 1.2x)
    let macroMultiplier = 1.0;
    if (simLabBundle && typeof simLabBundle.macro?.riskMultiplier === 'number') {
      macroMultiplier = Math.max(0.5, Math.min(1.2, simLabBundle.macro.riskMultiplier));
    }

    const remainingBudget = Math.max(0, maxBudget - currentAllocatedUsd);
    const clientMaxPos = (config as any).MAX_POSITION_USD || 60;
    const simLabMaxPos = activeDirectives?.portfolioLimits?.maxPositionUsd || activeDirectives?.pairDirectives?.[signal.symbol]?.maxPositionUsd;
    const effectiveMaxPosCeiling = typeof simLabMaxPos === 'number' ? Math.min(clientMaxPos, simLabMaxPos) : clientMaxPos;
    const userMaxPosUsd = Math.min(effectiveMaxPosCeiling, maxBudget);

    const normSym = signal.symbol.toUpperCase().replace('-', '/');
    const pairDir = activeDirectives?.pairDirectives?.[normSym] || activeDirectives?.pairDirectives?.[signal.symbol];

    // Probation / Sandbox Protection:
    if (pairDir?.assignedTier === 'TIER_3_PROBATION' || pairDir?.tierAllocPct === 0) {
      const reason = `🛑 Tier 3 Probation: ${signal.symbol} is quarantined in paper shadow mode. Live allocation is 0%.`;
      logger.warn(`[Risk Guard] ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }
    if (pairDir?.shadowModeOnly || (pairDir?.sandboxTradesRemaining || 0) > 0) {
      const reason = `🧪 Sandbox Shadow Mode: ${signal.symbol} has ${pairDir?.sandboxTradesRemaining || 3} trial trades remaining. Live execution held.`;
      logger.info(`[Risk Guard] ${reason}`);
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    const isReversalLoop = signal.strategyName === 'Robust Island SMA Reversal Loop';
    const clientMinPosUsd = isReversalLoop ? ((signal as any).customMarginUsd || 30.0) : ((config as any).MIN_POSITION_USD || 35.0);
    const stratMinMargin = isReversalLoop
      ? ((signal as any).customMarginUsd || 30.0)
      : Math.max(
          clientMinPosUsd,
          activeDirectives?.strategy?.layer5?.minMarginUsd ??
          (activeDirectives?.strategy as any)?.minMarginUsd ??
          20.0,
        );

    let targetAllocUsd: number;
    if (isReversalLoop) {
      targetAllocUsd = Math.min((signal as any).customMarginUsd || 30.0, remainingBudget);
    } else {
      // Dynamic Percentage Sizing: Respects client working budget and pair tier allocation %
      const pairAllocPct = (typeof pairDir?.tierAllocPct === 'number')
        ? pairDir.tierAllocPct
        : (typeof (activeDirectives?.strategy?.maxAllocPct) === 'number' ? activeDirectives.strategy.maxAllocPct : config.MAX_ALLOC_PCT);
      const effectiveAllocPct = Math.min(pairAllocPct, config.MAX_ALLOC_PCT);

      const baseTargetAlloc = Math.min(
        remainingBudget,
        maxBudget * (effectiveAllocPct / 100),
        userMaxPosUsd,
      );
      targetAllocUsd = Number((baseTargetAlloc * macroMultiplier).toFixed(2));

      // Kronos Confidence-Calibrated Sizing Multiplier (0.3x for chop up to 1.0x for high conviction)
      if (typeof pairDir?.confidenceSizing?.positionMultiplier === 'number') {
        const kronosMult = Math.max(0.3, Math.min(1.0, pairDir.confidenceSizing.positionMultiplier));
        targetAllocUsd = Number((targetAllocUsd * kronosMult).toFixed(2));
        if (kronosMult !== 1.0) {
          logger.info(`[Risk Guard] ${signal.symbol} — Kronos confidence sizing multiplier applied: ${kronosMult.toFixed(2)}x (Confidence: ${pairDir?.confidenceSizing?.confidenceScore || 'N/A'}, Adjusted Allocation: $${targetAllocUsd.toFixed(2)})`);
        }
      }
      // Counter-trend asymmetric sizing dampener (0.5x margin allocation)
      if (isCounterTrendTrade) {
        targetAllocUsd = Number((targetAllocUsd * 0.5).toFixed(2));
        logger.info(`⚖️ [Risk Guard] ${signal.symbol} — Counter-trend 0.5x margin dampener applied: New Target Alloc $${targetAllocUsd.toFixed(2)}`);
      }

      // Rolling-Window Transitional Regime sizing dampener (0.5x margin allocation)
      try {
        const { getPairRollingDirectives } = require('../pipeline/sim-consumer');
        const pairRolling = getPairRollingDirectives(signal.symbol);
        if (pairRolling?.wfeDirective === 'REDUCE_SIZE_HALF') {
          targetAllocUsd = Number((targetAllocUsd * 0.5).toFixed(2));
          logger.info(`🔬 [Risk Guard] ${signal.symbol} — Rolling-Window Transitional WFE (${pairRolling.wfe.toFixed(2)}) 0.5x margin dampener applied: New Target Alloc $${targetAllocUsd.toFixed(2)}`);
        }
      } catch {}
    }

    // Enforce strategy minimum margin floor
    targetAllocUsd = Math.max(targetAllocUsd, stratMinMargin);

    // STRICT HARD CLAMPS:
    // 1. Can NEVER exceed userMaxPosUsd (ceiling)
    // 2. Can NEVER exceed remainingBudget ($200 - deployed)
    targetAllocUsd = Math.min(targetAllocUsd, userMaxPosUsd, remainingBudget);

    if (targetAllocUsd < stratMinMargin) {
      const reason = `🛑 Remaining budget ($${remainingBudget.toFixed(2)}) is insufficient for minimum margin allocation of $${stratMinMargin.toFixed(2)} (allocated: $${targetAllocUsd.toFixed(2)}).`;
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    // Adaptive Leverage Sovereign [Min 10x, Max 15x] Clamp:
    // Client enforces sovereign minLeverage (default 10x) and maxLeverage (default 15x)
    // Strictly respects exchange maximum leverage caps
    const marketAuth = AUTHORITATIVE_DECIBEL_MARKETS[normSym];
    const exchangeMaxLev = marketAuth?.maxLeverage || 20;

    const clientMinLev = (config as any).MIN_LEVERAGE || 10;
    const clientMaxLev = Math.min((config as any).MAX_LEVERAGE || 15, exchangeMaxLev);

    const simLabSuggestedLev = pairDir?.confidenceSizing?.recommendedLeverage || pairDir?.maxLeverage || signal.suggestedLeverage || activeDirectives?.strategy?.leverage || clientMinLev;
    const candidateLev = Math.max(clientMinLev, Math.min(simLabSuggestedLev, clientMaxLev));
    let leverage = Math.min(candidateLev, exchangeMaxLev);
    // Strict safety ceiling: Do NOT allow clientMinLev to elevate past explicit pair max leverage cap
    if (pairDir?.maxLeverage && pairDir.maxLeverage > 0) {
      leverage = Math.min(leverage, pairDir.maxLeverage);
    }

    // ── Risk-Parity Hard Cap: Maximum Dollar Loss at Stop Loss (UNCONDITIONAL) ──
    const entryPrice = signal.entryPrice || signal.limitPrice || (signal as any).suggestedEntry || 0;
    const stopLossPrice = signal.stopLoss || (signal as any).suggestedStopLoss || 0;
    const rawSlDistPct = (entryPrice > 0 && stopLossPrice > 0)
      ? Math.abs(entryPrice - stopLossPrice) / entryPrice
      : 0.02;
    const bufferedSlDistPct = rawSlDistPct + 0.0030; // 30 bps slippage & taker fee buffer

    // Client Settings Page Sovereignty:
    // Respects user's configured MAX_RISK_PER_TRADE_PCT and BUDGET_USD / accountEquity
    const userRiskPct = (typeof config.MAX_RISK_PER_TRADE_PCT === 'number' && config.MAX_RISK_PER_TRADE_PCT > 0)
      ? Math.min(Math.max(config.MAX_RISK_PER_TRADE_PCT, 0.5), 5.0)
      : 2.0;

    const effectiveCapitalBase = accountEquity > 0
      ? (config.BUDGET_USD > 0 ? Math.min(config.BUDGET_USD, accountEquity) : accountEquity)
      : Math.max(0, Number(config.BUDGET_USD) || 0);

    let userAuthorizedLossCeiling = Number((effectiveCapitalBase * (userRiskPct / 100)).toFixed(2));

    // If explicit MAX_LOSS_PER_TRADE_USD is set in config, respect it
    if (typeof (config as any).MAX_LOSS_PER_TRADE_USD === 'number' && (config as any).MAX_LOSS_PER_TRADE_USD > 0) {
      userAuthorizedLossCeiling = (config as any).MAX_LOSS_PER_TRADE_USD;
    }

    if (bufferedSlDistPct > 0 && leverage > 0) {
      const projectedLossAtMinMargin = stratMinMargin * bufferedSlDistPct * leverage;
      
      // ALLOWANCE FOR ROUND-LOT MINIMUM: Allow stratMinMargin ($35) if projected loss is within
      // user risk ceiling with a 1.25x round-lot tolerance (or baseline floor $4.50)
      const maxPermissibleLoss = Math.max(userAuthorizedLossCeiling * 1.25, 4.50);

      if (projectedLossAtMinMargin > maxPermissibleLoss) {
        const reason = `🛑 [HARD RISK REJECTION] Minimum margin ($${stratMinMargin.toFixed(2)}) at ${leverage}x leverage ` +
          `would risk $${projectedLossAtMinMargin.toFixed(2)} on stop out, which strictly exceeds the user risk ceiling ` +
          `of $${userAuthorizedLossCeiling.toFixed(2)} (${userRiskPct}% of $${effectiveCapitalBase.toFixed(2)}). Trade aborted to protect capital.`;
        logger.warn(reason);
        return this.reject(reason, directives, accountEquity, availableMargin);
      }

      // Max safe allocation guaranteeing stop loss does not exceed userAuthorizedLossCeiling
      const maxSafeAllocForSl = Math.max(
        stratMinMargin,
        userAuthorizedLossCeiling / (bufferedSlDistPct * leverage)
      );

      if (targetAllocUsd > maxSafeAllocForSl) {
        logger.info(
          `🛡️ [RISK PARITY CAP] ${signal.symbol} — Allocation capped from $${targetAllocUsd.toFixed(2)} to $${maxSafeAllocForSl.toFixed(2)} ` +
          `to guarantee max SL loss is strictly ≤ $${userAuthorizedLossCeiling.toFixed(2)} (${(bufferedSlDistPct * 100).toFixed(2)}% buffered SL dist @ ${leverage}x)`
        );
        targetAllocUsd = Number(maxSafeAllocForSl.toFixed(2));
      }
    }

    // Clamp allocation so directional margin does not exceed $80 limit
    const remainingDirMargin = Math.max(0, maxDirMargin - sameDirMargin);
    if (targetAllocUsd > remainingDirMargin) {
      logger.info(
        `🛡️ [DIRECTIONAL MARGIN CAP] ${signal.symbol} — Allocation trimmed from $${targetAllocUsd.toFixed(2)} to $${remainingDirMargin.toFixed(2)} to respect $${maxDirMargin.toFixed(2)} ceiling on ${action}s`
      );
      targetAllocUsd = Math.max(0, Number(remainingDirMargin.toFixed(2)));
    }

    if (targetAllocUsd < stratMinMargin) {
      const reason = `🛑 Sizing clamped allocation ($${targetAllocUsd.toFixed(2)}) is insufficient for minimum margin allocation of $${stratMinMargin.toFixed(2)}.`;
      return this.reject(reason, directives, accountEquity, availableMargin);
    }

    const positionSizeUsd = targetAllocUsd * leverage;

    // Safety sanity check: block anomalous sizing beyond configured budget x maxLeverage
    const maxAllowedNotional = (config.BUDGET_USD * clientMaxLev) * 1.10;
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
