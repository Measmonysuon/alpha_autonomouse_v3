/**
 * Central Alpha Server / Sim Lab Pipeline Consumer
 * 
 * Periodically pulls client-tailored Alpha Bundles from the Central Alpha Server.
 * Enforces live mainnet financial guardrails and synchronizes:
 *  - Active strategy confidence gates & dynamic score floor
 *  - Market macro regimes & cooling states
 *  - Pair directives, cooldowns & directional bans
 *  - Dynamic portfolio harvester thresholds
 */

import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applySimStrategyDirectives, applySimPairDirectives } from '../strategy/manager';
import { standaloneEngine } from '../engine/standalone-engine';
import { applySimHarvesterCalibration } from '../risk/portfolio-harvester';
import { simConnectionManager } from './connection-manager';
import { superchargeClient } from '../simlab/supercharge-client';
import { hotSwapNodeKey, triggerNodeKeyFailover } from '../utils/node-key-resolver';

export interface AlphaBundleResponse {
  success: boolean;
  status: 'LICENSED' | 'UNLICENSED';
  licenseRequired?: boolean;
  timestamp: number;
  macro: {
    regime: 'TRENDING_BULL' | 'TRENDING_BEAR' | 'RANGING_CHOP' | 'HIGH_VOLATILITY';
    riskMultiplier: number;
    marketCoolingActive: boolean;
    marketBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    coolingReason: string | null;
  };
  strategy?: {
    activeStrategyId: string;
    activeStrategyName: string;
    minConfidenceGate: number;    // e.g. 75 -> 85 during chop
    leverage: number;
    minAllocPct: number;
    maxAllocPct: number;
    minRiskRewardRatio: number;
    tp1CloseRatio: number;
    layer1: any;
    layer2: any;
    layer3: any;
    layer4: any;
    dynamicScoreFloor: number;
  };
  harvester?: {
    active: boolean;
    vulnerabilityHarvestThreshold: number; // Tailored to client equity & regime (e.g. 55-75)
    vulnerabilityRunnerThreshold: number;  // e.g. 35-50
    minHarvestNetPnlPct: number;          // e.g. 1.0% - 2.5%
    minHarvestNetUsd: number;             // Minimum net $ after round-trip taker fees & gas ($0.15 for $30 acc)
    accelerateBreakevenR: number;         // Advance SL to breakeven at 1.0R - 1.5R
    breakevenFeeBufferPct: number;        // e.g. +0.25% fee cover buffer
  };
  pairDirectives: Record<string, {
    symbol: string;
    layer1?: boolean;
    layer2?: boolean;
    layer3?: boolean;
    layer4?: boolean;
    maxLeverage?: number;
    slMultiplier?: number;
    minConfidenceGate?: number;
    bullTrapSensitivity?: 'relaxed' | 'standard' | 'strict';
    upperWickThresholdPct?: number;
    coolOffActive: boolean;
    bannedSide?: 'LONG' | 'SHORT' | 'BOTH';
    reason?: string;
  }>;
  learning: {
    overallWinRatePct: number;
    dynamicScoreFloor: number;
    totalClosedTrades: number;
    shadowVetoAccuracyPct: number;
    actionRecommendations: string[];
  };
}

// ─── Retry State Machine ──────────────────────────────────────────────────────
const RETRY_BASE_MS  = 15_000;   // 15s base poll / first retry interval
const RETRY_MAX_MS   = 300_000;  // 5-minute hard cap
let pollTimer: NodeJS.Timeout | null = null;
let lastSyncedBundle: AlphaBundleResponse | null = null;
let lastSyncTimestamp = 0;
let consecutiveErrors = 0;
let retryDelayMs = RETRY_BASE_MS;
let connectionState: 'CONNECTED' | 'RETRYING' | 'DISCONNECTED' = 'DISCONNECTED';
let isConsumerRunning = false;

/** Returns current Sim Lab connection health for dashboard API */
export function getConnectionState(): 'CONNECTED' | 'RETRYING' | 'DISCONNECTED' {
  return connectionState;
}

/** Returns retry diagnostic info for the dashboard status endpoint */
export function getRetryInfo(): { consecutiveErrors: number; nextRetryMs: number; state: string } {
  return { consecutiveErrors, nextRetryMs: retryDelayMs, state: connectionState };
}

export function getLastSyncTime(): number {
  return lastSyncTimestamp;
}

export function isSimPipelineActive(): boolean {
  return isConsumerRunning && connectionState === 'CONNECTED' && Boolean(lastSyncedBundle && (Date.now() - lastSyncTimestamp < 120000));
}

