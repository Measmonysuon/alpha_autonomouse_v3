/**
 * Sim Lab AI Cloud Supercharge Plugin
 * 
 * Optional plug-and-play connector to Sim Lab (cloud https://simlab.measmony.me or localhost:4000).
 * Decodes base64url token `simlab_live_...`, pairs client with Sim Lab, syncs live macro
 * directives, and feeds 8-second telemetry back to Fleet Command.
 * 
 * Zero-Interruption Failover:
 * If Sim Lab disconnects or returns 403, the client NEVER halts—it immediately drops back
 * into Pure Standalone Mode seamlessly.
 */

import axios from 'axios';
import { config, watchPairs, isClientConfigured, DEFAULT_SIMLAB_CANDIDATE_URLS } from '../config';
import { logger } from '../utils/logger';
import { standaloneEngine, StrategyDirectives } from '../engine/standalone-engine';
import { tradeExecutor } from '../trades/executor';
import { portfolioHarvester } from '../engine/harvester';
import {
  applySimStrategyDirectives,
  applySimPairDirectives,
  updateStrategySyncConfig,
  clearSimStrategyDirectives,
} from '../strategy/manager';

export interface SimLabTokenPayload {
  v: number;        // version (e.g. 1)
  s: string;        // serverUrl (e.g. "https://simlab.measmony.me" or "http://127.0.0.1:4000")
  k: string;        // keyId
  sec: string;      // secret token
}

export interface SimLabFeatureFlags {
  syncMacroRegime: boolean;
  syncIndicators: boolean;
  syncDirectionalBans: boolean;
  syncCounterfactual: boolean;
  syncTelemetry: boolean;
  syncStrategyStudio: boolean;
}

export interface PairingResponse {
  success: boolean;
  message?: string;
  clientId?: string;
  directives?: {
    activeStrategy?: string;
    scoreFloor?: number;
    bullTrapUpperWickPct?: number;
    bannedSides?: ('LONG' | 'SHORT')[];
    regime?: string;
  };
}

export interface HeartbeatPayload {
  token: string;
  keyId?: string;
  clientName: string;
  subaccountAddress: string;
  operatingMode: 'STANDALONE' | 'SIMLAB_SUPERCHARGED';
  paperTrading: boolean;
  budgetUsd: number;
  totalTrades: number;
  winRate: number;
  totalPnlUsd: number;
  openPositionsCount: number;
  openPositions: any[];
  timestamp: number;
}

export class SimLabSuperchargeClient {
  private isEnabled = false;
  private isConnected = false;
  private serverUrl = '';
  private keyId = '';
  private secret = '';
  private rawToken = '';
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private featureFlags: SimLabFeatureFlags = {
    syncMacroRegime: true,
    syncIndicators: true,
    syncDirectionalBans: true,
    syncCounterfactual: true,
    syncTelemetry: true,
    syncStrategyStudio: true,
  };
  private lastBundleLearning: any = null;

  constructor() {
    this.loadPersistentConfig();
    if (!this.rawToken) {
      this.rawToken = config.SIMLAB_KEY ? config.SIMLAB_KEY.trim() : '';
    }

    // Default to Jetson or configured URL if none set
    if (!this.serverUrl) {
      this.serverUrl = (config.SIMLAB_SERVER_URL || 'https://simlab.measmony.me').replace(/\/+$/, '');
    }

    if (!this.rawToken) {
      logger.info(`📡 [SIM LAB TELEMETRY] Continuous pipeline target: ${this.serverUrl} (Streaming real on-chain data)`);
    } else if (this.rawToken.startsWith('simlab_live_')) {
      const decoded = this.decodeToken(this.rawToken);
      if (decoded) {
        if (!config.SIMLAB_SERVER_URL && decoded.s) {
          this.serverUrl = decoded.s.replace(/\/+$/, '');
        }
        this.keyId = decoded.k;
        this.secret = decoded.sec;
        this.isEnabled = true;
        logger.info(`⚡ [SIM LAB] Supercharge Key detected for ${this.serverUrl} (Key ID: ${this.keyId})`);
      }
    }

    // Always initialize background real on-chain telemetry pipeline
    this.startPipelineTelemetry();
  }

  private loadPersistentConfig(): void {
    try {
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.cwd(), 'data/settings.json');
      if (fs.existsSync(settingsPath)) {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (parsed.simlab) {
          if (parsed.simlab.url) this.serverUrl = String(parsed.simlab.url).trim().replace(/\/+$/, '');
          if (parsed.simlab.key) this.rawToken = parsed.simlab.key;
          if (parsed.simlab.features) {
            this.featureFlags = { ...this.featureFlags, ...parsed.simlab.features };
          }
        }
      }
    } catch {}

