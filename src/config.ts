import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// ─── Helper to extract value from primary or fallback env vars ─────────────────
function envOrFallback(...keys: string[]): string | undefined {
  for (const k of keys) {
    const val = process.env[k];
    if (val !== undefined && val.trim() !== '') {
      return val.trim();
    }
  }
  return undefined;
}

// ─── Environment Pre-Processing ───────────────────────────────────────────────
const rawNetwork = envOrFallback('DECIBEL_NETWORK', 'APTOS_NETWORK') || 'mainnet';
const rawDelegateKey = envOrFallback('DECIBEL_DELEGATE_KEY', 'DECIBEL_PRIVATE_KEY', 'APTOS_PRIVATE_KEY') || '';
const rawSubaccount = envOrFallback('DECIBEL_SUBACCOUNT_ADDRESS') || '';
const rawNodeApiKey = envOrFallback('DECIBEL_NODE_API_KEY', 'DECIBEL_API_KEY') || '';
const rawOwnerAddress = envOrFallback('DECIBEL_APTOS_OWNER_ADDRESS', 'DECIBEL_OWNER_ADDRESS', 'APTOS_WALLET_ADDRESS') || '';

export const DEFAULT_28_PAIRS = 'BTC/USD,ETH/USD,SOL/USD,APT/USD,SUI/USD,XRP/USD,DOGE/USD,BNB/USD,LINK/USD,AVAX/USD,NEAR/USD,ADA/USD,TRX/USD,DOT/USD,HYPE/USD,PEPE/USD,SHIB/USD,LTC/USD,BCH/USD,UNI/USD,FET/USD,TAO/USD,RENDER/USD,ARB/USD,OP/USD,INJ/USD,SEI/USD,TIA/USD';

// ─── Validation Schema ────────────────────────────────────────────────────────
const configSchema = z.object({
  // ── Decibel DEX Credentials ─────────────────────────────────────────────────
  NETWORK: z.enum(['mainnet', 'testnet', 'netna', 'local']).default(rawNetwork as any),
  DECIBEL_DELEGATE_KEY: z.string().default(rawDelegateKey),
  DECIBEL_SUBACCOUNT_ADDRESS: z.string().default(rawSubaccount),
  DECIBEL_NODE_API_KEY: z.string().default(rawNodeApiKey),
  DECIBEL_OWNER_ADDRESS: z.string().default(rawOwnerAddress),
  DECIBEL_API_BASE_URL: z.string().default(() => envOrFallback('DECIBEL_API_BASE_URL') || ''),

  // Backward compatibility alias properties
  DECIBEL_NETWORK: z.enum(['mainnet', 'testnet', 'netna', 'local']).default(rawNetwork as any),
  DECIBEL_PRIVATE_KEY: z.string().default(rawDelegateKey),

  // ── Client AI Brain Selection (Pick ONE or none for local math fallback) ────
  GEMINI_API_KEY: z.string().optional().default(() => envOrFallback('GEMINI_API_KEY') || ''),
  GEMINI_MODEL: z.string().optional().default(() => envOrFallback('GEMINI_MODEL') || 'gemini-2.5-flash'),
  ANTHROPIC_API_KEY: z.string().optional().default(() => envOrFallback('ANTHROPIC_API_KEY') || ''),
  ANTHROPIC_BASE_URL: z.string().default(() => envOrFallback('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com/v1'),
  OLLAMA_BASE_URL: z.string().optional().default(() => envOrFallback('OLLAMA_BASE_URL') || ''),

  // ── Optional Sim Lab AI Cloud Supercharge ────────────────────────────────────
  SIMLAB_KEY: z.string().optional().default(() => envOrFallback('SIMLAB_KEY') || ''),
  SIMLAB_SERVER_URL: z.string().optional().default(() => envOrFallback('SIMLAB_SERVER_URL') || 'https://simlab.measmony.me'),

  // ── Trading Settings ─────────────────────────────────────────────────────────
  BUDGET_USD: z.coerce.number().min(1).default(() => Number(envOrFallback('BUDGET_USD') || 30.0)),
  CLIENT_ID: z.string().default(() => {
    const fromEnv = envOrFallback('CLIENT_ID');
    if (fromEnv) return fromEnv;
    const sub = envOrFallback('DECIBEL_SUBACCOUNT_ADDRESS');
    if (sub && sub.startsWith('0x') && !sub.includes('your_') && sub.length >= 10) {
      return `desk-${sub.slice(2, 10)}`;
    }
    return 'alpha_client_v2';
  }),
  CLIENT_NAME: z.string().default(() => envOrFallback('CLIENT_NAME') || 'Alpha Autonomous Client v2'),
  CLIENT_API_KEY: z.string().default(() => envOrFallback('CLIENT_API_KEY', 'SIMLAB_CONNECTION_TOKEN', 'SIMLAB_KEY') || ''),
  AUTONOMOUS_MODE: z.literal('full').default('full'),
  MIN_CONFIDENCE_PCT: z.coerce.number().default(75),
  MIN_CONFIDENCE_PCT_BREAKOUT: z.coerce.number().default(80),
  MAX_POSITION_ALLOC_PCT: z.coerce.number().default(35),
  SIM_PIPELINE_URL: z.string().default(() => envOrFallback('SIM_PIPELINE_URL') || 'http://192.168.100.21:4000/api/pipeline/alpha-bundle'),
  SIM_PIPELINE_FALLBACK_URL: z.string().default(() => envOrFallback('SIM_PIPELINE_FALLBACK_URL') || 'https://simlab.measmony.me/api/pipeline/alpha-bundle'),
  SIM_PIPELINE_POLL_MS: z.coerce.number().default(() => Number(envOrFallback('SIM_PIPELINE_POLL_MS') || 15000)),
  SIM_TELEMETRY_URL: z.string().default(() => envOrFallback('SIM_TELEMETRY_URL') || 'http://192.168.100.21:4000/api/pipeline/telemetry'),
  SIM_TELEMETRY_FALLBACK_URL: z.string().default(() => envOrFallback('SIM_TELEMETRY_FALLBACK_URL') || 'https://simlab.measmony.me/api/pipeline/telemetry'),
  SIM_TELEMETRY_INTERVAL_MS: z.coerce.number().default(() => Number(envOrFallback('SIM_TELEMETRY_INTERVAL_MS') || 30000)),
  SIM_PIPELINE_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      const lower = String(val).toLowerCase().trim();
      return lower === 'true' || lower === '1' || lower === 'yes';
    })
    .default(() => envOrFallback('SIM_PIPELINE_ENABLED') || 'true'),
  COINGLASS_API_KEY: z.string().default(() => envOrFallback('COINGLASS_API_KEY') || ''),
  COINSTATS_API_KEY: z.string().default(() => envOrFallback('COINSTATS_API_KEY') || ''),
  HF_TOKEN: z.string().default(() => envOrFallback('HF_TOKEN') || ''),
  PAPER_TRADING: z
    .union([z.boolean(), z.string()])
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      const lower = String(val).toLowerCase().trim();
      return lower === 'true' || lower === '1' || lower === 'yes';
    })
    .default(() => envOrFallback('PAPER_TRADING') || 'false'),

  // ── Risk & Execution Parameters ──────────────────────────────────────────────
  MAX_LEVERAGE: z.coerce.number().min(1).max(20).default(5),
  MAX_ALLOC_PCT: z.coerce.number().min(5).max(100).default(35),
  MIN_ALLOC_PCT: z.coerce.number().min(5).max(100).default(15),
  MAX_RISK_PER_TRADE_PCT: z.coerce.number().min(0.1).max(50).default(30),
  MIN_24H_VOLUME_USD: z.coerce.number().default(100_000),
  MAX_FUNDING_RATE_PCT: z.coerce.number().default(0.3),
  // ── Market Watch & Interval ──────────────────────────────────────────────────

  WATCH_PAIRS: z
    .string()
    .default(() => {
      const fromEnv = envOrFallback('WATCH_PAIRS');
      if (fromEnv && fromEnv.split(',').length >= 25) return fromEnv;
      return DEFAULT_28_PAIRS;
    }),
  POLL_INTERVAL_MS: z.coerce.number().default(() => Number(envOrFallback('POLL_INTERVAL_MS') || 15_000)),
  CONFIRMATION_TIMEOUT_MS: z.coerce.number().default(120_000),

  // ── Optional Telegram Alerts (Zero-Failure if omitted) ────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().optional().default(() => envOrFallback('TELEGRAM_BOT_TOKEN') || ''),
  TELEGRAM_CHAT_ID: z.string().optional().default(() => envOrFallback('TELEGRAM_CHAT_ID') || ''),

  // ── Logging & Local Health Server ────────────────────────────────────────────
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FILE: z.string().default('./logs/trading-assistant.log'),
  HEALTH_PORT: z.coerce.number().default(() => Number(envOrFallback('HEALTH_PORT', 'PORT') || 5050)),

  // ── Security & Authentication for Public Server Access ────────────────────────
  ADMIN_PASSWORD: z.string().optional().default(() => envOrFallback('ADMIN_PASSWORD') || ''),
  ONBOARDED: z.boolean().default(false),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  parsed.error.errors.forEach((e) => {
    console.error(`   ${e.path.join('.')}: ${e.message}`);
  });
  process.exit(1);
}

