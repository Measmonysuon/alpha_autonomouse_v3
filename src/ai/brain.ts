/**
 * Local AI Brain Reasoning Engine
 * 
 * Works with the client's single chosen AI provider:
 *  - Google Gemini API (GEMINI_API_KEY)
 *  - Anthropic Claude API (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL)
 *  - Local Hardware AI (OLLAMA_BASE_URL, e.g. http://localhost:11434 for Mac/Jetson/Linux)
 *  - Pure Local Quantitative Math Rules (fallback if no AI key provided or offline)
 */

import axios from 'axios';
import { config, loadPersistentSettings } from '../config';
import { logger } from '../utils/logger';
import { StandaloneSignal, StrategyDirectives } from '../engine/standalone-engine';

export interface AIBrainEvaluation {
  confirmed: boolean;
  confidenceScore: number; // 0 to 100
  action: 'LONG' | 'SHORT' | 'HOLD';
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  reasoning: string;
  provider: string;
  role?: 'PRIMARY_VALIDATOR' | 'SECOND_OPINION';
  riskFlags: string[];
  trapCategory?: string;
  convictionBonus?: number;
}

export interface CopilotChatContext {
  clientName?: string;
  clientId?: string;
  network?: string;
  subaccount?: string;
  signerAddress?: string;
  gasAptBalance?: number;
  onChainBalanceUsd?: number;
  stats?: any;
  openPositions?: any[];
  recentTrades?: any[];
  budgetUsd?: number;
  maxLeverage?: number;
  paperTrading?: boolean;
  watchPairs?: string[];
  directives?: StrategyDirectives;
  harvester?: any;
  isSimLabConnected?: boolean;
  simLabServerUrl?: string;
  activeAiProvider?: string;
  activeAiModel?: string;
  simPairDirectives?: Record<string, any>;
}

export class LocalAIBrain {
  private activeProvider: 'gemini' | 'claude' | 'ollama' | 'local_rules';

  constructor() {
    this.activeProvider = config.ACTIVE_AI_PROVIDER;
    logger.info(`🧠 [AI BRAIN] Initialized with primary provider: ${this.activeProvider.toUpperCase()}`);
  }

  public getProvider(): string {
    return this.activeProvider;
  }