    if (!this.serverUrl) {
      this.serverUrl = (config.SIMLAB_SERVER_URL || 'https://simlab.measmony.me').replace(/\/+$/, '');
    }
  }

  public getFeatureFlags(): SimLabFeatureFlags {
    return { ...this.featureFlags };
  }

  public updateFeatureFlags(flags: Partial<SimLabFeatureFlags>, customUrl?: string): void {
    this.featureFlags = { ...this.featureFlags, ...flags };
    if (customUrl) {
      this.serverUrl = customUrl.trim().replace(/\/+$/, '');
    }

    // ── Feature 6: Dynamic Strategy Adaptation Synchronizer ──
    if (typeof flags.syncStrategyStudio === 'boolean') {
      updateStrategySyncConfig({
        syncGlobalStrategy: flags.syncStrategyStudio,
        syncPairOverrides: flags.syncStrategyStudio,
      });
      if (!flags.syncStrategyStudio) {
        clearSimStrategyDirectives();
        logger.info('🔓 [DYNAMIC STRATEGY ADAPTATION] Disabled by user — 100% manual control active for global and pair strategies.');
      } else {
        logger.info('⚡ [DYNAMIC STRATEGY ADAPTATION] Enabled by user — Sim Lab will dynamically adapt global and pair strategies.');
      }
    }

    // ── Feature 3: Pair Directional Bans & Cooldowns Synchronizer ──
    if (flags.syncDirectionalBans === false) {
      standaloneEngine.updateDirectivesFromSimLab({ bannedSides: [] });
      logger.info('🔓 [DIRECTIONAL BANS] Directional bans disabled by user — all trading sides unblocked.');
    }

    // ── Feature 1: Macro Market Regime Sync Synchronizer ──
    if (flags.syncMacroRegime === false) {
      standaloneEngine.updateDirectivesFromSimLab({ regime: 'ACTIVE_STANDALONE', notes: 'Sim Lab Macro Market Regime Sync disabled' });
      logger.info('🔓 [MACRO REGIME] Macro Market Regime Sync disabled by user — standalone market regime active.');
    }

    // Persist to data/settings.json
    try {
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.cwd(), 'data/settings.json');
      let current: any = {};
      if (fs.existsSync(settingsPath)) {
        current = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      current.simlab = {
        ...(current.simlab || {}),
        url: this.serverUrl,
        key: this.rawToken,
        features: this.featureFlags,
      };
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2), 'utf8');
    } catch {}
  }

  public async pingTest(targetUrl?: string, apiKey?: string): Promise<{ success: boolean; url: string; status?: string; uptime?: number; regime?: string; message?: string }> {
    const cleanUrl = (targetUrl || this.serverUrl || 'https://simlab.measmony.me').trim().replace(/\/+$/, '');
    const key = (apiKey !== undefined ? apiKey : this.rawToken).trim();
    if (!key) {
      return {
        success: false,
        url: cleanUrl,
        message: 'Sim Lab API Key is required. Please provide an API key or pairing token before testing connection (required even for local testing).',
      };
    }
    try {
      // 1. Probe /api/pipeline/alpha-bundle with API key
      const bundle = await axios.get(`${cleanUrl}/api/pipeline/alpha-bundle`, {
        headers: {
          'Authorization': `Bearer ${key}`,
          'x-api-key': key,
          'x-client-id': config.CLIENT_ID || 'desk-04-macstudio',
        },
        timeout: 4000,
      }).catch((err) => err.response || null);

      if (bundle && bundle.status === 200 && bundle.data) {
        if (bundle.data.success === false) {
          return {
            success: false,
            url: cleanUrl,
            message: 'Authentication Failed: Sim Lab server rejected this API Key.',
          };
        }
        const regime = bundle.data?.macroIntelligence?.decouplingRegime || bundle.data?.macro?.regime || 'Active';
        return {
          success: true,
          url: cleanUrl,
          status: 'Authenticated & Online',
          regime,
        };
      }

      // 2. Probe /health
      const health = await axios.get(`${cleanUrl}/health`, { timeout: 4000 }).catch(() => null);
      if (health && health.status === 200) {
        return {
          success: true,
          url: cleanUrl,
          status: health.data?.status || 'OK',
          uptime: health.data?.uptime,
          regime: 'Connected (Host Reachable)',
        };
      }

      return {
        success: false,
        url: cleanUrl,
        message: 'Endpoint did not return HTTP 200',
      };
    } catch (err: any) {
      return {
        success: false,
        url: cleanUrl,
        message: err.message,
      };
    }
  }

  public async connectWithKey(token: string, customUrl?: string): Promise<{ success: boolean; message: string }> {
    const clean = (token || '').trim();
    if (!clean) {
      this.disconnect();
      return {
        success: false,
        message: 'Sim Lab API Key is required. Please provide a valid API key or pairing token before connecting (required even for local testing).',
      };
    }

    if (customUrl) {
      this.serverUrl = customUrl.trim().replace(/\/+$/, '');
    }
    if (!this.serverUrl) {
      this.serverUrl = (config.SIMLAB_SERVER_URL || 'https://simlab.measmony.me').replace(/\/+$/, '');
    }

    if (clean.startsWith('simlab_live_')) {
      const decoded = this.decodeToken(clean);
      if (decoded) {
        this.rawToken = clean;
        this.keyId = decoded.k;
        this.secret = decoded.sec;
        if (!customUrl && decoded.s) {
          this.serverUrl = decoded.s.replace(/\/+$/, '');
        }
      } else {
        return {
          success: false,
          message: 'Malformed Sim Lab pairing token. Token must be valid base64url starting with simlab_live_',
        };
      }
    } else {
      this.rawToken = clean;
      this.secret = clean;
      this.keyId = clean;
    }

    this.isEnabled = true;
    this.updateFeatureFlags({}, this.serverUrl);

    const connected = await this.connect();
    return {
      success: connected,
      message: connected
        ? `Successfully connected & authenticated with Sim Lab at ${this.serverUrl}`
        : `Authentication failed at ${this.serverUrl}. Please ensure your API key is valid and authorized by Sim Lab.`,
    };
  }

  public disconnect(): void {
    this.isEnabled = false;
    this.isConnected = false;
    this.rawToken = '';
    this.keyId = '';
    this.secret = '';
    this.lastBundleLearning = null;
    config.OPERATING_MODE = 'STANDALONE';
    try {
      const { stopSimPipelineConsumer } = require('../pipeline/sim-consumer');
      stopSimPipelineConsumer();
    } catch {}
    try {
      const { resetSimLabOverrides } = require('../strategy/manager');
      resetSimLabOverrides();
    } catch {}
    standaloneEngine.resetToStandaloneDirectives('User disconnected Sim Lab');
    this.updateFeatureFlags({}, this.serverUrl);
  }

  public configureToken(token: string): boolean {
    const cleanToken = (token || '').trim();
    if (!cleanToken.startsWith('simlab_live_')) {
      return false;
    }
    const decoded = this.decodeToken(cleanToken);
    if (!decoded) return false;

    this.rawToken = cleanToken;
    this.serverUrl = (config.SIMLAB_SERVER_URL || decoded.s || 'https://simlab.measmony.me').replace(/\/+$/, '');
    this.keyId = decoded.k;
    this.secret = decoded.sec;
    this.isEnabled = true;
    return true;
  }

  public isActive(): boolean {
    return this.isConnected && Boolean(this.rawToken && this.rawToken.trim());
  }

  public getRawToken(): string {
    return this.rawToken;
  }

  public getServerUrl(): string {
    return this.serverUrl || 'https://simlab.measmony.me';
  }

  /**
   * Decodes a base64url token payload
   */
  public decodeToken(token: string): SimLabTokenPayload | null {
    try {
      const stripped = token.replace(/^simlab_live_/, '');
      // Handle base64url padding
      let base64 = stripped.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4 !== 0) {
        base64 += '=';
      }
      const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
      const parsed = JSON.parse(jsonStr);
      if (parsed && parsed.s && parsed.k && parsed.sec) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Connects to Sim Lab and establishes pairing & heartbeat.
   * STRICT REQUIREMENT: API Key is required for connection, even for local test instances.
   */
  public async connect(): Promise<boolean> {
    if (!this.isEnabled) {
      this.isConnected = false;
      return false;
    }

    if (!this.rawToken || !this.rawToken.trim()) {
      logger.warn('⚠️ [SIM LAB] Connection aborted: API key is required even for local testing.');
      this.isConnected = false;
      this.isEnabled = false;
      standaloneEngine.resetToStandaloneDirectives('Sim Lab API key required');
      return false;
    }

    logger.info(`📡 [SIM LAB] Connecting to Sim Lab at ${this.serverUrl} with API key (${this.rawToken.slice(0, 10)}...)...`);

    // 1. Try token pairing if token is provided
    if (this.rawToken.startsWith('simlab_live_')) {
      try {
        const payload = {
          token: this.rawToken,
          keyId: this.keyId,
          clientId: config.CLIENT_ID || 'desk-04-macstudio',
          clientName: config.CLIENT_NAME,
          subaccountAddress: config.DECIBEL_SUBACCOUNT_ADDRESS,
          delegateAddress: config.DECIBEL_OWNER_ADDRESS || '0x_delegate',
          budgetUsd: config.BUDGET_USD,
          paperTrading: config.PAPER_TRADING,
          network: config.NETWORK,
          timestamp: Date.now(),
        };

        const res = await axios.post<PairingResponse>(
          `${this.serverUrl}/api/clients/pair-by-token`,
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
              'X-SimLab-Client-Auth': this.secret,
              'x-api-key': this.rawToken,
            },
            timeout: 8000,
          },
        );

        if (res.data && res.data.success) {
          this.isConnected = true;
          config.OPERATING_MODE = 'SIMLAB_SUPERCHARGED';
          this.consecutiveFailures = 0;
          logger.info('⚡ [SIM LAB SUPERCHARGED] Token paired! Strategy directives synchronized.');
          const dirs = res.data.directives || (res.data as any).calibratedDirectives;
          if (dirs) {
            this.applyDirectives(dirs);
          }
          this.startHeartbeat();
          return true;
        } else {
          logger.warn(`⚠️ [SIM LAB] Token rejected by server: ${res.data?.message || 'Unauthorized'}`);
          this.isConnected = false;
          return false;
        }
      } catch (err: any) {
        const errDetail = err.response?.data?.error || err.message;
        logger.warn(`⚠️ [SIM LAB] Token pair failed at ${this.serverUrl}: ${errDetail}`);
      }
    }

    // 2. Direct pipeline connection with API Key authentication headers
    try {
      const bundleRes = await axios.get(`${this.serverUrl}/api/pipeline/alpha-bundle`, {
        headers: {
          'Authorization': `Bearer ${this.rawToken}`,
          'x-api-key': this.rawToken,
          'x-client-id': config.CLIENT_ID || 'desk-04-macstudio',
        },
        timeout: 6000,
      }).catch((err) => err.response || null);

      if (bundleRes && bundleRes.status === 200 && bundleRes.data) {
        if (bundleRes.data.success === true || bundleRes.data.license) {
          this.isConnected = true;
          config.OPERATING_MODE = 'SIMLAB_SUPERCHARGED';
          this.consecutiveFailures = 0;
          logger.info(`⚡ [SIM LAB SUPERCHARGED] Authenticated pipeline connected to ${this.serverUrl}!`);
          this.applyBundleDirectives(bundleRes.data);
          this.startHeartbeat();
          return true;
        } else if (bundleRes.data.success === false) {
          logger.warn(`⚠️ [SIM LAB] API Key unauthorized by Sim Lab licensing gate at ${this.serverUrl}.`);
          this.isConnected = false;
          return false;
        }
      }
    } catch (err: any) {
      logger.warn(`⚠️ [SIM LAB] Primary server unreachable at ${this.serverUrl}: ${err.message}`);
    }

    // 3. Fallback candidate probing (Cloud VPS, Domain, or LAN) with API Key
    const fallbackCandidates = (DEFAULT_SIMLAB_CANDIDATE_URLS || []).filter((u) => u && u !== this.serverUrl);
    for (const cand of fallbackCandidates) {
      try {
        const bundleRes = await axios.get(`${cand}/api/pipeline/alpha-bundle`, {
          headers: {
            'Authorization': `Bearer ${this.rawToken}`,
            'x-api-key': this.rawToken,
            'x-client-id': config.CLIENT_ID || 'desk-04-macstudio',
          },
          timeout: 3500,
        }).catch(() => null);

        if (bundleRes && bundleRes.status === 200 && bundleRes.data && (bundleRes.data.success === true || bundleRes.data.license)) {
          this.serverUrl = cand;
          this.isConnected = true;
          this.consecutiveFailures = 0;
          logger.info(`⚡ [SIM LAB SUPERCHARGED] Auto-resolved active Sim Lab candidate at ${cand}!`);
          this.applyBundleDirectives(bundleRes.data);
          this.startHeartbeat();
          return true;
        }
      } catch {}
    }

    this.isConnected = false;
    standaloneEngine.resetToStandaloneDirectives('Sim Lab authentication failed or server unreachable');
    return false;
  }

  public updateLastBundle(bundle: any): void {
    if (bundle?.learning) {
      this.lastBundleLearning = bundle.learning;
    }
  }

  /**
   * Feature 4: Counterfactual Shadow Advisory Check
   * Compares planned trade signals against Sim Lab parallel paper simulation models in real time.
   * If a signal generated negative EV (<35% WR or cooldown recommendation), entry is vetoed.
   */
  public checkCounterfactualAdvisory(symbol: string, action: 'LONG' | 'SHORT'): { vetoed: boolean; reason?: string } {
    if (!this.featureFlags.syncCounterfactual || !this.isActive()) {
      return { vetoed: false };
    }

    const norm = (symbol || '').toUpperCase();
    const l = this.lastBundleLearning;
    if (!l) return { vetoed: false };

    // 1. Check asset learning win-rate & expectancy from simulation models
    const assetAdj = l.assetAdjustments?.[norm] || l.assetAdjustments?.[symbol];
    if (assetAdj) {
      const wr = typeof assetAdj.winRatePct === 'number' ? assetAdj.winRatePct : (typeof assetAdj.winRate === 'number' ? assetAdj.winRate : null);
      if (typeof wr === 'number' && wr < 35 && (assetAdj.totalTrades || 0) >= 3) {
        return {
          vetoed: true,
          reason: `Sim Lab Counterfactual Advisory: ${norm} historical simulation win-rate is toxic (${wr.toFixed(1)}% < 35% EV threshold). Entry vetoed to protect equity.`,
        };
      }
      if (assetAdj.status === 'COOLDOWN_ADVISED' || assetAdj.status === 'BANNED') {
        return {
          vetoed: true,
          reason: `Sim Lab Counterfactual Advisory: Asset cooldown advised for ${norm} by fleet paper simulations.`,
        };
      }
    }

    // 2. Check actionRecommendations from Sim Lab simulation engine
    if (Array.isArray(l.actionRecommendations)) {
      const rec = l.actionRecommendations.find((r: string) =>
        r && typeof r === 'string' && r.includes(norm) && (r.includes('COOLDOWN') || r.includes('toxic') || r.includes('veto') || r.includes('0%'))
      );
      if (rec) {
        return {
          vetoed: true,
          reason: `Sim Lab Counterfactual Advisory: ${rec}`,
        };
      }
    }

    return { vetoed: false };
  }

  public applyBundleDirectives(bundle: any): void {
    if (!bundle) return;
    const sanitized: Partial<StrategyDirectives> = {};

    // ── Feature 1: Macro Market Regime Sync ──────────────────────────────────────
    if (this.featureFlags.syncMacroRegime) {
      const macroRegime = bundle.macro?.regime || bundle.macroIntelligence?.decouplingRegime;
      if (macroRegime) {
        sanitized.regime = String(macroRegime);
      }
      if (bundle.macroIntelligence?.worldStateSummary || bundle.macro?.summary) {
        sanitized.notes = bundle.macroIntelligence?.worldStateSummary || bundle.macro?.summary;
      }
    }

    // ── Feature 2: Dynamic Technical Indicators ─────────────────────────────────
    if (this.featureFlags.syncIndicators) {
      const scoreFloor = bundle.strategy?.dynamicScoreFloor || bundle.strategy?.minConfidenceGate;
      if (typeof scoreFloor === 'number') {
        sanitized.scoreFloor = scoreFloor;
      }
      const wickTol = bundle.strategy?.bullTrapUpperWickPct || bundle.macroIntelligence?.bullTrapUpperWickPct;
      if (typeof wickTol === 'number') {
        sanitized.bullTrapUpperWickPct = wickTol;
      }
    }

    // ── Feature 3: Pair Directional Bans & Cooldowns ─────────────────────────────
    if (this.featureFlags.syncDirectionalBans) {
      // Prefer explicit bannedSide field, fall back to marketBias
      const rawBanned = bundle.macroIntelligence?.bannedSide || bundle.macro?.bannedSide;
      const marketBias = bundle.macro?.marketBias;
      if (rawBanned) {
        const side = String(rawBanned).toUpperCase();
        if (side === 'LONG' || side === 'SHORT') {
          sanitized.bannedSides = [side as 'LONG' | 'SHORT'];
        } else if (side === 'NONE' || side === 'CLEAR') {
          sanitized.bannedSides = [];
        }
      } else if (marketBias) {
        if (marketBias === 'BEARISH') sanitized.bannedSides = ['LONG'];
        else if (marketBias === 'BULLISH') sanitized.bannedSides = ['SHORT'];
      }
    } else {
      sanitized.bannedSides = [];
    }

    // ── Feature 6: Dynamic Strategy Adaptation ──────────────────────────────────
    if (this.featureFlags.syncStrategyStudio && bundle.strategy) {
      const stratName = bundle.strategy.activeStrategyName || bundle.strategy.activeStrategyId;
      if (stratName) {
        sanitized.activeStrategy = String(stratName);
      }
      applySimStrategyDirectives({
        activeStrategyId: bundle.strategy.activeStrategyId,
        activeStrategyName: bundle.strategy.activeStrategyName,
        minConfidenceGate: bundle.strategy.minConfidenceGate,
        leverage: bundle.strategy.leverage,
        minAllocPct: bundle.strategy.minAllocPct,
        maxAllocPct: bundle.strategy.maxAllocPct,
        minRiskRewardRatio: bundle.strategy.minRiskRewardRatio,
        tp1CloseRatio: bundle.strategy.tp1CloseRatio,
        layer1: this.featureFlags.syncIndicators ? bundle.strategy.layer1 : undefined,
        layer2: this.featureFlags.syncIndicators ? bundle.strategy.layer2 : undefined,
        layer3: this.featureFlags.syncIndicators ? bundle.strategy.layer3 : undefined,
        layer4: bundle.strategy.layer4,
        dynamicScoreFloor: bundle.strategy.dynamicScoreFloor,
        overallWinRatePct: bundle.learning?.overallWinRatePct,
      });

      if (bundle.pairDirectives && typeof bundle.pairDirectives === 'object') {
        applySimPairDirectives(bundle.pairDirectives);
      }
    }

    // Cache learning bundle for Feature 4: Counterfactual Shadow Advisory
    if (bundle.learning) {
      this.lastBundleLearning = bundle.learning;
    }

    standaloneEngine.updateDirectivesFromSimLab(sanitized);
  }

  private applyDirectives(directives: any): void {
    const sanitized: Partial<StrategyDirectives> = {};

    if (this.featureFlags.syncStrategyStudio && directives.activeStrategy) {
      sanitized.activeStrategy = String(directives.activeStrategy);
    }
    if (this.featureFlags.syncIndicators) {
      if (typeof directives.scoreFloor === 'number') sanitized.scoreFloor = directives.scoreFloor;
      if (typeof directives.bullTrapUpperWickPct === 'number') sanitized.bullTrapUpperWickPct = directives.bullTrapUpperWickPct;
    }
    if (this.featureFlags.syncDirectionalBans && Array.isArray(directives.bannedSides)) {
      sanitized.bannedSides = directives.bannedSides;
    } else {
      sanitized.bannedSides = [];
    }
    if (this.featureFlags.syncMacroRegime && directives.regime) {
      sanitized.regime = String(directives.regime);
    }

    standaloneEngine.updateDirectivesFromSimLab(sanitized);
  }

  /**
   * Starts continuous real on-chain telemetry pipeline streaming to Sim Lab.
   * Runs whether client is paired/supercharged or operating in pure Standalone mode.
   */
  public startPipelineTelemetry(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    // Initial immediate heartbeat telemetry
    this.sendHeartbeat().catch(() => {});

    // Every 6,000 ms continuous pipeline stream
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat().catch(() => {});
    }, 6000);
  }

  private startHeartbeat(): void {
    this.startPipelineTelemetry();
  }

  /**
   * Assembles and sends comprehensive real on-chain telemetry to Sim Lab.
   * Pulls live on-chain balance, Aptos coin amount, Decibel subaccount collateral,
   * open positions, execution trade fills, portfolio metrics, and active strategy state.
   */
  public async sendHeartbeat(telemetryData?: any): Promise<void> {
    if (!this.serverUrl) return;

    // 1. Fetch live real on-chain balance & margin
    let onChainEquity = 0;
    let onChainMargin = 0;
    let aptBalance = 0;
    try {
      if (isClientConfigured()) {
        const onChain = await tradeExecutor.fetchOnChainBalance();
        onChainEquity = onChain.balanceUsd;
        aptBalance = onChain.aptBalance;
      }
    } catch {}

    // 2. Fetch real on-chain positions, execution history, and harvester state
    await tradeExecutor.syncOnChainPositions().catch(() => {});
    const openTrades = tradeExecutor.getOpenTrades();
    const closedTrades = tradeExecutor.getClosedTrades();
    const stats = tradeExecutor.getStats();
    onChainMargin = Math.max(0, onChainEquity - (stats.budgetUsedUsd || 0));
    const directives = standaloneEngine.getDirectives();
    const harvesterState = portfolioHarvester.evaluate({});

    const realSignerAddress = tradeExecutor.getSignerAddress();
    const cleanSubaccount = (config.DECIBEL_SUBACCOUNT_ADDRESS && !config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_'))
      ? config.DECIBEL_SUBACCOUNT_ADDRESS
      : '';
    const cleanOwner = realSignerAddress || ((config.DECIBEL_OWNER_ADDRESS && !config.DECIBEL_OWNER_ADDRESS.includes('your_'))
      ? config.DECIBEL_OWNER_ADDRESS
      : '');

    const payload = {
      // ── Client & Routing Identity ──
      token: this.rawToken,
      keyId: this.keyId,
      clientId: config.CLIENT_ID || (cleanSubaccount ? `alpha_client_${cleanSubaccount.slice(0, 10)}` : 'desk-01-jetson'),
      clientName: config.CLIENT_NAME || 'ALPHA AUTONOMOUS TRADER',
      clientVersion: '1.0.0',
      operatingMode: this.isConnected ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
      isSimLabConnected: this.isConnected,
      timestamp: Date.now(),

      // ── Real On-Chain Wallet & Account Collateral ──
      onChain: {
        subaccountAddress: cleanSubaccount,
        ownerAddress: cleanOwner,
        gasFeeAddress: realSignerAddress || cleanOwner,
        signerAddress: realSignerAddress || cleanOwner,
        network: config.NETWORK || 'mainnet',
        balanceUsd: onChainEquity,
        aptBalance: aptBalance,
        accountEquityUsd: onChainEquity,
        availableMarginUsd: onChainMargin,
        budgetCeilingUsd: config.BUDGET_USD || 30,
        budgetUsedUsd: stats.budgetUsedUsd || 0,
        budgetAvailableUsd: Math.max(0, (config.BUDGET_USD || 30) - (stats.budgetUsedUsd || 0)),
        paperTrading: config.PAPER_TRADING,
        isConfigured: isClientConfigured(),
      },

      // ── Real On-Chain Open Positions with Dynamic SL/TP ──
      openPositionsCount: openTrades.length,
      openPositions: openTrades.map((t) => {
        const hPos = harvesterState.positions[t.symbol];
        return {
          id: t.id,
          symbol: t.symbol,
          side: t.side,
          action: t.action,
          sizeUsd: t.sizeUsd,
          sizeBase: t.sizeBase,
          entryPrice: t.entryPrice,
          currentPrice: t.exitPrice || t.entryPrice,
          unrealizedPnlUsd: t.pnlUsd || 0,
          unrealizedPnlPct: t.pnlPct || 0,
          leverage: t.leverage,
          takeProfit: t.takeProfit,
          stopLoss: t.stopLoss,
          dynamicTakeProfit: hPos?.dynamicTakeProfit || t.takeProfit,
          dynamicStopLoss: hPos?.dynamicStopLoss || t.stopLoss,
          distanceToTpPct: hPos?.distanceToTpPct || 0,
          distanceToSlPct: hPos?.distanceToSlPct || 0,
          breakevenLocked: hPos?.breakevenLocked || false,
          riskRewardRatio: hPos?.riskRewardRatio || 1.67,
          txHash: t.txHash || '',
          orderId: t.orderId || '',
          status: t.status,
          isPaper: t.isPaper,
          openedAt: t.openedAt,
        };
      }),

      // ── Real Executed Trades / Recent Fills ──
      recentTrades: closedTrades.slice(-20).map((t) => ({
        id: t.id,
        symbol: t.symbol,
        action: t.action,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        pnlUsd: t.pnlUsd || 0,
        pnlPct: t.pnlPct || 0,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        closeReason: t.status,
        txHash: t.txHash || '',
        isPaper: t.isPaper,
      })),

      // ── Portfolio & Execution Statistics ──
      stats: {
        totalTrades: stats.totalTrades,
        openTradesCount: stats.openTradesCount,
        closedTradesCount: stats.closedTradesCount,
        winningTrades: stats.wins,
        losingTrades: stats.losses,
        winRate: stats.winRate,
        totalPnlUsd: stats.totalPnlUsd,
        budgetUsedUsd: stats.budgetUsedUsd,
        budgetAvailableUsd: stats.budgetAvailableUsd,
      },

      // ── Portfolio Harvester & Dynamic Trailing Risk Engine ──
      portfolioHarvester: harvesterState,
      dynamicRisk: {
        harvesterEnabled: harvesterState.config.enabled,
        syncMode: harvesterState.config.syncMode,
        harvestScoreThreshold: harvesterState.config.harvestScoreThreshold,
        accelerateBreakevenR: harvesterState.config.accelerateBreakevenR,
        minHarvestPct: harvesterState.config.minHarvestPct,
        totalNetPnlUsd: harvesterState.totalNetPnlUsd,
        status: harvesterState.status,
        positions: harvesterState.positions,
      },

      // ── Counterfactual Shadow Trades (Veto Audit & Trap Shield) ──
      shadowTrades: tradeExecutor.getShadowTrades().slice(-30).map((st) => ({
        id: st.id,
        symbol: st.symbol,
        action: st.action,
        entryPrice: st.entryPrice,
        takeProfit: st.takeProfit,
        stopLoss: st.stopLoss,
        confidence: st.confidence,
        vetoCategory: st.vetoCategory,
        vetoReason: st.vetoReason,
        status: st.status,
        hypotheticalPnlPct: st.hypotheticalPnlPct,
        openedAt: st.openedAt,
        closedAt: st.closedAt,
      })),
      shadowStats: tradeExecutor.getShadowStats(),

      // ── Strategy & AI Directives ──
      strategy: {
        activeStrategy: directives.activeStrategy,
        scoreFloor: directives.scoreFloor,
        effectiveMinScore: directives.scoreFloor,
        bullTrapUpperWickPct: directives.bullTrapUpperWickPct,
        regime: directives.regime,
        bannedSides: directives.bannedSides || [],
        aiProvider: config.ACTIVE_AI_PROVIDER,
        autonomousMode: config.AUTONOMOUS_MODE,
        watchPairs: watchPairs,
      },

      // Backward-compatible flat fields
      subaccountAddress: config.DECIBEL_SUBACCOUNT_ADDRESS,
      paperTrading: config.PAPER_TRADING,
      budgetUsd: config.BUDGET_USD,
      totalTrades: stats.totalTrades,
      winRate: stats.winRate,
      totalPnlUsd: stats.totalPnlUsd,
    };

    const fallbackUrl = 'https://simlab.measmony.me';
    let targetBaseUrl = this.serverUrl;

    try {
      // 1. Post to Sim Lab Pipeline Telemetry endpoint (Feature 5: 8-Second Telemetry Heartbeat)
      if (this.featureFlags.syncTelemetry) {
        let posted = false;
        try {
          await axios.post(`${targetBaseUrl}/api/pipeline/telemetry`, payload, {
            headers: {
              'Content-Type': 'application/json',
              ...(this.secret ? { 'X-SimLab-Client-Auth': this.secret } : {}),
            },
            timeout: targetBaseUrl.includes('measmony.me') ? 7000 : 3500,
          });
          posted = true;
        } catch (primaryErr: any) {
          // If primary is local and failed, failover to public Cloudflare
          if (targetBaseUrl !== fallbackUrl) {
            try {
              await axios.post(`${fallbackUrl}/api/pipeline/telemetry`, payload, {
                headers: {
                  'Content-Type': 'application/json',
                  ...(this.secret ? { 'X-SimLab-Client-Auth': this.secret } : {}),
                },
                timeout: 7000,
              });
              targetBaseUrl = fallbackUrl;
              posted = true;
            } catch {}
          }
        }

        if (!posted) {
          // Fallback to heartbeat endpoint
          await axios.post(`${targetBaseUrl}/api/clients/heartbeat`, payload, {
            headers: {
              'Content-Type': 'application/json',
              ...(this.secret ? { 'X-SimLab-Client-Auth': this.secret } : {}),
            },
            timeout: 4500,
          });
        }
      }

      // 2. Ingest bundle directives if connected or enabled
      if (this.isConnected && (this.featureFlags.syncMacroRegime || this.featureFlags.syncDirectionalBans || this.featureFlags.syncStrategyStudio)) {
        const authHeaders: Record<string, string> = {};
        if (this.rawToken) {
          authHeaders['Authorization'] = `Bearer ${this.rawToken}`;
          authHeaders['x-api-key'] = this.rawToken;
        }
        authHeaders['x-client-id'] = config.CLIENT_ID || 'alpha_client_v2';

        const bundleRes = await axios.get(`${targetBaseUrl}/api/pipeline/alpha-bundle`, {
          headers: authHeaders,
          timeout: 4000,
        }).catch(async () => {
          if (targetBaseUrl !== fallbackUrl) {
            return axios.get(`${fallbackUrl}/api/pipeline/alpha-bundle`, {
              headers: authHeaders,
              timeout: 6000,
            }).catch(() => null);
          }
          return null;
        });
        if (bundleRes?.data) {
          this.applyBundleDirectives(bundleRes.data);
        }
      }

      this.consecutiveFailures = 0;
    } catch (err: any) {
      this.consecutiveFailures++;
      // If supercharged connection drops, fall back to standalone directives
      if (this.consecutiveFailures >= 5 && this.isConnected) {
        this.isConnected = false;
        standaloneEngine.resetToStandaloneDirectives('Sim Lab heartbeat timeout');
      }
    }
  }

  public stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.isConnected = false;
  }
}

export const superchargeClient = new SimLabSuperchargeClient();