const rawConfig = parsed.data;
if (!rawConfig.WATCH_PAIRS || rawConfig.WATCH_PAIRS.split(',').filter(Boolean).length < 25) {
  rawConfig.WATCH_PAIRS = DEFAULT_28_PAIRS;
}

// ── Helper to detect valid (non-placeholder) API keys ────────────────────────
export function isValidApiKey(k?: string): boolean {
  if (!k) return false;
  const trimmed = k.trim();
  return trimmed.length > 8 && !trimmed.includes('your_') && !trimmed.includes('••••');
}

// ── Helper to synchronize credentials into .env for dual persistence ─────────
import fs from 'fs';
import path from 'path';

export const SETTINGS_FILE_PATH = path.resolve(process.cwd(), 'data/settings.json');

export function syncCredentialsToEnv(updates: Record<string, string | number | boolean | undefined>): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    } else {
      const examplePath = path.resolve(process.cwd(), '.env.example');
      if (fs.existsSync(examplePath)) {
        content = fs.readFileSync(examplePath, 'utf8');
      }
    }

    for (const [key, rawVal] of Object.entries(updates)) {
      if (rawVal === undefined || rawVal === null) continue;
      const val = String(rawVal).trim();
      if (val === '' || val.includes('••••')) continue; // never write empty or masked

      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${val}`);
      } else {
        content += `\n${key}=${val}`;
      }
    }

    fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
  } catch (err: any) {
    console.error('Failed to sync credentials to .env:', err.message);
  }
}

export function loadPersistentSettings(): any {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const raw = fs.readFileSync(SETTINGS_FILE_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

const savedSettings = loadPersistentSettings();

// Merge persistent settings into rawConfig if user modified them via UI
const delegateKey = savedSettings.credentials?.decibelDelegateKey || savedSettings.decibelPrivateKey || savedSettings.decibelDelegateKey;
if (delegateKey && !delegateKey.includes('your_') && delegateKey.length >= 10) {
  rawConfig.DECIBEL_DELEGATE_KEY = delegateKey;
  rawConfig.DECIBEL_PRIVATE_KEY = delegateKey;
}
const subaccount = savedSettings.credentials?.decibelSubaccount || savedSettings.decibelSubaccount;
if (subaccount && !subaccount.includes('your_') && subaccount.length >= 10) {
  rawConfig.DECIBEL_SUBACCOUNT_ADDRESS = subaccount;
}
const nodeApiKey = savedSettings.credentials?.decibelNodeApiKey || savedSettings.decibelNodeApiKey;
if (nodeApiKey) {
  rawConfig.DECIBEL_NODE_API_KEY = nodeApiKey;
}
const ownerAddress = savedSettings.credentials?.decibelOwnerAddress || savedSettings.decibelOwnerAddress;
if (ownerAddress) {
  rawConfig.DECIBEL_OWNER_ADDRESS = ownerAddress;
}
const network = savedSettings.credentials?.network || savedSettings.decibelNetwork || savedSettings.network;
if (network) {
  rawConfig.NETWORK = network as any;
  rawConfig.DECIBEL_NETWORK = network as any;
}

// AI Keys restoration
if (savedSettings.ai) {
  if (isValidApiKey(savedSettings.ai.geminiApiKey)) rawConfig.GEMINI_API_KEY = savedSettings.ai.geminiApiKey;
  if (isValidApiKey(savedSettings.ai.apiKey)) {
    const prov = (savedSettings.ai.provider || savedSettings.aiProvider || '').toLowerCase();
    if (prov === 'claude' || prov === 'anthropic') {
      rawConfig.ANTHROPIC_API_KEY = savedSettings.ai.apiKey;
    } else {
      rawConfig.GEMINI_API_KEY = savedSettings.ai.apiKey;
    }
  }
  if (isValidApiKey(savedSettings.ai.anthropicApiKey)) rawConfig.ANTHROPIC_API_KEY = savedSettings.ai.anthropicApiKey;
  if (savedSettings.ai.anthropicBaseUrl) rawConfig.ANTHROPIC_BASE_URL = savedSettings.ai.anthropicBaseUrl;
  if (savedSettings.ai.ollamaBaseUrl) rawConfig.OLLAMA_BASE_URL = savedSettings.ai.ollamaBaseUrl;
  if (savedSettings.ai.model) rawConfig.GEMINI_MODEL = savedSettings.ai.model;
}
if (isValidApiKey(savedSettings.geminiApiKey)) rawConfig.GEMINI_API_KEY = savedSettings.geminiApiKey;
if (isValidApiKey(savedSettings.aiApiKey)) {
  const prov = (savedSettings.aiProvider || savedSettings.ai?.provider || '').toLowerCase();
  if (prov === 'claude' || prov === 'anthropic') {
    rawConfig.ANTHROPIC_API_KEY = savedSettings.aiApiKey;
  } else {
    rawConfig.GEMINI_API_KEY = savedSettings.aiApiKey;
  }
}
if (savedSettings.aiModel) rawConfig.GEMINI_MODEL = savedSettings.aiModel;

// Telegram restoration
if (savedSettings.telegram?.botToken && !savedSettings.telegram.botToken.includes('••••')) rawConfig.TELEGRAM_BOT_TOKEN = savedSettings.telegram.botToken;
if (savedSettings.telegram?.chatId) rawConfig.TELEGRAM_CHAT_ID = savedSettings.telegram.chatId;
if (savedSettings.telegramBotToken && !savedSettings.telegramBotToken.includes('••••')) rawConfig.TELEGRAM_BOT_TOKEN = savedSettings.telegramBotToken;
if (savedSettings.telegramChatId) rawConfig.TELEGRAM_CHAT_ID = savedSettings.telegramChatId;

const savedBudget = savedSettings.trading?.budgetUsd ?? savedSettings.budgetUsd;
if (savedBudget !== undefined) rawConfig.BUDGET_USD = Number(savedBudget);
if (savedSettings.trading) {
  if (savedSettings.trading.paperTrading !== undefined) rawConfig.PAPER_TRADING = Boolean(savedSettings.trading.paperTrading);
  if (savedSettings.trading.watchPairs && savedSettings.trading.watchPairs.split(',').length >= 25) {
    rawConfig.WATCH_PAIRS = savedSettings.trading.watchPairs;
  }
  if (savedSettings.trading.maxRiskPerTradePct !== undefined) rawConfig.MAX_RISK_PER_TRADE_PCT = Number(savedSettings.trading.maxRiskPerTradePct);
  if (savedSettings.trading.minConfidencePct !== undefined) rawConfig.MIN_CONFIDENCE_PCT = Number(savedSettings.trading.minConfidencePct);
  if (savedSettings.trading.maxLeverage !== undefined) rawConfig.MAX_LEVERAGE = Number(savedSettings.trading.maxLeverage);
}
if (savedSettings.simlab?.key) {
  rawConfig.SIMLAB_KEY = savedSettings.simlab.key;
}
if (savedSettings.pipeline?.clientId) rawConfig.CLIENT_ID = savedSettings.pipeline.clientId;
if (savedSettings.pipeline?.clientName) rawConfig.CLIENT_NAME = savedSettings.pipeline.clientName;
if (savedSettings.pipeline?.apiKey) rawConfig.CLIENT_API_KEY = savedSettings.pipeline.apiKey;
if (savedSettings.pipeline?.pipelineUrl) rawConfig.SIM_PIPELINE_URL = savedSettings.pipeline.pipelineUrl;
if (savedSettings.pipeline?.telemetryUrl) rawConfig.SIM_TELEMETRY_URL = savedSettings.pipeline.telemetryUrl;
if (savedSettings.security?.adminPassword) {
  rawConfig.ADMIN_PASSWORD = savedSettings.security.adminPassword;
}

// Determine Active Operating Mode
const hasSimLabKey = Boolean(rawConfig.SIMLAB_KEY && rawConfig.SIMLAB_KEY.trim().startsWith('simlab_live_'));
const operatingMode: 'STANDALONE' | 'SIMLAB_SUPERCHARGED' = hasSimLabKey ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE';

// Determine Active AI Brain Provider (Honor saved settings choice first, then fallback to auto-detection)
let activeAiProvider: 'gemini' | 'claude' | 'ollama' | 'local_rules' = 'local_rules';
const savedAiProvider = (savedSettings.ai?.provider || savedSettings.aiProvider || '').toLowerCase().trim();
const isAiExplicitlyDisabled = savedSettings.ai?.enabled === false || savedSettings.aiEnabled === false;

if (isAiExplicitlyDisabled || savedAiProvider === 'local_rules') {
  activeAiProvider = 'local_rules';
} else if (savedAiProvider === 'claude' || savedAiProvider === 'anthropic') {
  activeAiProvider = 'claude';
} else if (savedAiProvider === 'ollama') {
  activeAiProvider = 'ollama';
} else if (savedAiProvider === 'gemini') {
  activeAiProvider = 'gemini';
} else {
  // Auto-detection based on valid API keys
  if (isValidApiKey(rawConfig.GEMINI_API_KEY)) {
    activeAiProvider = 'gemini';
  } else if (isValidApiKey(rawConfig.ANTHROPIC_API_KEY)) {
    activeAiProvider = 'claude';
  } else if (rawConfig.OLLAMA_BASE_URL && !rawConfig.OLLAMA_BASE_URL.includes('your_') && rawConfig.OLLAMA_BASE_URL.trim() !== '') {
    activeAiProvider = 'ollama';
  } else {
    activeAiProvider = 'local_rules';
  }
}

function isPlaceholderOrDummy(val?: string): boolean {
  if (!val) return true;
  const s = val.trim().toLowerCase();
  return (
    s === '' ||
    s.includes('your_') ||
    s.includes('abcdef') ||
    s.includes('11112222') ||
    s.includes('placeholder') ||
    s.length < 32 ||
    s === '0x0000000000000000000000000000000000000000000000000000000000000000'
  );
}

const isAlreadyOnboarded = Boolean(
  (savedSettings.onboarded === true || savedSettings.isConfigured === true) &&
  !isPlaceholderOrDummy(rawConfig.DECIBEL_DELEGATE_KEY) &&
  !isPlaceholderOrDummy(rawConfig.DECIBEL_SUBACCOUNT_ADDRESS)
);

export const config = {
  ...rawConfig,
  // Normalized credentials
  DECIBEL_NETWORK: rawConfig.NETWORK,
  DECIBEL_PRIVATE_KEY: rawConfig.DECIBEL_DELEGATE_KEY,
  // Computed architecture flags
  OPERATING_MODE: operatingMode,
  IS_SIMLAB_CONFIGURED: hasSimLabKey,
  ACTIVE_AI_PROVIDER: activeAiProvider,
  ONBOARDED: isAlreadyOnboarded,
};

// ─── Dynamic ClientID Resolution (Collision-Safe Swarm Identity) ───────────────
// Rules:
//  1. If operator explicitly set CLIENT_ID in .env → never override (custom ID wins).
//  2. If a stable ID is already saved in data/identity.json → reuse it (existing user).
//  3. If CLIENT_ID is a known generic collision default AND no Sim Lab key is saved yet
//     → generate a machine-stable hash (brand-new install, safe to assign new ID).
//  4. If CLIENT_ID is generic but user IS already connected to Sim Lab (has a license key)
//     → preserve current ID to avoid breaking the boundClientId license binding.
(function resolveSwarmIdentity() {
  const explicitEnvId = process.env.CLIENT_ID ? process.env.CLIENT_ID.trim() : '';
  if (explicitEnvId) {
    config.CLIENT_ID = explicitEnvId;
    return;
  }

  const GENERIC_DEFAULTS = ['desk-v2-local', 'alpha-client-v2'];
  const currentId = config.CLIENT_ID.trim();
  const isGenericId = GENERIC_DEFAULTS.includes(currentId.toLowerCase());
  const isMissingId = !currentId;

  if (!isGenericId && !isMissingId) {
    // Operator has a custom or subaccount-derived ID — respect it, just audit-log identity
    const { persistIdentity } = require('./utils/machine-id');
    return; // Nothing to do
  }

  // ── Check if already a stable persisted identity on disk ────────────────────
  // This covers existing users who ran a previous build that wrote identity.json
  const identityFilePath = require('path').resolve(process.cwd(), 'data/identity.json');
  try {
    if (require('fs').existsSync(identityFilePath)) {
      const saved = JSON.parse(require('fs').readFileSync(identityFilePath, 'utf8'));
      if (saved?.clientId && typeof saved.clientId === 'string') {
        config.CLIENT_ID = saved.clientId;
        process.stdout.write(
          `\n🆔 [MACHINE IDENTITY] Restored stable CLIENT_ID from disk: ${saved.clientId} (Method: ${saved.method || 'persisted'})\n`
        );
        return;
      }
    }
  } catch { /* unreadable — continue to generate */ }

  // ── Check if this user already has a Sim Lab license key saved ───────────────
  // If yes, they are an EXISTING user: do NOT change their ID or we break their
  // boundClientId license binding in simlab-api-licenses.json.
  const hasSimLabKey = Boolean(
    (config.SIMLAB_KEY && config.SIMLAB_KEY.trim().startsWith('simlab_live_')) ||
    (config.CLIENT_API_KEY && config.CLIENT_API_KEY.trim().startsWith('simlab_live_'))
  );

  if (hasSimLabKey && isGenericId) {
    // Existing user with generic ID + active license → preserve their ID as-is.
    // Sim Lab already knows them by this ID; a change would break license matching.
    process.stdout.write(
      `\n🆔 [MACHINE IDENTITY] Existing Sim Lab user detected — preserving CLIENT_ID: ${currentId} to maintain license binding.\n` +
      `   ⚠️  Consider setting a unique CLIENT_ID in .env to avoid conflicts with other users.\n`
    );
    return;
  }

  // ── Brand-new install: generate machine-stable ID ────────────────────────────
  const apiHint = (config.CLIENT_API_KEY || config.SIMLAB_KEY || '').slice(0, 8);
  const { resolveMachineId: resolve } = require('./utils/machine-id');
  const identity = resolve(apiHint);
  config.CLIENT_ID = identity.clientId;

  const method = identity.method === 'mac_hash' ? 'MAC Hash' : 'Persisted UUID';
  process.stdout.write(
    `\n🆔 [MACHINE IDENTITY] New CLIENT_ID assigned: ${identity.clientId} (Method: ${method}, Stable: ${identity.isStable})\n`
  );
})();


export type Config = typeof config;

export let watchPairs = config.WATCH_PAIRS.split(',').map((p) => p.trim()).filter(Boolean);

/**
 * Checks if the client has real Decibel credentials configured (not dummy placeholders).
 */
export function isClientConfigured(): boolean {
  const key = (config.DECIBEL_DELEGATE_KEY || '').trim();
  const sub = (config.DECIBEL_SUBACCOUNT_ADDRESS || '').trim();

  return !isPlaceholderOrDummy(key) && !isPlaceholderOrDummy(sub);
}

/**
 * Checks if the operator has completed the initial onboarding wizard.
 */
export function isClientOnboarded(): boolean {
  if (!isClientConfigured()) return false;
  try {
    const saved = loadPersistentSettings();
    if (saved.onboarded === true || saved.isConfigured === true) return true;
  } catch {}
  return isClientConfigured();
}

/**
 * Updates settings in data/settings.json and dynamically applies them to the runtime config.
 * Deep-merges parameters and strictly prevents blank/masked strings from overwriting saved credentials.
 */
export function updateDynamicSettings(updates: any): void {
  try {
    const existing = loadPersistentSettings();
    const merged: any = {
      ...existing,
      updatedAt: Date.now(),
      credentials: { ...(existing.credentials || {}) },
      trading: { ...(existing.trading || {}) },
      ai: { ...(existing.ai || {}) },
      telegram: { ...(existing.telegram || {}) },
      harvester: { ...(existing.harvester || {}) },
      simlab: { ...(existing.simlab || {}) },
      pipeline: { ...(existing.pipeline || {}) },
      security: { ...(existing.security || {}) },
    };

    // 1. Decibel Delegate Key & Subaccount Protection
    const rawDelKey = (updates.decibelPrivateKey || updates.decibelDelegateKey || updates.credentials?.decibelDelegateKey || '').trim();
    if (rawDelKey && !rawDelKey.includes('••••') && rawDelKey.length >= 10 && !rawDelKey.includes('your_decibel_delegate_key')) {
      config.DECIBEL_DELEGATE_KEY = rawDelKey;
      config.DECIBEL_PRIVATE_KEY = rawDelKey;
      merged.credentials.decibelDelegateKey = rawDelKey;
      merged.decibelPrivateKey = rawDelKey;
      merged.decibelDelegateKey = rawDelKey;
    } else {
      const keepKey = existing.credentials?.decibelDelegateKey || existing.decibelPrivateKey || existing.decibelDelegateKey;
      if (keepKey) {
        merged.credentials.decibelDelegateKey = keepKey;
        merged.decibelPrivateKey = keepKey;
        merged.decibelDelegateKey = keepKey;
      }
    }

    const rawSub = (updates.decibelSubaccount || updates.credentials?.decibelSubaccount || '').trim();
    const currentSigner = getDerivedSignerAddress(rawDelKey || config.DECIBEL_DELEGATE_KEY);
    if (rawSub && !rawSub.includes('••••') && rawSub.length >= 10 && !rawSub.includes('your_subaccount_address')) {
      if (currentSigner && rawSub.toLowerCase() === currentSigner.toLowerCase()) {
        console.warn(`[Config] Ignored attempt to overwrite Decibel Subaccount with Gas Signer address (${rawSub}). Preserving real subaccount.`);
        const keepSub = existing.credentials?.decibelSubaccount || existing.decibelSubaccount || config.DECIBEL_SUBACCOUNT_ADDRESS;
        if (keepSub) {
          merged.credentials.decibelSubaccount = keepSub;
          merged.decibelSubaccount = keepSub;
        }
      } else {
        config.DECIBEL_SUBACCOUNT_ADDRESS = rawSub;
        merged.credentials.decibelSubaccount = rawSub;
        merged.decibelSubaccount = rawSub;
      }
    } else {
      const keepSub = existing.credentials?.decibelSubaccount || existing.decibelSubaccount || config.DECIBEL_SUBACCOUNT_ADDRESS;
      if (keepSub) {
        merged.credentials.decibelSubaccount = keepSub;
        merged.decibelSubaccount = keepSub;
      }
    }

    const nodeApiKey = updates.decibelNodeApiKey || updates.credentials?.decibelNodeApiKey;
    if (nodeApiKey !== undefined && !nodeApiKey.includes('••••')) {
      config.DECIBEL_NODE_API_KEY = nodeApiKey;
      merged.credentials.decibelNodeApiKey = nodeApiKey;
    }

    const ownerAddress = updates.decibelOwnerAddress || updates.credentials?.decibelOwnerAddress;
    if (ownerAddress !== undefined && !ownerAddress.includes('••••')) {
      config.DECIBEL_OWNER_ADDRESS = ownerAddress;
      merged.credentials.decibelOwnerAddress = ownerAddress;
    }

    const network = updates.decibelNetwork || updates.network || updates.credentials?.network;
    if (network) {
      config.NETWORK = network as any;
      config.DECIBEL_NETWORK = network as any;
      merged.credentials.network = network;
      merged.decibelNetwork = network;
    }

    // 2. Client AI Brain Updates & Safe Key Retention
    if (
      updates.ai ||
      updates.aiModel ||
      updates.aiProvider ||
      updates.aiApiKey ||
      updates.apiKey ||
      updates.enabled !== undefined ||
      updates.provider ||
      updates.model ||
      updates.geminiKey ||
      updates.claudeKey ||
      updates.ollamaUrl ||
      updates.secondaryProvider ||
      updates.secondaryAiProvider ||
      updates.secondaryModel ||
      updates.secondaryAiModel ||
      updates.secondaryApiKey ||
      updates.secondaryAiApiKey ||
      updates.secondaryEnabled !== undefined ||
      updates.secondaryAiEnabled !== undefined
    ) {
      const aiUp = updates.ai || {};
      const prov = (aiUp.provider ?? updates.provider ?? updates.aiProvider ?? config.ACTIVE_AI_PROVIDER ?? 'gemini').toLowerCase().trim();
      const rawKey = (aiUp.apiKey ?? updates.apiKey ?? aiUp.geminiApiKey ?? updates.aiApiKey ?? updates.geminiKey ?? updates.claudeKey ?? '').trim();

      if (rawKey && !rawKey.includes('••••') && rawKey.length > 5 && !rawKey.includes('your_')) {
        if (prov === 'claude' || prov === 'anthropic') {
          config.ANTHROPIC_API_KEY = rawKey;
          merged.ai.anthropicApiKey = rawKey;
        } else if (prov === 'gemini') {
          config.GEMINI_API_KEY = rawKey;
          merged.ai.geminiApiKey = rawKey;
        } else if (prov === 'huggingface' || prov === 'hf') {
          config.HF_TOKEN = rawKey;
          merged.ai.hfToken = rawKey;
          merged.hfToken = rawKey;
        }
        merged.ai.apiKey = rawKey;
        merged.aiApiKey = rawKey;
      }

      if (updates.geminiKey && !updates.geminiKey.includes('••••') && updates.geminiKey.trim().length > 5) {
        config.GEMINI_API_KEY = updates.geminiKey.trim();
        merged.ai.geminiApiKey = updates.geminiKey.trim();
        merged.geminiApiKey = updates.geminiKey.trim();
      }
      if (updates.claudeKey && !updates.claudeKey.includes('••••') && updates.claudeKey.trim().length > 5) {
        config.ANTHROPIC_API_KEY = updates.claudeKey.trim();
        merged.ai.anthropicApiKey = updates.claudeKey.trim();
      }
      if (updates.ollamaUrl && !updates.ollamaUrl.includes('••••')) {
        config.OLLAMA_BASE_URL = updates.ollamaUrl.trim();
        merged.ai.ollamaBaseUrl = updates.ollamaUrl.trim();
      }

      const newModel = (aiUp.model ?? updates.model ?? aiUp.geminiModel ?? updates.aiModel ?? '').trim();
      if (newModel) {
        config.GEMINI_MODEL = newModel;
        merged.ai.model = newModel;
        merged.aiModel = newModel;
      }

      const customUrl = aiUp.customBaseUrl ?? updates.customBaseUrl ?? aiUp.anthropicBaseUrl ?? aiUp.ollamaBaseUrl;
      if (customUrl !== undefined && customUrl.trim() !== '') {
        if (prov === 'claude' || prov === 'anthropic') config.ANTHROPIC_BASE_URL = customUrl.trim();
        if (prov === 'ollama' || prov === 'custom') config.OLLAMA_BASE_URL = customUrl.trim();
        merged.ai.customBaseUrl = customUrl.trim();
      }

      const isEnabled = aiUp.enabled ?? updates.enabled ?? updates.aiEnabled;
      if (isEnabled !== undefined) {
        merged.ai.enabled = Boolean(isEnabled);
        merged.aiEnabled = Boolean(isEnabled);
      }

      if (aiUp.secondaryProvider || updates.secondaryProvider || updates.secondaryAiProvider) {
        const secProvNorm = (aiUp.secondaryProvider || updates.secondaryProvider || updates.secondaryAiProvider).toLowerCase();
        merged.ai.secondaryProvider = secProvNorm as any;
        merged.secondaryProvider = secProvNorm;
        merged.secondaryAiProvider = secProvNorm;
      }
      if (aiUp.secondaryModel || updates.secondaryModel || updates.secondaryAiModel) {
        const secModelNorm = (aiUp.secondaryModel || updates.secondaryModel || updates.secondaryAiModel).trim();
        merged.ai.secondaryModel = secModelNorm;
        merged.secondaryModel = secModelNorm;
        merged.secondaryAiModel = secModelNorm;
      }
      if (aiUp.secondaryCustomBaseUrl !== undefined || updates.secondaryCustomBaseUrl !== undefined || updates.secondaryUrl !== undefined) {
        const secUrl = (aiUp.secondaryCustomBaseUrl ?? updates.secondaryCustomBaseUrl ?? updates.secondaryUrl ?? '').trim();
        merged.ai.secondaryCustomBaseUrl = secUrl;
        merged.secondaryCustomBaseUrl = secUrl;
      }
      const sRawKey = (aiUp.secondaryApiKey || updates.secondaryApiKey || updates.secondaryAiApiKey || '').trim();
      if (sRawKey && !sRawKey.includes('••••') && sRawKey.length > 5) {
        merged.ai.secondaryApiKey = sRawKey;
        merged.secondaryApiKey = sRawKey;
        merged.secondaryAiApiKey = sRawKey;
        if (merged.ai.secondaryProvider === 'huggingface' || merged.ai.secondaryProvider === 'hf') {
          config.HF_TOKEN = sRawKey;
          merged.ai.hfToken = sRawKey;
          merged.hfToken = sRawKey;
        }
      }
      if (aiUp.secondaryEnabled !== undefined || updates.secondaryEnabled !== undefined || updates.secondaryAiEnabled !== undefined) {
        const secEnabledVal = Boolean(aiUp.secondaryEnabled ?? updates.secondaryEnabled ?? updates.secondaryAiEnabled);
        merged.ai.secondaryEnabled = secEnabledVal;
        merged.secondaryEnabled = secEnabledVal;
        merged.secondaryAiEnabled = secEnabledVal;
      }

      if (isEnabled === false || prov === 'local_rules') {
        config.ACTIVE_AI_PROVIDER = 'local_rules' as any;
        merged.ai.provider = 'local_rules';
        merged.aiProvider = 'local_rules';
      } else {
        config.ACTIVE_AI_PROVIDER = prov as any;
        merged.ai.provider = prov;
        merged.aiProvider = prov;
      }

      // Persist to ai-settings.json
      try {
        const { saveAISettings } = require('./ai/settings');
        saveAISettings(merged.ai);
      } catch {}
    }

    // 3. Trading & Risk Parameters
    const tradingUpdates = updates.trading || updates;
    if (tradingUpdates) {
      if (tradingUpdates.budgetUsd !== undefined) {
        config.BUDGET_USD = Number(tradingUpdates.budgetUsd);
        merged.budgetUsd = config.BUDGET_USD;
        merged.trading.budgetUsd = config.BUDGET_USD;
      }
      if (tradingUpdates.maxPositionUsd !== undefined) {
        const rawMaxPos = Number(tradingUpdates.maxPositionUsd);
        const safeMaxPos = Math.min(rawMaxPos, config.BUDGET_USD);
        merged.maxPositionUsd = safeMaxPos;
        merged.trading.maxPositionUsd = safeMaxPos;
      }
      if (tradingUpdates.paperTrading !== undefined) {
        config.PAPER_TRADING = Boolean(tradingUpdates.paperTrading);
        merged.trading.paperTrading = config.PAPER_TRADING;
      }
      if (tradingUpdates.watchPairs) {
        config.WATCH_PAIRS = tradingUpdates.watchPairs;
        watchPairs = config.WATCH_PAIRS.split(',').map((p) => p.trim()).filter(Boolean);
        merged.trading.watchPairs = config.WATCH_PAIRS;
      }
      if (tradingUpdates.maxRiskPerTradePct !== undefined) {
        config.MAX_RISK_PER_TRADE_PCT = Number(tradingUpdates.maxRiskPerTradePct);
        merged.trading.maxRiskPerTradePct = config.MAX_RISK_PER_TRADE_PCT;
      }
      if (tradingUpdates.minConfidencePct !== undefined) {
        config.MIN_CONFIDENCE_PCT = Number(tradingUpdates.minConfidencePct);
        merged.trading.minConfidencePct = config.MIN_CONFIDENCE_PCT;
      }
      if (tradingUpdates.maxLeverage !== undefined) {
        config.MAX_LEVERAGE = Number(tradingUpdates.maxLeverage);
        merged.trading.maxLeverage = config.MAX_LEVERAGE;
      }
      if (tradingUpdates.mode || tradingUpdates.autonomousMode) {
        config.AUTONOMOUS_MODE = 'full';
        merged.trading.mode = 'full';
      }
    }

    // 4. Telegram Notification Credentials & Safe Retention
    const tgToken = (updates.telegramBotToken || updates.telegram?.botToken || '').trim();
    const tgChatId = (updates.telegramChatId !== undefined ? updates.telegramChatId : updates.telegram?.chatId !== undefined ? updates.telegram?.chatId : '').trim();
    const tgEnabled = updates.telegramEnabled ?? updates.telegram?.enabled;

    if (tgToken && !tgToken.includes('••••') && tgToken.length > 5) {
      config.TELEGRAM_BOT_TOKEN = tgToken;
      merged.telegram.botToken = tgToken;
      merged.telegramBotToken = tgToken;
    } else if (existing.telegram?.botToken || existing.telegramBotToken) {
      const keepToken = existing.telegram?.botToken || existing.telegramBotToken;
      merged.telegram.botToken = keepToken;
      merged.telegramBotToken = keepToken;
    }

    if (tgChatId && !tgChatId.includes('••••')) {
      config.TELEGRAM_CHAT_ID = tgChatId;
      merged.telegram.chatId = tgChatId;
      merged.telegramChatId = tgChatId;
    } else if (existing.telegram?.chatId || existing.telegramChatId) {
      const keepChatId = existing.telegram?.chatId || existing.telegramChatId;
      merged.telegram.chatId = keepChatId;
      merged.telegramChatId = keepChatId;
    }

    if (tgEnabled !== undefined) {
      merged.telegram.enabled = Boolean(tgEnabled);
    }

    // 5. Sim Lab & Fleet Pipeline
    if (updates.simlab?.key !== undefined) {
      config.SIMLAB_KEY = updates.simlab.key;
      const hasSimLab = Boolean(config.SIMLAB_KEY && config.SIMLAB_KEY.trim().startsWith('simlab_live_'));
      config.OPERATING_MODE = hasSimLab ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE';
      config.IS_SIMLAB_CONFIGURED = hasSimLab;
      merged.simlab = { ...(merged.simlab || {}), ...updates.simlab };
    }
    if (updates.pipeline) {
      if (updates.pipeline.clientId) config.CLIENT_ID = updates.pipeline.clientId;
      if (updates.pipeline.clientName) config.CLIENT_NAME = updates.pipeline.clientName;
      if (updates.pipeline.apiKey !== undefined) config.CLIENT_API_KEY = updates.pipeline.apiKey;
      if (updates.pipeline.pipelineUrl) config.SIM_PIPELINE_URL = updates.pipeline.pipelineUrl;
      if (updates.pipeline.telemetryUrl) config.SIM_TELEMETRY_URL = updates.pipeline.telemetryUrl;
      if (updates.pipeline.enabled !== undefined) config.SIM_PIPELINE_ENABLED = Boolean(updates.pipeline.enabled);
      merged.pipeline = { ...(merged.pipeline || {}), ...updates.pipeline };
    }

    // 6. Security Admin Password
    if (updates.security?.adminPassword !== undefined) {
      config.ADMIN_PASSWORD = updates.security.adminPassword;
      merged.security.adminPassword = updates.security.adminPassword;
    } else if (updates.adminPassword !== undefined) {
      config.ADMIN_PASSWORD = updates.adminPassword;
      merged.security.adminPassword = updates.adminPassword;
    }

    // 7. Onboarding Status Guarantee (once onboarded, never reset)
    if (updates.onboarded !== undefined) {
      merged.onboarded = Boolean(updates.onboarded);
      (config as any).ONBOARDED = Boolean(updates.onboarded);
    } else if (existing.onboarded !== undefined) {
      merged.onboarded = Boolean(existing.onboarded);
      (config as any).ONBOARDED = Boolean(existing.onboarded);
    } else if (isClientConfigured()) {
      merged.onboarded = true;
      (config as any).ONBOARDED = true;
    }

    // 8. Atomic Disk Write & .env Synchronization
    fs.mkdirSync(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(merged, null, 2), 'utf8');

    syncCredentialsToEnv({
      DECIBEL_SUBACCOUNT_ADDRESS: config.DECIBEL_SUBACCOUNT_ADDRESS,
      DECIBEL_DELEGATE_KEY: config.DECIBEL_DELEGATE_KEY,
      DECIBEL_NETWORK: config.NETWORK,
      GEMINI_API_KEY: config.GEMINI_API_KEY,
      ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
      TELEGRAM_BOT_TOKEN: config.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: config.TELEGRAM_CHAT_ID,
      BUDGET_USD: config.BUDGET_USD,
      PAPER_TRADING: config.PAPER_TRADING,
    });
  } catch (err: any) {
    console.error('Failed to update persistent settings:', err.message);
  }
}

/**
 * Dynamically derives the Aptos public address from the configured DECIBEL_PRIVATE_KEY.
 * Guarantees Option B (Non-Custodial) isolation: the client bot monitors its own signer key.
 */
export function getDerivedSignerAddress(privateKey?: string): string {
  const pk = privateKey || config.DECIBEL_PRIVATE_KEY || config.DECIBEL_DELEGATE_KEY;
  if (!pk) return '';
  try {
    const { Account, Ed25519PrivateKey } = require('@aptos-labs/ts-sdk');
    const cleanPk = pk.replace(/^ed25519-priv-/, '').trim();
    const edPk = new Ed25519PrivateKey(cleanPk);
    const account = Account.fromPrivateKey({ privateKey: edPk });
    return account.accountAddress.toString();
  } catch {
    return '';
  }
}/**
 * Built-in candidate URLs for Sim Lab Alpha Pipeline.
 * Auto-probed on VPS / Cloud or local network without requiring manual UI entry.
 */
export const DEFAULT_SIMLAB_CANDIDATE_URLS: string[] = [
  'https://simlab.measmony.me',
  'https://alphaforge.measmony.me',
  'https://alphaauto.measmony.me',
  'http://192.168.100.21:4000',
  'http://localhost:4000',
];

/**
 * Returns formatted AI settings for UI presentation and API consumption.
 */
export function getAISettings(): any {
  const saved = loadPersistentSettings();
  const aiSaved = saved.ai || {};
  const currentProv = config.ACTIVE_AI_PROVIDER;
  const activeKey = (currentProv === 'claude' ? config.ANTHROPIC_API_KEY : config.GEMINI_API_KEY) || aiSaved.apiKey || aiSaved.geminiApiKey || '';
  const maskedKey = activeKey ? `${activeKey.slice(0, 4)}...${activeKey.slice(-4)}` : '';

  return {
    success: true,
    enabled: currentProv !== 'local_rules' && Boolean(activeKey || config.OLLAMA_BASE_URL),
    provider: (aiSaved.provider || (currentProv === 'local_rules' ? 'gemini' : currentProv) || 'gemini').toLowerCase(),
    model: config.GEMINI_MODEL || aiSaved.model || 'gemini-2.5-flash',
    hasApiKey: Boolean(activeKey && activeKey.trim() !== ''),
    apiKeyMasked: maskedKey,
    customBaseUrl: config.ANTHROPIC_BASE_URL || config.OLLAMA_BASE_URL || aiSaved.customBaseUrl || '',
    temperature: aiSaved.temperature ?? 0.2,
    useForCopilot: aiSaved.useForCopilot ?? true,
    useForTradeValidation: aiSaved.useForTradeValidation ?? true,
    primaryIntelligenceSource: aiSaved.primaryIntelligenceSource ?? 'hybrid',
    tradeValidationMode: aiSaved.tradeValidationMode ?? 'smart_hybrid',
    hybridThresholdPct: aiSaved.hybridThresholdPct ?? 65,
    macroAdvisorMode: aiSaved.macroAdvisorMode ?? 'sim_primary_with_fallback',
    tradePostMortemMode: aiSaved.tradePostMortemMode ?? 'off_sim_delegated',
    bypassLocalAiWhenSimActive: aiSaved.bypassLocalAiWhenSimActive ?? true,
    autoFailoverToLocalAi: aiSaved.autoFailoverToLocalAi ?? true,
    settings: {
      provider: (aiSaved.provider || (currentProv === 'local_rules' ? 'gemini' : currentProv) || 'gemini').toLowerCase(),
      model: config.GEMINI_MODEL || aiSaved.model || 'gemini-2.5-flash',
      enabled: currentProv !== 'local_rules' && Boolean(activeKey || config.OLLAMA_BASE_URL),
      hasApiKey: Boolean(activeKey && activeKey.trim() !== ''),
    }
  };
}