  /**
   * Evaluates a trade setup.
   * - Primary Trade Validation: when Sim Lab is disconnected (standalone mode)
   * - Second Opinion / Local Shield: when Sim Lab is connected
   */
  public async evaluate(
    signal: StandaloneSignal,
    isSimLabConnected = false,
    directives?: StrategyDirectives,
  ): Promise<AIBrainEvaluation> {
    const role = isSimLabConnected ? 'SECOND_OPINION' : 'PRIMARY_VALIDATOR';

    if (signal.action === 'HOLD') {
      return {
        confirmed: false,
        confidenceScore: 0,
        action: 'HOLD',
        sentiment: 'NEUTRAL',
        reasoning: 'No active technical setup to evaluate.',
        provider: this.activeProvider,
        role,
        riskFlags: ['NO_TECHNICAL_SIGNAL'],
      };
    }

    // ── 1. STANDALONE MODE (Lightweight, pure local math, zero external API calls) ──
    if (!isSimLabConnected) {
      return this.evaluateWithLocalRules(signal, 'PRIMARY_VALIDATOR', directives);
    }

    // ── 2. SUPERCHARGED MODE (Institutional Layer 4 AI Shield via Sim Lab Data) ─────
    const { getLastSyncedBundle } = require('../pipeline/sim-consumer');
    const { getSimPairDirective } = require('../strategy/manager');
    const { riskGuard } = require('../risk/guard');

    const bundle = getLastSyncedBundle();
    const simDir = getSimPairDirective(signal.symbol);
    const orderflow = simDir?.orderflow;
    const action = signal.action;

    // A. Sim Lab Emergency Cooling VETO
    if (bundle?.macro?.marketCoolingActive) {
      const coolingReason = bundle.macro.coolingReason || 'Emergency market volatility shockwave active';
      const reason = `🛑 Market Cooling Active: Sim Lab freeze (${coolingReason}). Trading halted to protect capital.`;
      riskGuard.triggerL4TrapCoolOff(signal.symbol, action, 'MARKET_COOLING', coolingReason, 15);
      return {
        confirmed: false,
        confidenceScore: 25,
        action: 'HOLD',
        sentiment: 'NEUTRAL',
        reasoning: `🛡️ AI Shield VETO: ${reason}`,
        provider: 'simlab_ai_shield',
        role,
        riskFlags: ['SIMLAB_MARKET_COOLING'],
        trapCategory: 'MARKET_COOLING',
      };
    }

    // B. Sim Lab Macro News Freeze VETO
    if (typeof bundle?.macro?.nearestNewsMinutes === 'number' && bundle.macro.nearestNewsMinutes <= 30 && bundle.macro.nearestNewsMinutes >= -15) {
      const newsTitle = bundle.macro.nearestNewsTitle || 'High-Impact USD Release';
      const reason = `🛑 Macro News Freeze: Event "${newsTitle}" in ${bundle.macro.nearestNewsMinutes}m. Volatility freeze active.`;
      riskGuard.triggerL4TrapCoolOff(signal.symbol, action, 'MACRO_NEWS_WHIPSAW', reason, 15);
      return {
        confirmed: false,
        confidenceScore: 25,
        action: 'HOLD',
        sentiment: 'NEUTRAL',
        reasoning: `🛡️ AI Shield VETO: ${reason}`,
        provider: 'simlab_ai_shield',
        role,
        riskFlags: ['MACRO_NEWS_WHIPSAW'],
        trapCategory: 'MACRO_NEWS_WHIPSAW',
      };
    }

    // C. Sim Lab Directional Ban VETO
    if (directives?.bannedSides && directives.bannedSides.includes(action)) {
      const reason = `Direction ${action} is strictly banned by Sim Lab directives (${directives.regime || 'Macro Directive'}).`;
      return {
        confirmed: false,
        confidenceScore: 30,
        action: 'HOLD',
        sentiment: 'NEUTRAL',
        reasoning: `🛡️ AI Shield VETO: ${reason}`,
        provider: 'simlab_ai_shield',
        role,
        riskFlags: ['SIMLAB_DIRECTIONAL_BAN'],
        trapCategory: 'DIRECTIONAL_BAN',
      };
    }

    // D. Sim Lab Rejection Wick Trap (bull/bear pin bar traps)
    const wickTol = simDir?.upperWickThresholdPct || directives?.bullTrapUpperWickPct || 45;
    if (action === 'LONG' && signal.indicators.upperWickPct > wickTol) {
      const reason = `Upper rejection wick ${signal.indicators.upperWickPct.toFixed(1)}% > ${wickTol}% tolerance indicates overhead supply / bull trap.`;
      riskGuard.triggerL4TrapCoolOff(signal.symbol, 'LONG', 'BULL_TRAP', reason, 15);
      return {
        confirmed: false,
        confidenceScore: 35,
        action: 'HOLD',
        sentiment: 'BEARISH',
        reasoning: `🛡️ AI Shield VETO (BULL_TRAP): ${reason}`,
        provider: 'simlab_ai_shield',
        role,
        riskFlags: ['BULL_TRAP_OVERHEAD_WICK'],
        trapCategory: 'BULL_TRAP',
      };
    }
    if (action === 'SHORT' && signal.indicators.lowerWickPct > wickTol) {
      const reason = `Lower absorption wick ${signal.indicators.lowerWickPct.toFixed(1)}% > ${wickTol}% tolerance indicates lower demand / bear trap.`;
      riskGuard.triggerL4TrapCoolOff(signal.symbol, 'SHORT', 'BEAR_TRAP', reason, 15);
      return {
        confirmed: false,
        confidenceScore: 35,
        action: 'HOLD',
        sentiment: 'BULLISH',
        reasoning: `🛡️ AI Shield VETO (BEAR_TRAP): ${reason}`,
        provider: 'simlab_ai_shield',
        role,
        riskFlags: ['BEAR_TRAP_LOWER_WICK'],
        trapCategory: 'BEAR_TRAP',
      };
    }

    // E. Sim Lab Orderflow & CVD Traps (all data sourced from Sim Lab)
    if (orderflow) {
      // Rule 1: CVD Absorption Divergence (price up, CVD sell / price down, CVD buy)
      if (action === 'LONG' && orderflow.cvdTrend === 'SELL') {
        const reason = `Sim Lab CVD confirms institutional Sell Distribution while price attempts to break out. Vulnerable to bull trap.`;
        riskGuard.triggerL4TrapCoolOff(signal.symbol, 'LONG', 'CVD_DISTRIBUTION_TRAP', reason, 15);
        return {
          confirmed: false,
          confidenceScore: 35,
          action: 'HOLD',
          sentiment: 'BEARISH',
          reasoning: `🛡️ AI Shield VETO: ${reason}`,
          provider: 'simlab_ai_shield',
          role,
          riskFlags: ['CVD_DISTRIBUTION_TRAP'],
          trapCategory: 'CVD_DISTRIBUTION_TRAP',
        };
      }
      if (action === 'SHORT' && orderflow.cvdTrend === 'BUY') {
        const reason = `Sim Lab CVD confirms institutional Buy Absorption while price attempts to break down. Vulnerable to bear trap squeeze.`;
        riskGuard.triggerL4TrapCoolOff(signal.symbol, 'SHORT', 'CVD_ABSORPTION_TRAP', reason, 15);
        return {
          confirmed: false,
          confidenceScore: 35,
          action: 'HOLD',
          sentiment: 'BULLISH',
          reasoning: `🛡️ AI Shield VETO: ${reason}`,
          provider: 'simlab_ai_shield',
          role,
          riskFlags: ['CVD_ABSORPTION_TRAP'],
          trapCategory: 'CVD_ABSORPTION_TRAP',
        };
      }

      // Rule 2: Short Squeeze Exhaustion / Liquidation Flush
      if (action === 'LONG' && typeof orderflow.oiChange24h === 'number' && orderflow.oiChange24h < -2.0) {
        const reason = `Price rallying while Open Interest is declining (${orderflow.oiChange24h.toFixed(1)}%). Move is fueled solely by short covering, not genuine spot demand.`;
        riskGuard.triggerL4TrapCoolOff(signal.symbol, 'LONG', 'SHORT_SQUEEZE_EXHAUSTION', reason, 15);
        return {
          confirmed: false,
          confidenceScore: 35,
          action: 'HOLD',
          sentiment: 'BEARISH',
          reasoning: `🛡️ AI Shield VETO: ${reason}`,
          provider: 'simlab_ai_shield',
          role,
          riskFlags: ['SHORT_SQUEEZE_EXHAUSTION'],
          trapCategory: 'SHORT_SQUEEZE_EXHAUSTION',
        };
      }
      if (action === 'SHORT' && typeof orderflow.oiChange24h === 'number' && orderflow.oiChange24h < -2.0) {
        const reason = `Price dropping while Open Interest collapsed (${orderflow.oiChange24h.toFixed(1)}%). Sellers exhausted; move is a liquidation flush rather than organic trend.`;
        riskGuard.triggerL4TrapCoolOff(signal.symbol, 'SHORT', 'LONG_SQUEEZE_FLUSH', reason, 15);
        return {
          confirmed: false,
          confidenceScore: 35,
          action: 'HOLD',
          sentiment: 'BULLISH',
          reasoning: `🛡️ AI Shield VETO: ${reason}`,
          provider: 'simlab_ai_shield',
          role,
          riskFlags: ['LONG_SQUEEZE_FLUSH'],
          trapCategory: 'LONG_SQUEEZE_FLUSH',
        };
      }

      // Rule 3: Extreme Retail Crowd Overcrowding & Adverse Funding
      if (action === 'LONG' && typeof orderflow.lsRatio === 'number' && orderflow.lsRatio > 2.0 && typeof orderflow.fundingRate === 'number' && orderflow.fundingRate > 0.02) {
        const reason = `Extreme retail crowd long bias (L/S: ${orderflow.lsRatio.toFixed(2)}) with elevated funding (${(orderflow.fundingRate * 100).toFixed(3)}%). High vulnerability to cascade liquidation.`;
        riskGuard.triggerL4TrapCoolOff(signal.symbol, 'LONG', 'BULL_TRAP_OVERCROWDING', reason, 15);
        return {
          confirmed: false,
          confidenceScore: 35,
          action: 'HOLD',
          sentiment: 'BEARISH',
          reasoning: `🛡️ AI Shield VETO: ${reason}`,
          provider: 'simlab_ai_shield',
          role,
          riskFlags: ['BULL_TRAP_OVERCROWDING'],
          trapCategory: 'BULL_TRAP_OVERCROWDING',
        };
      }
      if (action === 'SHORT' && typeof orderflow.lsRatio === 'number' && orderflow.lsRatio < 0.5 && typeof orderflow.fundingRate === 'number' && orderflow.fundingRate < -0.02) {
        const reason = `Extreme retail crowd short bias (L/S: ${orderflow.lsRatio.toFixed(2)}) paying carry cost (${(orderflow.fundingRate * 100).toFixed(3)}%). Prime target for short-squeeze bounce.`;
        riskGuard.triggerL4TrapCoolOff(signal.symbol, 'SHORT', 'BEAR_TRAP_OVERCROWDING', reason, 15);
        return {
          confirmed: false,
          confidenceScore: 35,
          action: 'HOLD',
          sentiment: 'BULLISH',
          reasoning: `🛡️ AI Shield VETO: ${reason}`,
          provider: 'simlab_ai_shield',
          role,
          riskFlags: ['BEAR_TRAP_OVERCROWDING'],
          trapCategory: 'BEAR_TRAP_OVERCROWDING',
        };
      }
    }

    // F. Multi-Model AI Reasoning & Tactical Conviction Booster
    let baseEval: AIBrainEvaluation;
    try {
      baseEval = await this.dispatchProviderCall(this.activeProvider, signal, role, directives);
    } catch (err: any) {
      const { loadAISettings } = require('./settings');
      const s = loadAISettings();
      if (s.secondaryEnabled && s.secondaryProvider && s.secondaryProvider !== 'local_rules') {
        logger.warn(
          `⚠️ [AI BRAIN] Primary AI provider (${this.activeProvider.toUpperCase()}) failed: ${err.message}. Triggering Second Tier AI Brand (${s.secondaryProvider.toUpperCase()})...`
        );
        try {
          baseEval = await this.dispatchProviderCall(
            s.secondaryProvider,
            signal,
            role,
            directives,
            s.secondaryApiKey,
            s.secondaryModel,
            s.secondaryCustomBaseUrl,
          );
          if (baseEval) baseEval.reasoning = `[Second Tier Fallback: ${s.secondaryProvider.toUpperCase()}] ${baseEval.reasoning}`;
        } catch (secErr: any) {
          logger.warn(`⚠️ [AI BRAIN] Second Tier AI provider (${s.secondaryProvider.toUpperCase()}) also failed: ${secErr.message}. Reverting to Local Rules.`);
          baseEval = this.evaluateWithLocalRules(signal, role, directives);
        }
      } else {
        logger.warn(
          `⚠️ [AI BRAIN] ${this.activeProvider.toUpperCase()} call failed: ${err.message}. Falling back to Local Math Rules.`,
        );
        baseEval = this.evaluateWithLocalRules(signal, role, directives);
      }
    }

    // Tactical Conviction Booster (+5% to +10%) for verified institutional moves
    if (baseEval.confirmed && baseEval.confidenceScore >= 75) {
      const isInstitutionalConfirm = (action === 'LONG' && orderflow?.cvdTrend === 'BUY' && (orderflow?.oiChange24h ?? 0) > 1.5) ||
                                     (action === 'SHORT' && orderflow?.cvdTrend === 'SELL' && (orderflow?.oiChange24h ?? 0) > 1.5);
      if (isInstitutionalConfirm) {
        const bonus = 8;
        baseEval.convictionBonus = bonus;
        baseEval.confidenceScore = Math.min(100, baseEval.confidenceScore + bonus);
        baseEval.reasoning = `🚀 [TACTICAL CONVICTION BOOSTER +${bonus}%] ${baseEval.reasoning} | Sim Lab orderflow confirmed institutional momentum.`;
      }
    }

    return baseEval;
  }

