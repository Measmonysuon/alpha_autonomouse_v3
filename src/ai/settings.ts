/**
 * AI Model Settings Manager
 * Persists provider, API keys, and model preferences to data/ai-settings.json.
 */

import fs from 'fs';
import { writeJsonAtomicSync } from '../utils/atomic-write';
import path from 'path';
import { logger } from '../utils/logger';
import { config, isValidApiKey } from '../config';

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

  // ── Third Tier AI (Tertiary Backup: Muse via the VM muse-bridge) ──
  tertiaryEnabled?: boolean;
  tertiaryBaseUrl?: string;
  tertiaryTimeoutMs?: number;

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

  // Third Tier AI Defaults (Muse bridge co-decision backup)
  tertiaryEnabled: true,
  tertiaryBaseUrl: 'http://127.0.0.1:9100',
  tertiaryTimeoutMs: 120000,

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
    writeJsonAtomicSync(SETTINGS_FILE, updated);
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

// ── Effective AI brain (dynamic, config-driven) ─────────────────────────────
// Mirrors the resolution the Quant Engine applies in src/ai/brain.ts:
// Primary -> Secondary -> Muse bridge (tertiary) -> Local Rules. A tier is
// "configured" only when it is enabled AND has what it needs to actually run
// (an API key, or a custom base URL for keyless/local endpoints). Computed
// from the same cached settings object the engine reads, so the dashboard
// can never disagree with the engine. Adding/removing a key changes the
// result immediately — no restart.
export type AiTierId = 'primary' | 'secondary' | 'muse_bridge' | 'local_rules';

export interface AiChainTier {
  tier: AiTierId;
  label: string;
  configured: boolean;
  active: boolean;
  detail: string;
}

export interface AiBrainStatus {
  effective: AiTierId;
  effectiveLabel: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  chain: AiChainTier[];
}

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Google Gemini',
  anthropic: 'Claude AI',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  huggingface: 'Hugging Face',
  custom: 'Custom Endpoint',
};

export function getAiBrainStatus(): AiBrainStatus {
  const s = loadAISettings();
  // A key counts only if it is a REAL key by the app's own validity rule —
  // .env.example ships a "your_..." placeholder that must not make a fresh
  // install look configured (it would hide the Muse bridge fallback).
  const hasKey = (k?: string) => isValidApiKey(k);

  const primaryConfigured = Boolean(
    s.enabled && s.provider && s.provider !== ('local_rules' as AIProvider) &&
    (hasKey(s.apiKey) || hasKey(s.geminiApiKey) || hasKey(s.customBaseUrl)),
  );
  const secondaryConfigured = Boolean(
    s.secondaryEnabled && s.secondaryProvider &&
    s.secondaryProvider !== ('local_rules' as AIProvider) &&
    (hasKey(s.secondaryApiKey) || hasKey(s.secondaryCustomBaseUrl)),
  );
  const bridgeConfigured = Boolean(s.enabled !== false && s.tertiaryEnabled !== false);

  let effective: AiTierId = 'local_rules';
  if (s.enabled !== false) {
    if (primaryConfigured) effective = 'primary';
    else if (secondaryConfigured) effective = 'secondary';
    else if (bridgeConfigured) effective = 'muse_bridge';
  }

  const providerLabel = (p?: string) => PROVIDER_LABELS[p || ''] || (p ? p.toUpperCase() : '—');
  const chain: AiChainTier[] = [
    {
      tier: 'primary',
      label: providerLabel(s.provider),
      configured: primaryConfigured,
      active: effective === 'primary',
      detail: primaryConfigured ? `${providerLabel(s.provider)} · ${s.model || ''}`.trim() : 'No API key configured',
    },
    {
      tier: 'secondary',
      label: providerLabel(s.secondaryProvider),
      configured: secondaryConfigured,
      active: effective === 'secondary',
      detail: secondaryConfigured ? `${providerLabel(s.secondaryProvider)} · ${s.secondaryModel || ''}`.trim() : (s.secondaryEnabled ? 'No API key configured' : 'Disabled'),
    },
    {
      tier: 'muse_bridge',
      label: 'Muse AI (Bridge)',
      configured: bridgeConfigured,
      active: effective === 'muse_bridge',
      detail: bridgeConfigured ? `Backup brain via ${s.tertiaryBaseUrl || 'http://127.0.0.1:9100'}` : 'Disabled',
    },
    {
      tier: 'local_rules',
      label: 'Local Rules',
      configured: true,
      active: effective === 'local_rules',
      detail: 'Built-in quantitative rules (offline fallback)',
    },
  ];

  return {
    effective,
    effectiveLabel: chain.find((t) => t.tier === effective)?.label || 'Local Rules',
    effectiveProvider: effective === 'primary' ? s.provider : effective === 'secondary' ? s.secondaryProvider : undefined,
    effectiveModel: effective === 'primary' ? s.model : effective === 'secondary' ? s.secondaryModel : undefined,
    chain,
  };
}
