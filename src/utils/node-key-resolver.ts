/**
 * Aptos Node Resolver & Client Factory (Zero-Hardcoded Secrets)
 *
 * Provides high-speed, rate-limit-free connectivity to Aptos Mainnet Fullnodes.
 * Automatically resolves and connects through:
 *  1. Direct Decibel/Aptos Gateway using dynamic fleet node key (AG-...)
 *  2. Instant 0-second failover to Sim Lab Builder Proxy (https://simlab.measmony.me/aptos-node/v1)
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

// In-memory gateway routing state
let currentActiveApiKey: string = (config.DECIBEL_NODE_API_KEY || '').trim();
let isProxyFallbackActive: boolean = false;
let proxyEndpointUrl: string = (
  process.env.APTOS_FULLNODE_URL ||
  (config as any).APTOS_FULLNODE_URL ||
  'https://simlab.measmony.me/aptos-node/v1'
).trim();

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

  // 5. Default fleet public endpoints
  candidates.push('https://simlab.measmony.me/api/node-key');
  candidates.push('https://simlab.measmony.me/api/pipeline/node-key');

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
    logger.warn(`🚨 [NODE KEY] Key ${badKey.slice(0, 10)}... blacklisted. Switching to builder proxy fallback.`);
  }

  // If client already has a valid non-blacklisted key and not refreshing, use it
  if (!options?.forceRefresh && currentActiveApiKey && !BLACKLISTED_KEYS.has(currentActiveApiKey) && !isProxyFallbackActive) {
    logger.debug(`🔑 [NODE KEY] Using active Aptos gateway key: ${currentActiveApiKey.slice(0, 10)}...`);
    return currentActiveApiKey;
  }

  // Query remote node key dispenser
  const candidateUrls = getCandidateKeyUrls();
  logger.info(`🔍 [NODE KEY] Contacting Sim Lab dispenser for node routing credentials...`);

  for (const baseCandidate of candidateUrls) {
    try {
      const urlObj = new URL(baseCandidate);
      if (options?.failedKey) {
        urlObj.searchParams.set('failedKey', options.failedKey);
      }
      urlObj.searchParams.set('clientId', config.CLIENT_ID || 'alpha-client-v3');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(urlObj.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-client-id': config.CLIENT_ID || 'alpha-client-v3',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.success) {
          if (data.proxyUrl && typeof data.proxyUrl === 'string') {
            proxyEndpointUrl = data.proxyUrl.trim();
            (config as any).APTOS_FULLNODE_URL = proxyEndpointUrl;
          }

          if (data.apiKey && typeof data.apiKey === 'string' && !BLACKLISTED_KEYS.has(data.apiKey.trim())) {
            currentActiveApiKey = data.apiKey.trim();
            config.DECIBEL_NODE_API_KEY = currentActiveApiKey;
            isProxyFallbackActive = false;
            logger.info(`✅ [NODE KEY] Acquired active Gateway Key: ${currentActiveApiKey.slice(0, 10)}...`);
            return currentActiveApiKey;
          } else {
            // Direct gateway key not available or fallback instructed
            isProxyFallbackActive = true;
            currentActiveApiKey = '';
            config.DECIBEL_NODE_API_KEY = '';
            logger.info(`🛡️ [NODE KEY] Sim Lab directed Builder Proxy fallback: ${proxyEndpointUrl}`);
            return proxyEndpointUrl;
          }
        }
      }
    } catch {
      // Try next candidate
    }
  }

  // Fallback defaults
  if (currentActiveApiKey && !BLACKLISTED_KEYS.has(currentActiveApiKey) && !isProxyFallbackActive) {
    return currentActiveApiKey;
  }

  isProxyFallbackActive = true;
  logger.info(`🌐 [NODE RESOLVER] Routing Aptos transactions through secure Sim Lab builder proxy.`);
  return proxyEndpointUrl;
}

/**
 * Triggers immediate 0-second failover to Sim Lab Builder Proxy.
 * Blacklists the failed key and asynchronously alerts Sim Lab.
 */
export function triggerNodeKeyFailover(failedKey?: string, reason?: string): void {
  const badKey = (failedKey || currentActiveApiKey || config.DECIBEL_NODE_API_KEY || '').trim();
  if (badKey) {
    BLACKLISTED_KEYS.add(badKey);
  }

  currentActiveApiKey = '';
  config.DECIBEL_NODE_API_KEY = '';
  isProxyFallbackActive = true;

  logger.warn(
    `🚨 [NODE FAILOVER] Node key failure detected (${reason || '401/429/Blacklist'}). ` +
    `Engaged 0-second immediate failover to Sim Lab Builder Proxy (${proxyEndpointUrl}).`
  );

  // Asynchronously report to Sim Lab so the dispenser updates fleet state
  setImmediate(() => {
    resolveNodeApiKey({ forceRefresh: true, failedKey: badKey || undefined }).catch(() => {});
  });
}

/**
 * Hot-swaps to a new node key live in memory without requiring process restart.
 */
export function hotSwapNodeKey(newKey: string): boolean {
  if (!newKey || typeof newKey !== 'string') return false;
  const cleanKey = newKey.trim();
  if (cleanKey.length < 5) return false;

  // If operator/server explicitly pushes a key, remove from local blacklist
  BLACKLISTED_KEYS.delete(cleanKey);

  if (currentActiveApiKey === cleanKey && !isProxyFallbackActive) {
    return true; // Already active
  }

  currentActiveApiKey = cleanKey;
  config.DECIBEL_NODE_API_KEY = cleanKey;
  isProxyFallbackActive = false;

  logger.info(`🔄 [NODE HOT-SWAP] Successfully installed new fleet gateway key: ${cleanKey.slice(0, 10)}... Direct gateway restored.`);
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
  const proxyUrl = proxyEndpointUrl || 'https://simlab.measmony.me/aptos-node/v1';
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