/**
 * Fetch and apply the latest Alpha Bundle from the central Alpha Server
 */
export async function fetchAlphaBundle(): Promise<AlphaBundleResponse | null> {
  if (!isConsumerRunning || !superchargeClient.isActive()) {
    return null;
  }
  try {
    // Resolve API key: env vars first, then config, then persisted settings.json
    // (supercharge-client stores the token in settings.json when user connects via UI)
    let apiKey = process.env.CLIENT_API_KEY || process.env.SIMLAB_CONNECTION_TOKEN || (config as any).CLIENT_API_KEY || config.SIMLAB_KEY || '';
    if (!apiKey) {
      try {
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.cwd(), 'data/settings.json');
        if (fs.existsSync(settingsPath)) {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          if (settings?.simlab?.key) apiKey = String(settings.simlab.key).trim();
        }
      } catch { /* settings.json unreadable — proceed without */ }
    }

    const headers: Record<string, string> = {
      'X-Client-Id': config.CLIENT_ID,
      'Accept': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    }

    const result = await simConnectionManager.fetchAlphaBundle({ clientId: config.CLIENT_ID }, headers);
    if (!result || !result.data) {
      return null;
    }

    const bundle: AlphaBundleResponse = result.data.bundle || result.data;

    // ── Dynamic Fleet Node Key Synchronization ──────────────────────────────
    const incomingGateway = (result.data as any)?.nodeGateway || (bundle as any)?.nodeGateway;
    if (incomingGateway) {
      if (incomingGateway.activeNodeKey) {
        hotSwapNodeKey(incomingGateway.activeNodeKey);
      } else if (incomingGateway.fallbackToProxy) {
        triggerNodeKeyFailover(undefined, 'Central Alpha server directed builder proxy fallback');
      }
    }

    // ── 1. Timestamp Freshness Guard ──────────────────────────────────────────
    if (bundle.timestamp && typeof bundle.timestamp === 'number') {
      const ageMs = Math.abs(Date.now() - bundle.timestamp);
      if (ageMs > 120_000) {
        logger.warn(
          `⚠️ [SIM PIPELINE] Stale alpha bundle received (${(ageMs / 1000).toFixed(1)}s old > 120s limit). Ignoring payload.`
        );
        return null;
      }
    }

    // ── 2. Intelligence Inheritance Gate ─────────────────────────────────────
    // ALL proprietary intelligence delivery (strategy directives, pair score
    // calibrations, directional bans, breakeven clearances, fee buffers, and
    // harvester thresholds) is ONLY applied after Sim Lab confirms a valid
    // LICENSED connection. Unlicensed clients receive ONLY non-proprietary
    // public macro data (regime, bias, cooling state).
    //
    // Gate logic:
    //   isLicensed = true  → server explicitly confirmed a valid license
    //   isLicensed = false → UNLICENSED, unknown status, or no status field
    //                        Steps 4-6 are BLOCKED; engine gets macro only.
    const isLicensed = bundle.status === 'LICENSED';

    if (!isLicensed) {
      logger.warn(
        `⚠️ [SIM PIPELINE] Intelligence Inheritance BLOCKED — ` +
        `status="${bundle.status ?? 'unknown'}". ` +
        `Connect with a valid CLIENT_API_KEY to unlock proprietary strategy, ` +
        `pair calibrations, and harvester directives.`
      );
      // Apply ONLY public macro data (regime-awareness is non-proprietary).
      // All swarm-inherited intelligence layers (steps 4-6) are hard-blocked.
      if (bundle.macro) {
        standaloneEngine.updateDirectivesFromSimLab({
          regime: bundle.macro.regime,
          notes: `Unlicensed — Standalone mode. Public regime: ${bundle.macro.regime}`,
        });
      }
      lastSyncedBundle = bundle;
      return null;
    }

    // ── 3. Financial Guardrails (Live Mainnet Safety) ──────────────────────────
    const maxLeverageLimit = config.MAX_LEVERAGE || 5;
    const maxAllocLimit = config.MAX_POSITION_ALLOC_PCT || 35;

    const safeLeverage = bundle.strategy?.leverage
      ? Math.min(bundle.strategy.leverage, maxLeverageLimit)
      : maxLeverageLimit;

    const isStarvation = Boolean((bundle.strategy as any)?.starvationModeActive);
    const riskMultiplier = isStarvation ? (Number((bundle.strategy as any)?.recommendedRiskMultiplier) || 0.5) : 1.0;

    const safeMaxAlloc = bundle.strategy?.maxAllocPct
      ? Math.min(Math.round(bundle.strategy.maxAllocPct * riskMultiplier), maxAllocLimit)
      : Math.round(maxAllocLimit * riskMultiplier);

    // ════════════════════════════════════════════════════════════════════════════
    // LICENSED GATE — Steps 4-6 only execute for confirmed LICENSED connections.
    // This is the intelligence inheritance boundary: everything below this line
    // is swarm-inherited proprietary data from Sim Lab Fleet Command.
    // ════════════════════════════════════════════════════════════════════════════

    const flags = superchargeClient.getFeatureFlags();

    // ── 4. Strategy Directives (LICENSED) ──────────────────────────────────────
    // Feature 6: Dynamic Strategy Adaptation + Feature 2: Dynamic Technical Indicators
    if (bundle.strategy && flags.syncStrategyStudio) {
      applySimStrategyDirectives({
        activeStrategyId: bundle.strategy.activeStrategyId,
        activeStrategyName: bundle.strategy.activeStrategyName,
        minConfidenceGate: bundle.strategy.minConfidenceGate,
        leverage: safeLeverage,
        minAllocPct: Math.max(5, Math.round((bundle.strategy.minAllocPct || 15) * riskMultiplier)),
        maxAllocPct: safeMaxAlloc,
        minRiskRewardRatio: bundle.strategy.minRiskRewardRatio,
        tp1CloseRatio: bundle.strategy.tp1CloseRatio,
        layer1: flags.syncIndicators ? bundle.strategy.layer1 : undefined,
        layer2: flags.syncIndicators ? bundle.strategy.layer2 : undefined,
        layer3: flags.syncIndicators ? bundle.strategy.layer3 : undefined,
        layer4: bundle.strategy.layer4,
        dynamicScoreFloor: bundle.strategy.dynamicScoreFloor,
        overallWinRatePct: bundle.learning?.overallWinRatePct,
      });
    }

    // Synchronize Standalone Engine directives according to active feature flags
    const bannedSides: ('LONG' | 'SHORT')[] = [];
    if (flags.syncDirectionalBans) {
      if (bundle.macro?.marketBias === 'BEARISH') {
        bannedSides.push('LONG');
      } else if (bundle.macro?.marketBias === 'BULLISH') {
        bannedSides.push('SHORT');
      }
    }

    const engineUpdates: any = {};
    if (flags.syncStrategyStudio && bundle.strategy) {
      engineUpdates.activeStrategy = bundle.strategy.activeStrategyName || bundle.strategy.activeStrategyId;
      engineUpdates.scoreFloor = bundle.strategy.dynamicScoreFloor || bundle.strategy.minConfidenceGate || (isStarvation ? 65 : 75);
    }
    if (flags.syncMacroRegime && bundle.macro) {
      engineUpdates.regime = bundle.macro.regime || 'TRENDING_BULL';
      engineUpdates.notes = isStarvation
        ? `Starvation Breaker Active (Gate: ${bundle.strategy?.minConfidenceGate}%, Risk: ${riskMultiplier}x)`
        : (bundle.macro.coolingReason || bundle.macro.marketBias || 'Central Alpha Pipeline Synced');
    }
    if (flags.syncDirectionalBans) {
      engineUpdates.bannedSides = bannedSides;
    } else {
      engineUpdates.bannedSides = [];
    }

    if (Object.keys(engineUpdates).length > 0) {
      standaloneEngine.updateDirectivesFromSimLab(engineUpdates);
    }

    // ── 5. Pair Directives & Cooldowns (LICENSED) ──────────────────────────────
    // Inherited: per-pair cooldowns, directional bans, SL multipliers,
    // confidence gate overrides, bull-trap sensitivity calibration.
    if (flags.syncStrategyStudio && bundle.pairDirectives && typeof bundle.pairDirectives === 'object') {
      applySimPairDirectives(bundle.pairDirectives);
    }

    // ── 6. Harvester Profile (LICENSED) ────────────────────────────────────────
    // Inherited: breakeven clearance R-level, fee buffer %, vulnerability
    // harvest threshold, runner threshold, minimum net PnL gate.
    if (bundle.harvester) {
      applySimHarvesterCalibration(bundle.harvester);
    }

    // Cache latest bundle in superchargeClient for Feature 4: Counterfactual Shadow Advisory
    superchargeClient.updateLastBundle(bundle);

    const urlUsed = result.urlUsed;
    lastSyncedBundle = bundle;
    lastSyncTimestamp = Date.now();
    consecutiveErrors = 0;

    // ── Success: Reset retry state ————————————————————————————
    const wasRetrying = connectionState !== 'CONNECTED';
    connectionState = 'CONNECTED';
    retryDelayMs = RETRY_BASE_MS;

    const regime = bundle.macro?.regime || 'ACTIVE';
    const harvesterGate = bundle.harvester?.vulnerabilityHarvestThreshold ?? 'N/A';
    if (wasRetrying) {
      logger.info(
        `✅ [SIM PIPELINE] Reconnected to Sim Lab! Source: ${urlUsed} (Regime: ${regime}, Harvester Gate: ${harvesterGate})`
      );
    } else {
      logger.info(
        `📥 [SIM PIPELINE] Alpha bundle synced from ${urlUsed} (Regime: ${regime}, Harvester Gate: ${harvesterGate})`
      );
    }

    return bundle;
  } catch (err: any) {
    consecutiveErrors++;

    // ── Failure: Advance retry state ————————————————————————
    connectionState = consecutiveErrors >= 3 ? 'DISCONNECTED' : 'RETRYING';
    // Exponential backoff: 15s → 30s → 60s → 120s → 300s (cap)
    retryDelayMs = Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(0, consecutiveErrors - 1)), RETRY_MAX_MS);

    if (consecutiveErrors <= 3 || consecutiveErrors % 10 === 0) {
      logger.warn(
        `⏳ [SIM PIPELINE] Disconnected. Retrying in ${(retryDelayMs / 1000).toFixed(0)}s (attempt ${consecutiveErrors}): ${err.message}`
      );
    }
    return null;
  }
}