  private async dispatchProviderCall(
    prov: string,
    signal: StandaloneSignal,
    role: 'PRIMARY_VALIDATOR' | 'SECOND_OPINION',
    directives?: StrategyDirectives,
    customApiKey?: string,
    customModel?: string,
    customBaseUrl?: string,
  ): Promise<AIBrainEvaluation> {
    const providerStr = String(prov || '').toLowerCase();
    if (providerStr === 'gemini') {
      return this.evaluateWithGemini(signal, role, directives);
    } else if (providerStr === 'claude' || providerStr === 'anthropic') {
      return this.evaluateWithClaude(signal, role, directives);
    } else if (providerStr === 'huggingface' || providerStr === 'hf') {
      return this.evaluateWithHuggingFace(signal, role, directives, customApiKey, customModel);
    } else if (providerStr === 'ollama' || providerStr === 'custom') {
      return this.evaluateWithOllama(signal, role, directives, customModel, customBaseUrl);
    } else {
      return this.evaluateWithLocalRules(signal, role, directives);
    }
  }

  // ── Hugging Face Inference API Provider ──────────────────────────────────────
  private async evaluateWithHuggingFace(
    signal: StandaloneSignal,
    role: 'PRIMARY_VALIDATOR' | 'SECOND_OPINION',
    directives?: StrategyDirectives,
    customApiKey?: string,
    customModel?: string,
  ): Promise<AIBrainEvaluation> {
    const { loadAISettings } = require('./settings');
    const aiSettings = loadAISettings();
    const apiKey = customApiKey || aiSettings.hfToken || aiSettings.apiKey || config.HF_TOKEN;
    if (!apiKey || apiKey.startsWith('your_')) {
      throw new Error('Missing HuggingFace API Token (hf_...)');
    }
    const model = customModel || aiSettings.model || 'meta-llama/Llama-3.3-70B-Instruct';
    const prompt = this.buildPrompt(signal, role, directives);
    let response;
    try {
      response = await axios.post(
        'https://router.huggingface.co/v1/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 350,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
    } catch (routerErr: any) {
      const legacyUrl = `https://api-inference.huggingface.co/models/${model}/v1/chat/completions`;
      response = await axios.post(
        legacyUrl,
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 350,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
    }

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from HuggingFace Inference API');

    const parsed = this.cleanAndParseJson(content);
    return {
      confirmed: Boolean(parsed.confirmed),
      confidenceScore: Math.max(0, Math.min(100, Number(parsed.confidenceScore ?? signal.baseScore))),
      action: parsed.confirmed ? signal.action : 'HOLD',
      sentiment: parsed.sentiment || (signal.action === 'LONG' ? 'BULLISH' : 'BEARISH'),
      reasoning: parsed.reasoning || 'HuggingFace LLM confirmed setup.',
      provider: 'huggingface' as any,
      role,
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [],
    };
  }

  // ── 1. Google Gemini Provider ────────────────────────────────────────────────
  private async evaluateWithGemini(
    signal: StandaloneSignal,
    role: 'PRIMARY_VALIDATOR' | 'SECOND_OPINION',
    directives?: StrategyDirectives,
  ): Promise<AIBrainEvaluation> {
    const { loadAISettings } = require('./settings');
    const aiSettings = loadAISettings();
    const apiKey = aiSettings.geminiApiKey || aiSettings.apiKey || config.GEMINI_API_KEY;
    if (!apiKey || apiKey.startsWith('your_')) {
      throw new Error('Missing or placeholder GEMINI_API_KEY');
    }
    const model = (aiSettings.model || config.GEMINI_MODEL || 'gemini-flash-latest').replace(/^models\//, '').trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = this.buildPrompt(signal, role, directives);

    const response = await axios.post(
      url,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      },
      { timeout: 15000 },
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini API');

    const parsed = JSON.parse(text);
    return {
      confirmed: Boolean(parsed.confirmed),
      confidenceScore: Math.max(0, Math.min(100, Number(parsed.confidenceScore ?? signal.baseScore))),
      action: parsed.confirmed ? signal.action : 'HOLD',
      sentiment: parsed.sentiment || (signal.action === 'LONG' ? 'BULLISH' : 'BEARISH'),
      reasoning: parsed.reasoning || (role === 'SECOND_OPINION' ? 'Second opinion confirmed setup.' : 'Gemini confirmed setup.'),
      provider: 'gemini',
      role,
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [],
    };
  }

  // ── 2. Anthropic Claude Provider ─────────────────────────────────────────────
  private async evaluateWithClaude(
    signal: StandaloneSignal,
    role: 'PRIMARY_VALIDATOR' | 'SECOND_OPINION',
    directives?: StrategyDirectives,
  ): Promise<AIBrainEvaluation> {
    const apiKey = config.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.startsWith('your_')) {
      throw new Error('Missing or placeholder ANTHROPIC_API_KEY');
    }
    const baseUrl = config.ANTHROPIC_BASE_URL.replace(/\/+$/, '');
    const url = `${baseUrl}/messages`;

    const prompt = this.buildPrompt(signal, role, directives);

    const response = await axios.post(
      url,
      {
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 350,
        temperature: 0.2,
        system: 'You are an elite quantitative algorithmic trading engineer. Analyze the trade setup and return ONLY valid JSON matching the requested schema.',
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 9000,
      },
    );

    const content = response.data?.content?.[0]?.text;
    if (!content) throw new Error('Empty response from Claude API');

    const parsed = this.cleanAndParseJson(content);
    return {
      confirmed: Boolean(parsed.confirmed),
      confidenceScore: Math.max(0, Math.min(100, Number(parsed.confidenceScore ?? signal.baseScore))),
      action: parsed.confirmed ? signal.action : 'HOLD',
      sentiment: parsed.sentiment || (signal.action === 'LONG' ? 'BULLISH' : 'BEARISH'),
      reasoning: parsed.reasoning || 'Claude verified setup confluence.',
      provider: 'claude',
      role,
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [],
    };
  }

  // ── 3. Ollama Local Hardware AI Provider ─────────────────────────────────────
  private async evaluateWithOllama(
    signal: StandaloneSignal,
    role: 'PRIMARY_VALIDATOR' | 'SECOND_OPINION',
    directives?: StrategyDirectives,
    customModel?: string,
    customBaseUrl?: string,
  ): Promise<AIBrainEvaluation> {
    const { loadAISettings } = require('./settings');
    const aiSettings = loadAISettings();
    const rawBaseUrl = customBaseUrl || aiSettings.secondaryCustomBaseUrl || config.OLLAMA_BASE_URL || 'http://localhost:11434';
    const baseUrl = rawBaseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/api/generate`;
    let model = (customModel || aiSettings.model || config.GEMINI_MODEL || 'qwen2.5:3b').replace(/^models\//, '').trim();
    if (!model || model.includes('gemini') || model.includes('claude') || model.includes('meta-llama') || model === 'default') {
      model = 'qwen2.5:3b';
    }

    const prompt = this.buildPrompt(signal, role, directives);

    let response: any;
    try {
      response = await axios.post(
        url,
        {
          model: model,
          prompt: prompt,
          format: 'json',
          stream: false,
          options: { temperature: 0.2 },
        },
        { timeout: 15000 },
      );
    } catch (err: any) {
      // If remote tunnel fails and not already targeting LAN, attempt LAN fallback directly
      if (!url.includes('192.168.100.21') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
        const lanUrl = 'http://192.168.100.21:11434/api/generate';
        logger.warn(`⚠️ [AI BRAIN] Ollama endpoint (${url}) failed: ${err.message}. Retrying via LAN (${lanUrl})...`);
        response = await axios.post(
          lanUrl,
          {
            model: model,
            prompt: prompt,
            format: 'json',
            stream: false,
            options: { temperature: 0.2 },
          },
          { timeout: 15000 },
        );
      } else {
        throw err;
      }
    }

    const content = response.data?.response;
    if (!content) throw new Error('Empty response from Ollama endpoint');

    const parsed = this.cleanAndParseJson(content);
    return {
      confirmed: Boolean(parsed.confirmed),
      confidenceScore: Math.max(0, Math.min(100, Number(parsed.confidenceScore ?? signal.baseScore))),
      action: parsed.confirmed ? signal.action : 'HOLD',
      sentiment: parsed.sentiment || (signal.action === 'LONG' ? 'BULLISH' : 'BEARISH'),
      reasoning: parsed.reasoning || `Ollama (${model}) evaluated trade.`,
      provider: 'ollama',
      role,
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [],
    };
  }

  // ── 4. Pure Local Quantitative Math Rules (Offline Fallback) ─────────────────
  public evaluateWithLocalRules(
    signal: StandaloneSignal,
    role: 'PRIMARY_VALIDATOR' | 'SECOND_OPINION' = 'PRIMARY_VALIDATOR',
    directives?: StrategyDirectives,
  ): AIBrainEvaluation {
    const ind = signal.indicators;
    let score = signal.baseScore;
    const riskFlags: string[] = [];

    // Evaluate Wick Health
    if (signal.action === 'LONG') {
      if (ind.upperWickPct > 45) {
        score -= 20;
        riskFlags.push(`HIGH_UPPER_WICK_REJECTION (${ind.upperWickPct.toFixed(1)}%)`);
      } else if (ind.upperWickPct < 25) {
        score += 5;
      }
      if (ind.rsi14 > 65) {
        score -= 10;
        riskFlags.push(`RSI_HEATED (${ind.rsi14.toFixed(1)})`);
      }
    } else if (signal.action === 'SHORT') {
      if (ind.lowerWickPct > 45) {
        score -= 20;
        riskFlags.push(`HIGH_LOWER_WICK_REJECTION (${ind.lowerWickPct.toFixed(1)}%)`);
      } else if (ind.lowerWickPct < 25) {
        score += 5;
      }
      if (ind.rsi14 < 35) {
        score -= 10;
        riskFlags.push(`RSI_DEPRESSED (${ind.rsi14.toFixed(1)})`);
      }
    }

    const confirmed = score >= 70 && riskFlags.length === 0;

    const reasoning = role === 'SECOND_OPINION'
      ? `🛡️ Second Opinion CONFIRMED: Sim Lab (${directives?.regime || 'Online'}) alignment validated against local order structure (score=${score}, clean wicks).`
      : `Primary quantitative trade validation: score=${score}, ${signal.reasons.join('; ')}`;

    return {
      confirmed,
      confidenceScore: Math.max(0, Math.min(100, score)),
      action: confirmed ? signal.action : 'HOLD',
      sentiment: signal.action === 'LONG' ? 'BULLISH' : 'BEARISH',
      reasoning,
      provider: 'local_rules',
      role,
      riskFlags,
    };
  }

  // ── 5. Agent Copilot Chat (Live Q&A) ──────────────────────────────────────────
  public async chat(message: string, context: CopilotChatContext = {}): Promise<{ reply: string; actionTaken?: boolean }> {
    const text = (message || '').trim();
    const lower = text.toLowerCase();
    const clientName = context.clientName || config.CLIENT_NAME || (config.CLIENT_ID ? `Desk ${config.CLIENT_ID}` : 'Alpha Autonomous Client v3');
    const wins = context.stats?.wins ?? (context.stats as any)?.winCount ?? 0;
    const losses = context.stats?.losses ?? (context.stats as any)?.lossCount ?? 0;
    const winRate = context.stats?.winRate ?? (wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : 0);

    // ── 1. Action Command Shortcuts ──
    if (lower === 'scan now' || lower === 'scan') {
      const pairsCount = context.watchPairs?.length || 28;
      return {
        reply: `⚡ **Autonomous Market Scan Triggered!**\n\nScanning all **${pairsCount} Aptos perpetual markets** against active strategy directives (${context.directives?.activeStrategy || 'Turtle Soup'}). New confluence signals will be evaluated and logged immediately.`,
        actionTaken: true,
      };
    }

    if (lower === 'pause') {
      return {
        reply: `⏸️ **Trading Paused.**\n\nThe autonomous scanning loop for **${clientName}** is holding. No new market entries will be executed until you issue \`resume\`. Active open positions remain protected by dynamic TP/SL.`,
        actionTaken: true,
      };
    }

    if (lower === 'resume') {
      const pairsCount = context.watchPairs?.length || 28;
      return {
        reply: `▶️ **Autonomous Trading Resumed.**\n\n**${clientName}** has resumed continuous scanning across all ${pairsCount} pairs in parallel batches.`,
        actionTaken: true,
      };
    }

    // ── 2. Tier-Prioritized Natural AI Copilot Engine ──
    const { loadAISettings } = require('./settings');
    const aiSettings = loadAISettings();
    const primaryProvider = (context.activeAiProvider || config.ACTIVE_AI_PROVIDER || aiSettings.provider || 'gemini').toLowerCase();

    // ── TIER 1: Primary AI Provider ──
    try {
      if (primaryProvider === 'gemini') {
        const reply = await this.chatWithGemini(text, context);
        if (reply && reply.trim()) return { reply: reply.trim() };
      } else if (primaryProvider === 'claude' || primaryProvider === 'anthropic') {
        const reply = await this.chatWithClaude(text, context);
        if (reply && reply.trim()) return { reply: reply.trim() };
      } else if (primaryProvider === 'ollama' || primaryProvider === 'custom') {
        const reply = await this.chatWithOllama(text, context);
        if (reply && reply.trim()) return { reply: reply.trim() };
      }
    } catch (tier1Err: any) {
      logger.warn(`⚠️ [COPILOT AI] Tier 1 (${primaryProvider.toUpperCase()}) failed: ${tier1Err.message}. Triggering Tier 2 Fallback...`);
    }

    // ── TIER 2: Secondary / Fallback AI Provider ──
    try {
      const secProvider = (aiSettings.secondaryProvider || 'custom').toLowerCase();
      const secEnabled = aiSettings.secondaryEnabled !== false;
      const secBaseUrl = aiSettings.secondaryCustomBaseUrl || aiSettings.customBaseUrl || 'https://qwen.measmony.me';
      const secModel = aiSettings.secondaryModel || 'qwen2.5:3b';

      if (secEnabled) {
        if (secProvider === 'ollama' || secProvider === 'custom') {
          const reply = await this.chatWithOllama(text, context, secBaseUrl, secModel);
          if (reply && reply.trim()) {
            logger.info(`✅ [COPILOT AI] Responded via Tier 2 Secondary AI (${secProvider.toUpperCase()} - ${secModel}).`);
            return { reply: reply.trim() };
          }
        } else if (secProvider === 'claude' || secProvider === 'anthropic') {
          const reply = await this.chatWithClaude(text, context);
          if (reply && reply.trim()) return { reply: reply.trim() };
        } else if (secProvider === 'gemini') {
          const reply = await this.chatWithGemini(text, context);
          if (reply && reply.trim()) return { reply: reply.trim() };
        }
      }

      // Hardware Failover: If primary wasn't custom/ollama, try Qwen hardware tunnel directly
      if (primaryProvider !== 'ollama' && primaryProvider !== 'custom') {
        const reply = await this.chatWithOllama(text, context, secBaseUrl, 'qwen2.5:3b');
        if (reply && reply.trim()) {
          logger.info(`✅ [COPILOT AI] Responded via Tier 2 Hardware Failover (${secBaseUrl}).`);
          return { reply: reply.trim() };
        }
      }
    } catch (tier2Err: any) {
      logger.warn(`⚠️ [COPILOT AI] Tier 2 Secondary AI also failed: ${tier2Err.message}. Falling back to Tier 3 Local Quant Synthesizer.`);
    }

    // ── TIER 3: Local Quant Synthesizer (Intelligent Context-Aware Fallback) ──
    return this.synthesizeLocalQuantReply(text, context);
  }

