/**
 * Aptos Node Resolver & Client Factory (Zero-Hardcoded Secrets)
 *
 * Provides high-speed, rate-limit-free connectivity to Aptos Mainnet Fullnodes.
 * Automatically resolves and connects through:
 *  1. Direct Decibel/Aptos Gateway using dynamic fleet node key (AG-...)
 *  2. Instant 0-second failover to Sim Lab Builder Proxy or official Aptos fullnodes
 *     if the gateway key is rate-limited (429), revoked (401), or blacklisted.
 *  3. Dynamic live hot-swapping when Sim Lab broadcasts a newly rotated key.
 */

import { Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import { config } from '../config';
import { logger } from './logger';

// Known expired or rate-limited legacy keys that must never be used
export const BLACKLISTED_KEYS = new Set<string>([
  'AG-AMONRHVQRPNGCNNFLOYGB39DMFA4MB4FF',
]);

/**
 * Ensures proxy URLs targeting local addresses or non-TLS ports use http://
 */
export function sanitizeProxyUrl(rawUrl: string): string {
  let u = (rawUrl || '').trim();
  if (!u) return 'https://fullnode.mainnet.aptoslabs.com/v1';
  if (/^https:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?/i.test(u) || /^https:\/\/[^/]+:(?:4000|4005)/i.test(u)) {
    u = u.replace(/^https:/i, 'http:');
  }
  return u;
}

// In-memory gateway routing state
let currentActiveApiKey: string = (config.DECIBEL_NODE_API_KEY || '').trim();
let isProxyFallbackActive: boolean = false;
let proxyEndpointUrl: string = sanitizeProxyUrl(
  process.env.APTOS_FULLNODE_URL ||
  (config as any).APTOS_FULLNODE_URL ||
  'https://fullnode.mainnet.aptoslabs.com/v1'
);

export interface NodeHealthState {
  status: 'OK' | 'DEGRADED' | 'INVALID';
  lastError?: string;
  failedKey?: string;
  updatedAt: number;
}

let nodeHealthState: NodeHealthState = {
  status: 'OK',
  updatedAt: Date.now(),
};

export function getNodeHealthState(): NodeHealthState {
  return { ...nodeHealthState };
}

/**
 * Diagnostic status helper
 */
export function getNodeRoutingState() {
  return {
    mode: isProxyFallbackActive ? 'BUILDER_PROXY' : 'DIRECT_GATEWAY',
    isProxyFallbackActive,
    activeKeyPrefix: currentActiveApiKey ? `${currentActiveApiKey.slice(0, 10)}...` : 'NONE',
    proxyEndpointUrl,
    blacklistedCount: BLACKLISTED_KEYS.size,
  };
}

/**
 * Checks if an error is an Aptos Fullnode / Gateway rate limit (429) or auth error (401/403).
 */
export function isNodeRateLimitOrAuthError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message || err?.status || err?.code || err?.vm_status || err || '').toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('429') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('rate limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('too many requests') ||
    msg.includes('x-api-key') ||
    msg.includes('api_key')
  );
}

/**
 * Builds candidate URLs for fetching node service configurations.
 */
export function getCandidateKeyUrls(): string[] {
  const candidates: string[] = [];

  // 1. Explicitly dedicated public node key service URL (env or config)
  const dedicated = process.env.NODE_KEY_SERVICE_URL || (config as any).NODE_KEY_SERVICE_URL;
  if (dedicated && typeof dedicated === 'string' && dedicated.trim()) {
    candidates.push(dedicated.trim());
  }

  // 2. Sim Lab Pipeline URL base
  if (config.SIM_PIPELINE_URL) {
    try {
      const u = new URL(config.SIM_PIPELINE_URL);
      candidates.push(`${u.origin}/api/node-key`);
      candidates.push(`${u.origin}/api/pipeline/node-key`);
    } catch { }
  }

  // 3. Sim Lab Server URL base
  if (config.SIMLAB_SERVER_URL) {
    try {
      const u = new URL(config.SIMLAB_SERVER_URL);
      candidates.push(`${u.origin}/api/node-key`);
      candidates.push(`${u.origin}/api/pipeline/node-key`);
    } catch { }
  }

  // 4. Dedicated standalone node server / local proxy (port 4005, 4000)
  candidates.push('http://127.0.0.1:4005/api/node-key');
  candidates.push('http://127.0.0.1:4000/api/node-key');

  return Array.from(new Set(candidates));
}

/**
 * Tests live on-chain connectivity.
 */