/**
 * Starts the Alpha Bundle consumer with adaptive exponential-backoff retry.
 *
 * Behaviour:
 *  - On success  : schedules next fetch in RETRY_BASE_MS (15s) — back to normal cadence.
 *  - On failure  : doubles the interval each attempt (15s → 30s → 60s → 120s → 300s cap).
 *  - State machine: CONNECTED | RETRYING | DISCONNECTED exposed via getConnectionState().
 */
export function startSimPipelineConsumer(): void {
  if (isConsumerRunning) return; // Guard against double-start
  isConsumerRunning = true;
  retryDelayMs = RETRY_BASE_MS;
  connectionState = 'RETRYING';

  logger.info(`📡 [SIM PIPELINE] Starting Alpha Bundle consumer (base interval: ${RETRY_BASE_MS / 1000}s, max backoff: ${RETRY_MAX_MS / 1000}s)`);

  /** Self-rescheduling fetch loop */
  async function scheduledFetch(): Promise<void> {
    if (!isConsumerRunning) return; // Stopped externally

    await fetchAlphaBundle().catch(() => {});

    if (!isConsumerRunning) return; // Stopped during async fetch

    // Schedule next tick using the current retryDelayMs (reset on success, grown on failure)
    pollTimer = setTimeout(scheduledFetch, retryDelayMs) as unknown as NodeJS.Timeout;
  }

  // Kick off immediately
  scheduledFetch();
}

