/**
 * AI Model Settings Manager
 * Persists provider, API keys, and model preferences to data/ai-settings.json.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { config } from '../config';

export type AIProvider = 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'huggingface' | 'custom';

export interface AISettings {
  enabled: boolean;
  provider: AIProvider;
  apiKey: string;
  model: string;
  customBaseUrl?: string;
  temperature: number;
  useForCopilot: boolean;
  useForTradeValidation: boolean;
  geminiApiKey?: string;
  hfToken?: string;

  // ── Second Tier AI Brand (Secondary / Auto Failover Provider) ──
  secondaryEnabled?: boolean;
  secondaryProvider?: AIProvider;
  secondaryApiKey?: string;
  secondaryModel?: string;
  secondaryCustomBaseUrl?: string;

  // Intelligence Routing & Fallback Controls
  primaryIntelligenceSource: 'sim_lab' | 'local_ai' | 'hybrid';
  bypassLocalAiWhenSimActive: boolean;
  autoFailoverToLocalAi: boolean;
  tradeValidationMode: 'off' | 'failover_only' | 'always_on' | 'smart_hybrid';
  hybridThresholdPct?: number;
  macroAdvisorMode: 'sim_primary_with_fallback' | 'sim_only' | 'local_always';
  tradePostMortemMode: 'off_sim_delegated' | 'failover_only' | 'always_on';
}

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'ai-settings.json');

const DEFAULT_SETTINGS: AISettings = {
  enabled: true,
  provider: 'gemini',
  apiKey: config.GEMINI_API_KEY || '',
  model: 'gemini-1.5-flash',
  customBaseUrl: '',
  temperature: 0.3,
  useForCopilot: true,
  useForTradeValidation: false,
  geminiApiKey: config.GEMINI_API_KEY || '',
  hfToken: config.HF_TOKEN || '',

  // Second Tier AI Defaults
  secondaryEnabled: false,
  secondaryProvider: 'anthropic',
  secondaryApiKey: config.ANTHROPIC_API_KEY || '',
  secondaryModel: 'claude-3-5-sonnet-20241022',
  secondaryCustomBaseUrl: '',

  // Intelligence Routing Defaults
  primaryIntelligenceSource: 'hybrid',
  bypassLocalAiWhenSimActive: true,
  autoFailoverToLocalAi: true,
  tradeValidationMode: 'smart_hybrid',
  hybridThresholdPct: 65,
  macroAdvisorMode: 'sim_primary_with_fallback',
  tradePostMortemMode: 'off_sim_delegated',
};

let cachedSettings: AISettings | null = null;

export function loadAISettings(): AISettings {
  if (cachedSettings) return cachedSettings;

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      cachedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      return cachedSettings!;
    }
  } catch (err) {
    logger.error(`Failed to load AI settings: ${(err as Error).message}`);
  }

  cachedSettings = { ...DEFAULT_SETTINGS };
  return cachedSettings;
}

export function saveAISettings(settings: Partial<AISettings>): AISettings {
  const current = loadAISettings();

  // If apiKey wasn't sent or was masked (contains '••••'), retain the current key
  let apiKey = settings.apiKey;
  if (!apiKey || apiKey.includes('••••')) {
    apiKey = current.apiKey;
  }

  let secondaryApiKey = settings.secondaryApiKey;
  if (!secondaryApiKey || secondaryApiKey.includes('••••')) {
    secondaryApiKey = current.secondaryApiKey || '';
  }

  const updated: AISettings = {
    ...current,
    ...settings,
    apiKey,
    secondaryApiKey,
  };

  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    cachedSettings = updated;
    logger.info(`💾 AI settings saved (Primary: ${updated.provider}/${updated.model}, Secondary: ${updated.secondaryProvider}/${updated.secondaryModel}, Enabled: ${updated.enabled})`);
  } catch (err) {
    logger.error(`Failed to save AI settings: ${(err as Error).message}`);
    throw err;
  }

  return updated;
}

export function getMaskedAISettings(): Omit<AISettings, 'apiKey'> & { apiKeyMasked: string; hasApiKey: boolean; secondaryApiKeyMasked: string; hasSecondaryApiKey: boolean } {
  const s = loadAISettings();
  const hasApiKey = Boolean(s.apiKey && s.apiKey.trim().length > 0);
  let apiKeyMasked = '';

  if (hasApiKey) {
    const key = s.apiKey.trim();
    if (key.length <= 8) {
      apiKeyMasked = '••••••••';
    } else {
      apiKeyMasked = key.slice(0, 4) + '••••••••' + key.slice(-4);
    }
  }

  const hasSecondaryApiKey = Boolean(s.secondaryApiKey && s.secondaryApiKey.trim().length > 0);
  let secondaryApiKeyMasked = '';
  if (hasSecondaryApiKey) {
    const sKey = (s.secondaryApiKey || '').trim();
    if (sKey.length <= 8) {
      secondaryApiKeyMasked = '••••••••';
    } else {
      secondaryApiKeyMasked = sKey.slice(0, 4) + '••••••••' + sKey.slice(-4);
    }
  }

  return {
    enabled: s.enabled,
    provider: s.provider,
    model: s.model,
    customBaseUrl: s.customBaseUrl,
    temperature: s.temperature,
    useForCopilot: s.useForCopilot,
    useForTradeValidation: s.useForTradeValidation,
    secondaryEnabled: Boolean(s.secondaryEnabled),
    secondaryProvider: s.secondaryProvider || 'anthropic',
    secondaryApiKey: s.secondaryApiKey || '',
    secondaryModel: s.secondaryModel || 'claude-3-5-sonnet-20241022',
    secondaryCustomBaseUrl: s.secondaryCustomBaseUrl || '',
    primaryIntelligenceSource: s.primaryIntelligenceSource || 'hybrid',
    bypassLocalAiWhenSimActive: s.bypassLocalAiWhenSimActive !== false,
    autoFailoverToLocalAi: s.autoFailoverToLocalAi !== false,
    tradeValidationMode: s.tradeValidationMode || 'smart_hybrid',
    hybridThresholdPct: s.hybridThresholdPct ?? 65,
    macroAdvisorMode: s.macroAdvisorMode || 'sim_primary_with_fallback',
    tradePostMortemMode: s.tradePostMortemMode || 'off_sim_delegated',
    hasApiKey,
    apiKeyMasked,
    hasSecondaryApiKey,
    secondaryApiKeyMasked,
  };
}