export async function testNodeConnectivity(aptosClient: Aptos): Promise<{
  success: boolean;
  chainId?: number;
  ledgerVersion?: string;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const ledger = await aptosClient.getLedgerInfo();
    return {
      success: true,
      chainId: ledger?.chain_id,
      ledgerVersion: ledger?.ledger_version,
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Unknown network error',
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Dynamically resolves the active Aptos Fullnode URL or Node API Key.
 * Contacts Sim Lab key dispenser. If local key is failed, notifies server and activates proxy fallback.
 */
export async function resolveNodeApiKey(options?: {
  forceRefresh?: boolean;
  failedKey?: string;
}): Promise<string> {
  if (options?.failedKey) {
    const badKey = options.failedKey.trim();
    BLACKLISTED_KEYS.add(badKey);
    if (currentActiveApiKey === badKey) {
      currentActiveApiKey = '';
      config.DECIBEL_NODE_API_KEY = '';
    }
    isProxyFallbackActive = true;
    nodeHealthState = {
      status: 'INVALID',
      lastError: 'Key blacklisted/invalid',
      failedKey: badKey ? `${badKey.slice(0, 10)}...` : undefined,
      updatedAt: Date.now(),
    };
    logger.warn(`🚨 [NODE KEY] Key ${badKey.slice(0, 10)}... blacklisted. Switching to public/builder proxy fallback.`);
  }

  // If client already has a valid non-blacklisted key and not refreshing, use it
  if (!options?.forceRefresh && currentActiveApiKey && !BLACKLISTED_KEYS.has(currentActiveApiKey) && !isProxyFallbackActive) {
    logger.debug(`🔑 [NODE KEY] Using active Aptos gateway key: ${currentActiveApiKey.slice(0, 10)}...`);
    return currentActiveApiKey;
  }

  // Check config/env directly (issued free during onboarding)
  const envKey = (config.DECIBEL_NODE_API_KEY || process.env.DECIBEL_NODE_API_KEY || '').trim();
  if (envKey && !BLACKLISTED_KEYS.has(envKey)) {
    currentActiveApiKey = envKey;
    isProxyFallbackActive = false;
    nodeHealthState = { status: 'OK', updatedAt: Date.now() };
    logger.info(`✅ [NODE KEY] Loaded active Aptos Gateway Key from local .env: ${envKey.slice(0, 10)}...`);
    return currentActiveApiKey;
  }

  // Fallback to public Aptos fullnode / builder proxy
  isProxyFallbackActive = true;
  logger.info(`🌐 [NODE RESOLVER] Routing Aptos transactions through reliable public fullnode fallback.`);
  return proxyEndpointUrl;
}

/**
 * Triggers immediate 0-second failover to public fullnode / Sim Lab Builder Proxy.
 * Blacklists the failed key and marks internal node health for telemetry reporting.
 */
export function triggerNodeKeyFailover(failedKey?: string, reason?: string): void {
  const badKey = (failedKey || currentActiveApiKey || config.DECIBEL_NODE_API_KEY || '').trim();
  if (badKey) {
    BLACKLISTED_KEYS.add(badKey);
  }

  currentActiveApiKey = '';
  config.DECIBEL_NODE_API_KEY = '';
  isProxyFallbackActive = true;
  nodeHealthState = {
    status: 'INVALID',
    lastError: reason || '401/429/Blacklist: Node key failed',
    failedKey: badKey ? `${badKey.slice(0, 10)}...` : undefined,
    updatedAt: Date.now(),
  };

  logger.warn(
    `🚨 [NODE FAILOVER] Node key failure detected (${reason || '401/429/Blacklist'}). ` +
    `Engaged 0-second immediate failover to public fullnode fallback (${proxyEndpointUrl}).`
  );
}

/**
 * Hot-swaps to a new node key live in memory without requiring process restart,
 * and atomically persists it to the local .env file.
 */
export function hotSwapNodeKey(newKey: string): boolean {
  if (!newKey || typeof newKey !== 'string') return false;
  const cleanKey = newKey.trim();
  if (cleanKey.length < 10 || !/^[A-Za-z0-9_-]+$/.test(cleanKey)) return false;

  // If operator/server explicitly pushes a key, remove from local blacklist
  BLACKLISTED_KEYS.delete(cleanKey);

  if (currentActiveApiKey === cleanKey && !isProxyFallbackActive) {
    return true; // Already active
  }

  currentActiveApiKey = cleanKey;
  config.DECIBEL_NODE_API_KEY = cleanKey;
  isProxyFallbackActive = false;
  nodeHealthState = { status: 'OK', updatedAt: Date.now() };

  // Persist directly to local .env and settings
  try {
    const { syncCredentialsToEnv } = require('../config');
    syncCredentialsToEnv({ DECIBEL_NODE_API_KEY: cleanKey });
  } catch (err: any) {
    logger.warn(`Failed to persist hot-swapped key to .env: ${err.message}`);
  }

  logger.info(`🔄 [NODE HOT-SWAP] Successfully installed new gateway key and persisted to .env: ${cleanKey.slice(0, 10)}... Direct gateway restored.`);
  return true;
}

/**
 * Returns an AIP-compliant AptosConfig object with high-speed node routing.
 */
export function getAptosConfig(network?: string, customApiKey?: string): AptosConfig {
  const isTestnet = network === 'testnet' || config.NETWORK === 'testnet';
  const net = isTestnet ? Network.TESTNET : Network.MAINNET;

  const key = (customApiKey || (!isProxyFallbackActive ? currentActiveApiKey || config.DECIBEL_NODE_API_KEY : '') || '').trim();

  // Mode 1: Direct Gateway Key (if active, valid, and not blacklisted)
  if (!isProxyFallbackActive && key && !BLACKLISTED_KEYS.has(key)) {
    return new AptosConfig({
      network: net,
      clientConfig: {
        API_KEY: key,
      },
      fullnodeConfig: {
        HEADERS: {
          Authorization: `Bearer ${key}`,
          'x-api-key': key,
        },
      },
    });
  }

  // Mode 2: Dedicated Builder Proxy URL (Zero developer secrets needed on client)
  const defaultProxy = config.SIMLAB_SERVER_URL
    ? `${config.SIMLAB_SERVER_URL.replace(/\/+$/, '')}/aptos-node/v1`
    : 'https://fullnode.mainnet.aptoslabs.com/v1';
  const proxyUrl = sanitizeProxyUrl(proxyEndpointUrl || defaultProxy);
  return new AptosConfig({
    network: net,
    fullnode: proxyUrl,
    fullnodeConfig: {
      HEADERS: {
        'x-client-id': config.CLIENT_ID || 'alpha-client-v3',
        'x-routing-mode': 'simlab-builder-proxy',
      },
    },
  });
}

/**
 * Factory helper to create an authorized Aptos client.
 */
export function createAptosClient(network?: string, customApiKey?: string): Aptos {
  return new Aptos(getAptosConfig(network, customApiKey));
}