/**
 * Stops the consumer and resets all retry state.
 * Also reverts the engine to pure standalone directives so that no stale
 * inherited intelligence (breakeven clearances, score floors, pair bans)
 * continues to influence live trades after Sim Lab disconnects.
 */
export function stopSimPipelineConsumer(): void {
  isConsumerRunning = false;
  connectionState = 'DISCONNECTED';
  lastSyncedBundle = null;
  lastSyncTimestamp = 0;
  if (pollTimer) {
    clearTimeout(pollTimer as unknown as ReturnType<typeof setTimeout>);
    clearInterval(pollTimer); // Safety: clear in case legacy interval was set
    pollTimer = null;
    logger.info('🛑 [SIM PIPELINE] Alpha Bundle consumer stopped. Retry state cleared.');
  }
  // Revert engine to standalone defaults so no stale Sim Lab intelligence
  // persists in the trading engine after disconnection
  try {
    standaloneEngine.resetToStandaloneDirectives('Sim Lab pipeline stopped — reverting to standalone local directives');
  } catch { /* engine may not be initialized yet on first start */ }
  try {
    const { resetSimLabOverrides } = require('../strategy/manager');
    resetSimLabOverrides();
  } catch {}
}

/**
 * Get last successfully synced bundle
 */
export function getLastSyncedBundle(): AlphaBundleResponse | null {
  return lastSyncedBundle;
}