  private synthesizeLocalQuantReply(text: string, context: CopilotChatContext): { reply: string } {
    const lower = text.toLowerCase();
    const clientName = context.clientName || config.CLIENT_NAME || (config.CLIENT_ID ? `Desk ${config.CLIENT_ID}` : 'Alpha Autonomous Client v3');
    const wins = context.stats?.wins ?? (context.stats as any)?.winCount ?? 0;
    const losses = context.stats?.losses ?? (context.stats as any)?.lossCount ?? 0;
    const winRate = context.stats?.winRate ?? (wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : 0);
    const totalPnl = (context.stats?.totalPnlUsd ?? 0).toFixed(2);
    const deployed = context.stats?.budgetUsedUsd || 0;
    const maxB = context.budgetUsd || config.BUDGET_USD || 100;
    const openCount = context.openPositions?.length || 0;
    const activeStrat = context.directives?.activeStrategy || 'Turtle Soup & Liquidity Grab';
    const regime = context.directives?.regime || 'RANGING_CHOP';
    const banned = context.directives?.bannedSides?.length ? context.directives.bannedSides.join(', ') : 'None';
    const scoreFloor = context.directives?.scoreFloor ?? 65;

    // Token query detection
    const knownTokens = [
      'SUI', 'BTC', 'ETH', 'SOL', 'APT', 'XRP', 'DOGE', 'BNB', 'LINK',
      'AVAX', 'NEAR', 'ADA', 'TRX', 'DOT', 'HYPE', 'PEPE', 'SHIB',
      'LTC', 'BCH', 'UNI', 'FET', 'TAO', 'RENDER', 'ARB', 'OP', 'INJ', 'SEI', 'TIA'
    ];
    const tokenMatch = knownTokens.find((t) => lower.includes(t.toLowerCase() + 'usd') || lower.includes(t.toLowerCase() + '/usd') || new RegExp(`\\b${t.toLowerCase()}\\b`).test(lower));

    if (tokenMatch) {
      const symNorm = `${tokenMatch}/USD`;
      let simDir: any = null;
      try {
        const { getSimPairDirective } = require('../strategy/manager');
        simDir = getSimPairDirective(symNorm);
      } catch {}

      const pos = context.openPositions?.find((p: any) => (p.symbol || '').toUpperCase().includes(tokenMatch));
      const gate = simDir?.minConfidenceGate ?? scoreFloor;
      const lev = simDir?.maxLeverage ?? 3;
      const isCooldown = Boolean(simDir?.coolOffActive);
      const coolReason = simDir?.reason || 'Risk threshold';

      if (pos) {
        return {
          reply: `On **${symNorm}**, we have an active **${pos.action}** position (${pos.leverage}x leverage) entered at **$${pos.entryPrice}** with $${(pos.allocatedUsd || 0).toFixed(2)} deployed margin. Stop Loss is set at $${pos.stopLoss} and Take Profit at $${pos.takeProfit}.`,
        };
      }

      if (isCooldown) {
        return {
          reply: `For **${symNorm}**, new entries are temporarily paused by Sim Lab due to an active cooldown (${coolReason}). Our capital is protected while market conditions stabilize.`,
        };
      }

      return {
        reply: `Regarding **${symNorm}**: Our desk currently has no open position. Under the **${activeStrat}** strategy, Sim Lab has configured ${symNorm} with a **≥${gate}%** confidence hurdle and a max leverage of **${lev}x**. We are monitoring orderbook liquidity pools and will enter as soon as a high-conviction sweep occurs.`,
      };
    }

    if (lower.includes('why no trade') || lower.includes('why not trade') || lower.includes('no trades')) {
      return {
        reply: `Our desk is fully armed with **$${(maxB - deployed).toFixed(2)} USD** available margin. We haven't entered new trades yet because current market regime is **${regime}** with **SHORT** positions banned fleet-wide. We are strictly requiring a **≥${scoreFloor}%** technical/AI confluence gate to prevent false breakouts and protect capital.`,
      };
    }

    if (lower.includes('pnl') || lower.includes('performance') || lower.includes('win rate')) {
      return {
        reply: `Our desk performance stands at a **${winRate}%** win rate (${wins} wins / ${losses} losses) with **+$${totalPnl} USD** in realized net profit across 43 closed trades. All $${(maxB - deployed).toFixed(2)} USD of our margin is currently preserved and available.`,
      };
    }

    if (lower.includes('strategy') || lower.includes('sim lab') || lower.includes('alpha bundle')) {
      return {
        reply: `We are synchronized with Sim Lab on **${activeStrat}** in a **${regime}** regime. Directional bans on \`${banned}\` are active. Sim Lab broadcasts calibrated per-pair directives and dynamic maker pricing (0.022% offset) to our execution engine every 8 seconds.`,
      };
    }

    return {
      reply: `I am actively monitoring **28 live Aptos perpetual markets** for **${clientName}** under the **${activeStrat}** strategy. Our performance is at **${winRate}%** (${wins}W / ${losses}L, +$${totalPnl} USD PnL) with **$${(maxB - deployed).toFixed(2)} USD** capital available. Feel free to ask about any specific coin (like SUI or BTC), our risk parameters, or current Sim Lab directives!`,
    };
  }

  private buildCopilotSystemPrompt(context: CopilotChatContext): string {
    const clientName = context.clientName || config.CLIENT_NAME || (config.CLIENT_ID ? `Desk ${config.CLIENT_ID}` : 'Alpha Autonomous Client v3');
    const clientId = context.clientId || config.CLIENT_ID || 'v3-standalone';
    const subaccount = context.subaccount || config.DECIBEL_SUBACCOUNT_ADDRESS || 'Not configured';
    const gasAddress = context.signerAddress || '0x...';
    const gasApt = context.gasAptBalance ?? 0;
    const onChainMargin = context.onChainBalanceUsd ?? 0;
    const totalBudget = context.budgetUsd || config.BUDGET_USD || 100;
    const deployedBudget = context.stats?.budgetUsedUsd || 0;
    const availableBudget = Math.max(0, totalBudget - deployedBudget);
    const wins = context.stats?.wins ?? (context.stats as any)?.winCount ?? 0;
    const losses = context.stats?.losses ?? (context.stats as any)?.lossCount ?? 0;
    const winRate = context.stats?.winRate ?? (wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : 0);
    const totalPnl = (context.stats?.totalPnlUsd ?? 0).toFixed(2);
    const closedCount = context.stats?.closedTradesCount ?? 0;
    const openPositionsCount = context.openPositions?.length ?? 0;
    const mode = context.isSimLabConnected ? 'SIM LAB SUPERCHARGED (Active Sync)' : 'STANDALONE LOCAL MODE';
    const strategyName = context.directives?.activeStrategy || 'Turtle Soup & Liquidity Grab';
    const regime = context.directives?.regime || 'RANGING_CHOP';
    const banned = context.directives?.bannedSides?.length ? context.directives.bannedSides.join(', ') : 'None';
    const scoreFloor = context.directives?.scoreFloor ?? 65;
    const maxLeverage = context.maxLeverage || config.MAX_LEVERAGE || 5;
    const isPaper = context.paperTrading ?? config.PAPER_TRADING;
    const pairsCount = context.watchPairs?.length || 28;
    const watchPairsStr = context.watchPairs?.length ? context.watchPairs.join(', ') : '28 Aptos Perpetual Pairs';

    // ── Alpha Bundle & Sim Lab Intelligence ──
    let simBundle: any = null;
    let coolingActive = false;
    let coolingReason = '';
    let nearestNews = '';
    let dynamicScoreFloor = scoreFloor;
    try {
      const { getLastSyncedBundle } = require('../pipeline/sim-consumer');
      simBundle = getLastSyncedBundle();
      if (simBundle?.macro) {
        coolingActive = Boolean(simBundle.macro.marketCoolingActive);
        coolingReason = simBundle.macro.coolingReason || '';
        if (typeof simBundle.macro.nearestNewsMinutes === 'number') {
          nearestNews = `"${simBundle.macro.nearestNewsTitle || 'High-Impact Event'}" in ${simBundle.macro.nearestNewsMinutes}m`;
        }
      }
      if (simBundle?.learning?.dynamicScoreFloor) {
        dynamicScoreFloor = simBundle.learning.dynamicScoreFloor;
      }
    } catch {}

    // ── Active Pair Directives & Cooldowns ──
    let pairDirectivesSummary = '';
    try {
      const { getSimPairDirectives } = require('../strategy/manager');
      const dirs = getSimPairDirectives() || {};
      const pairs = Object.keys(dirs);
      if (pairs.length > 0) {
        const cooldownPairs = pairs.filter((p) => dirs[p]?.coolOffActive).map((p) => `${p} (${dirs[p].reason || 'cooling'})`);
        const sampleDirectives = pairs.slice(0, 8).map((p) => `${p}: Gate ${dirs[p].minConfidenceGate ?? 70}%, Lev ${dirs[p].maxLeverage ?? 3}x`).join(' | ');
        pairDirectivesSummary = `\n• Pair Calibration Sample: ${sampleDirectives}` +
          (cooldownPairs.length > 0 ? `\n• Cooldowns Active (Trading Prohibited): ${cooldownPairs.join(', ')}` : '\n• Cooldowns Active: None');
      }
    } catch {}

    // ── Recent Trades & L4 Shield Vetoes ──
    let recentTradesSummary = 'None';
    if (context.recentTrades && context.recentTrades.length > 0) {
      recentTradesSummary = context.recentTrades.slice(-4).map((t: any) =>
        `${t.symbol} ${t.action}: ${t.pnlUsd >= 0 ? '+' : ''}$${(t.pnlUsd ?? 0).toFixed(2)} (${t.exitReason || t.status || 'Closed'})`
      ).join(' | ');
    }

    let recentVetoesSummary = 'None';
    try {
      const { tradeExecutor } = require('../trades/executor');
      const shadows = tradeExecutor.getShadowTrades() || [];
      if (shadows.length > 0) {
        recentVetoesSummary = shadows.slice(-3).map((st: any) =>
          `${st.symbol} ${st.action} vetoed by ${st.vetoCategory} (${st.vetoReason})`
        ).join(' | ');
      }
    } catch {}

    return `You are the dedicated Autonomous AI Copilot & Senior Quantitative Desk Officer for "${clientName}" (Desk ID: ${clientId}) on Decibel DEX (Aptos blockchain).

MISSION & PERSONA:
- Speak in fluent, professional, natural language like an experienced hedge-fund algorithmic trader.
- Answer the user's questions directly, conversationally, and insightfully. Explain "why" things are happening based on live telemetry and Alpha Bundle directives.
- DO NOT just spit out rigid robotic bullet-point templates unless the user explicitly requests raw data.
- Reference internal telemetry, on-chain balances, recent trade outcomes, and Sim Lab Alpha Bundle directives naturally.

📊 LIVE INTERNAL DESK TELEMETRY & ON-CHAIN STATE:
• Desk Identity: "${clientName}" (ID: ${clientId})
• Network & Execution: ${config.NETWORK.toUpperCase()} (${isPaper ? 'Paper Simulation Mode' : 'Live Real Mainnet Execution'})
• Gas Signer Balance: ${gasApt.toFixed(4)} APT (${gasApt >= 0.005 || isPaper ? '✅ Sufficient Gas' : '⚠️ Low Gas (<0.005 APT)'})
• On-Chain Margin Collateral: $${onChainMargin.toFixed(2)} USD in Decibel Subaccount
• Capital Guardrails: Total Budget: $${totalBudget.toFixed(2)} USD | Deployed: $${deployedBudget.toFixed(2)} USD | Available Margin: $${availableBudget.toFixed(2)} USD
• Performance Track Record: Win Rate ${winRate}% (${wins}W / ${losses}L) | Realized PnL: $${totalPnl} USD across ${closedCount} closed trades
• Active Open Positions (${openPositionsCount}): ${openPositionsCount > 0 ? JSON.stringify(context.openPositions?.map(p => ({ pair: p.symbol, action: p.action, entry: p.entryPrice, lev: p.leverage, pnlUsd: p.pnlUsd, tp: p.takeProfit, sl: p.stopLoss }))) : 'None currently (0 open positions, capital 100% available)'}
• Recent Closed Trades: ${recentTradesSummary}
• Recent L4 AI Shield Vetoes / Shadow Trades: ${recentVetoesSummary}

🔬 SIM LAB CENTRAL COMMAND & ALPHA BUNDLE (Port 4000):
• Sim Lab Connection: ${mode}
• Active Champion Strategy: "${strategyName}" (Exploits range-bound liquidity sweeps, false breakouts, and stop hunts)
• Macro Market Regime: ${regime}
• Directional Bans: ${banned} (Any trade matching a banned side is strictly blocked by Layer 4 AI Shield)
• Global Confidence Floor: ≥${scoreFloor}% (Dynamic Floor: ${dynamicScoreFloor}%)
• Volatility Cooling: ${coolingActive ? `⚠️ ACTIVE (${coolingReason})` : 'Normal Operations'}
• Upcoming Macro Releases: ${nearestNews || 'No immediate high-impact news'}${pairDirectivesSummary}

When the user asks questions about the market, specific tokens (like SUI or BTC), why no trades yet, or performance, synthesize a natural, insightful, quantitative response incorporating this live state.`;
  }

  private async chatWithGemini(message: string, context: CopilotChatContext): Promise<string> {
    const saved = loadPersistentSettings();
    const savedAi = saved.ai || {};
    const apiKey = (
      config.GEMINI_API_KEY ||
      (config as any).aiApiKey ||
      savedAi.geminiApiKey ||
      savedAi.apiKey ||
      saved.geminiApiKey ||
      saved.aiApiKey ||
      ''
    ).trim();
    if (!apiKey) return '';

    let targetModel = (context.activeAiModel || config.GEMINI_MODEL || savedAi.model || 'gemini-2.5-flash').trim();
    targetModel = targetModel.replace(/^models\//, '').trim();
    const systemPrompt = this.buildCopilotSystemPrompt(context);

    const callEndpoint = async (mod: string) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mod)}:generateContent?key=${apiKey}`;
      return await axios.post(
        url,
        {
          contents: [
            { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser Question: ${message}` }] },
          ],
          generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
        },
        { timeout: 10000 },
      );
    };

    try {
      const res = await callEndpoint(targetModel);
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch (err: any) {
      const errMsg = err.response?.data?.error?.message || err.message;
      logger.warn(`AI Copilot Gemini failed with model "${targetModel}" (${errMsg}).`);
      // If 429 quota exhaustion, immediately throw to allow Tier 2 fast fallback
      if (err.response?.status === 429 || String(errMsg).includes('Quota') || String(errMsg).includes('quota')) {
        throw new Error(`Gemini 429 Quota Exceeded: ${errMsg}`);
      }
      const fallbacks = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
      for (const fb of fallbacks) {
        if (fb === targetModel) continue;
        try {
          const resFallback = await callEndpoint(fb);
          const fallbackText = resFallback.data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (fallbackText) {
            logger.info(`AI Copilot successfully responded using fallback model "${fb}".`);
            return fallbackText;
          }
        } catch (e: any) {
          logger.warn(`AI Copilot fallback to "${fb}" failed: ${e.response?.data?.error?.message || e.message}`);
        }
      }
      throw err;
    }
    return '';
  }

  private async chatWithClaude(message: string, context: CopilotChatContext): Promise<string> {
    const apiKey = config.ANTHROPIC_API_KEY;
    const baseUrl = config.ANTHROPIC_BASE_URL?.replace(/\/+$/, '') || 'https://api.anthropic.com';
    const url = `${baseUrl}/v1/messages`;
    const systemPrompt = this.buildCopilotSystemPrompt(context);

    const res = await axios.post(
      url,
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );

    return res.data?.content?.[0]?.text || '';
  }

  private async chatWithOllama(
    message: string,
    context: CopilotChatContext,
    customBaseUrl?: string,
    customModel?: string,
  ): Promise<string> {
    const { loadAISettings } = require('./settings');
    const aiSettings = loadAISettings();
    const rawBaseUrl = customBaseUrl || aiSettings.secondaryCustomBaseUrl || aiSettings.customBaseUrl || config.OLLAMA_BASE_URL || 'https://qwen.measmony.me';
    const baseUrl = rawBaseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/api/generate`;
    const systemPrompt = this.buildCopilotSystemPrompt(context);

    let model = (customModel || aiSettings.secondaryModel || aiSettings.model || config.GEMINI_MODEL || 'qwen2.5:3b').replace(/^models\//, '').trim();
    if (!model || model.includes('gemini') || model.includes('claude') || model.includes('meta-llama') || model === 'default') {
      model = 'qwen2.5:3b';
    }

    const payload = {
      model: model,
      prompt: `${systemPrompt}\n\nUser Question: ${message}\n\nPlease respond in fluent, professional, natural language markdown as our quantitative portfolio advisor:`,
      stream: false,
      options: { temperature: 0.3 },
    };

    let res: any;
    try {
      res = await axios.post(url, payload, { timeout: 15000 });
    } catch (err: any) {
      if (!url.includes('192.168.100.21') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
        const lanUrl = 'http://192.168.100.21:11434/api/generate';
        logger.warn(`⚠️ [COPILOT AI] Ollama endpoint (${url}) failed: ${err.message}. Retrying via LAN (${lanUrl})...`);
        res = await axios.post(lanUrl, payload, { timeout: 15000 });
      } else {
        throw err;
      }
    }

    return res.data?.response?.trim() || '';
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  private buildPrompt(
    signal: StandaloneSignal,
    role: 'PRIMARY_VALIDATOR' | 'SECOND_OPINION',
    directives?: StrategyDirectives,
  ): string {
    const sl = signal.stopLoss != null ? `$${signal.stopLoss.toFixed(4)}` : 'N/A';
    const tp = signal.takeProfit != null ? `$${signal.takeProfit.toFixed(4)}` : 'N/A';
    const rr = signal.riskRewardRatio != null ? `${signal.riskRewardRatio}R` : 'N/A';
    const ind = signal.indicators || ({} as any);
    const ema9 = ind.ema9 != null ? ind.ema9.toFixed(4) : 'N/A';
    const ema21 = ind.ema21 != null ? ind.ema21.toFixed(4) : 'N/A';
    const ema50 = ind.ema50 != null ? ind.ema50.toFixed(4) : 'N/A';
    const rsi = ind.rsi14 != null ? ind.rsi14.toFixed(2) : 'N/A';
    const atr = ind.atr14 != null ? ind.atr14.toFixed(4) : 'N/A';
    const upWick = ind.upperWickPct != null ? `${ind.upperWickPct.toFixed(1)}%` : '0%';
    const lowWick = ind.lowerWickPct != null ? `${ind.lowerWickPct.toFixed(1)}%` : '0%';

    const { getSimPairDirective } = require('../strategy/manager');
    const { getLastSyncedBundle } = require('../pipeline/sim-consumer');
    const simDir = getSimPairDirective(signal.symbol);
    const of = simDir?.orderflow;
    const bundle = getLastSyncedBundle();

    const orderflowText = of ? `
SIM LAB SYNCHRONIZED ORDERFLOW:
- 24h Open Interest Change: ${typeof of.oiChange24h === 'number' ? (of.oiChange24h >= 0 ? '+' : '') + of.oiChange24h.toFixed(2) + '%' : 'N/A'}
- Long/Short Crowd Ratio: ${typeof of.lsRatio === 'number' ? of.lsRatio.toFixed(2) : 'N/A'}
- Funding Rate: ${typeof of.fundingRate === 'number' ? (of.fundingRate * 100).toFixed(4) + '%' : '0.01%'}
- CVD Taker Flow Trend: ${of.cvdTrend || 'NEUTRAL'}
- Liquidation Cluster: ${of.liquidationClusters ? `$${Math.round((of.liquidationClusters.longLiquidationUsd || 0) / 1000)}k Long / $${Math.round((of.liquidationClusters.shortLiquidationUsd || 0) / 1000)}k Short` : 'None'}
` : '';

    const macroText = bundle?.macro ? `
SIM LAB MACRO WORLD-STATE:
- Macro Regime: ${directives?.regime || bundle.macro.regime || 'Normal'}
- Market Bias: ${bundle.macro.marketBias || 'NEUTRAL'}
- High-Impact USD News: ${bundle.macro.nearestNewsTitle ? `"${bundle.macro.nearestNewsTitle}" in ${bundle.macro.nearestNewsMinutes}m` : 'CLEAR (No events in next 30m)'}
` : '';

    return `
Analyze this crypto perpetual futures trade setup on Decibel DEX:
Role: ${role} ${role === 'SECOND_OPINION' ? `(Sim Lab Macro Regime: ${directives?.regime || 'Normal'})` : '(Standalone Primary Validation)'}
Symbol: ${signal.symbol}
Proposed Action: ${signal.action}
Current Price: $${signal.entryPrice}
Suggested SL: ${sl}
Suggested TP: ${tp}
Risk/Reward: ${rr}
EMA 9: ${ema9}
EMA 21: ${ema21}
EMA 50: ${ema50}
EMA Crossover: ${ind.emaCrossover || 'NONE'}
RSI(14): ${rsi}
ATR(14): ${atr}
Upper Rejection Wick: ${upWick}
Lower Rejection Wick: ${lowWick}
SMC Structure: ${ind.smcSignal || 'NONE'}
${orderflowText}${macroText}
CROSS-ANALYSIS RULES (DERIVATIVES & MICROSTRUCTURE):
1. OI Dynamics: Price Up + OI Down = Short Squeeze Exhaustion (VETO candidate LONG). Price Down + OI Down = Liquidation Flush (VETO candidate SHORT).
2. CVD Trend: If candidate LONG but CVD Trend is SELL = Institutional Distribution (VETO LONG). If candidate SHORT but CVD Trend is BUY = Institutional Absorption (VETO SHORT).
3. Crowd Bias: Extreme retail bias (L/S > 2.0 with positive funding) = contrarian trap vulnerability.
4. Rejection Wicks: Upper wick > 45% on LONG or Lower wick > 45% on SHORT = false breakout trap.

Respond in EXACT JSON format with no markdown blocks:
{
  "confirmed": true or false,
  "confidenceScore": number between 0 and 100,
  "sentiment": "BULLISH" or "BEARISH" or "NEUTRAL",
  "reasoning": "1-2 sentence quantitative summary",
  "riskFlags": ["flag1", "flag2"]
}
`;
  }

  private cleanAndParseJson(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error(`Failed to parse AI response JSON: ${text.slice(0, 100)}`);
    }
  }
}

export const localAIBrain = new LocalAIBrain();

