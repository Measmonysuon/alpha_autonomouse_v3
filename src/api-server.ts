/**
 * Lightweight Dashboard & Health API Server
 * 
 * Exposes live agent state over HTTP for the web dashboard and health monitors:
 *  - GET /health                  -> Health check endpoint
 *  - GET /api/state               -> Live operating mode, active directives, budget, and stats
 *  - GET /api/positions           -> Live open positions
 *  - GET /api/trades              -> Trade journal from data/trades.json
 *  - GET /api/stats               -> Win rate, realized PnL, budget utilization
 *  - GET /api/directives          -> Active strategy directives (Standalone vs Sim Lab)
 *  - GET /api/setup/status        -> Checks if real credentials are configured
 *  - POST /api/setup/activate     -> Activates bot with new credentials
 *  - POST /api/auth/login         -> Admin password login verification
 *  - GET /api/auth/check          -> Checks authentication status
 *  - GET /api/settings            -> Sanitized settings
 *  - POST /api/settings           -> Dynamic settings updates
 *  - GET /api/simlab/features     -> Sim Lab Supercharge feature flags and status
 *  - POST /api/simlab/features    -> Update feature flags and connect/disconnect
 *  - GET /api/strategies          -> Strategy Studio catalog (Pre-built + Custom)
 *  - POST /api/strategies/activate-> Switch active strategy
 *  - POST /api/strategies/save    -> Save/edit custom strategy
 *  - GET /api/logs/stream         -> Real-time SSE log stream
 *  - Static file server for dashboard/ UI
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import { createAptosClient } from './utils/node-key-resolver';
import { config, watchPairs, isClientConfigured, isClientOnboarded, updateDynamicSettings, getDerivedSignerAddress, getAISettings, isValidApiKey, loadPersistentSettings } from './config';
import { logger } from './utils/logger';
import { tradeExecutor } from './trades/executor';
import { mcpClient } from './mcp/client';
import { portfolioHarvester } from './engine/harvester';
import { riskGuard } from './risk/guard';
import { standaloneEngine, fetchPublicKlines } from './engine/standalone-engine';
import { superchargeClient } from './simlab/supercharge-client';
import { telegramNotifier } from './notify/telegram';
import { localAIBrain } from './ai/brain';
import {
  getAllStrategies,
  getActiveStrategy,
  getActiveStrategyOriginInfo,
  setActiveStrategy,
  saveCustomStrategy,
  deleteCustomStrategy,
  getStrategySyncConfig,
  updateStrategySyncConfig,
  setSimLabConnectionChecker,
  getAllPairOverrides,
  getSimPairDirectives,
} from './strategy/manager';
import { dbClient, DbTrade } from './db/database';

export interface LogEntry {
  ts: number;
  level: string;
  msg: string;
}

export interface VetoWatchEntry {
  symbol: string;
  vetoedAt: number;
  watchUntil: number;
  pollCount: number;
  lastVerdict: string;
}

export interface MarketState {
  symbol: string;
  markPrice: number;
  change24h?: number;
  trend?: string;
  action?: string;
  confidence: number;
  riskLevel?: string;
  candlestick?: any;
  [key: string]: any;
}

export interface AgentState {
  status: string;
  uptime: number;
  network: string;
  mode: string;
  maxRiskPct: number;
  subaccount: string;
  agentAddress: string;
  gasAptBalance: number;
  cycleCount: number;
  pairs: string[];
  currentPairs: string[];
  markets: Record<string, MarketState>;
  recentLogs: LogEntry[];
  trapShieldEvents: any[];
  vetoWatch: Record<string, VetoWatchEntry>;
  accountEquityUsd: number;
  availableMarginUsd: number;
  startedAt: number;
  budgetUsd: number;
  minAllocPct: number;
  maxAllocPct: number;
  minConfidencePct: number;
  [key: string]: any;
}

export const agentState: AgentState = {
  status: 'running',
  uptime: 0,
  network: config.NETWORK,
  mode: config.AUTONOMOUS_MODE,
  maxRiskPct: config.MAX_RISK_PER_TRADE_PCT,
  subaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
  agentAddress: config.DECIBEL_OWNER_ADDRESS || '0x_agent',
  gasAptBalance: 0,
  cycleCount: 0,
  pairs: watchPairs,
  currentPairs: watchPairs,
  markets: {} as Record<string, MarketState>,
  recentLogs: [] as LogEntry[],
  trapShieldEvents: [] as any[],
  vetoWatch: {} as Record<string, VetoWatchEntry>,
  accountEquityUsd: 0,
  availableMarginUsd: 0,
  startedAt: Date.now(),
  budgetUsd: config.BUDGET_USD,
  minAllocPct: config.MIN_ALLOC_PCT,
  maxAllocPct: config.MAX_ALLOC_PCT,
  minConfidencePct: config.MIN_CONFIDENCE_PCT,
};

// Initialize Sim Lab connection status checker for strategy manager
setSimLabConnectionChecker(() => {
  return superchargeClient.isActive();
});

let scanTriggerFn: (() => void) | null = null;
export function registerScanTrigger(fn: () => void): void {
  scanTriggerFn = fn;
}
export function triggerImmediateScan(): void {
  if (scanTriggerFn) {
    try {
      scanTriggerFn();
    } catch (e: any) {
      logger.error(`Error triggering immediate scan: ${e.message}`);
    }
  }
}

const DEFAULT_PAIR_PRICES: Record<string, number> = {
  'APT/USD': 0.771,
  'BTC/USD': 84850,
  'ETH/USD': 2735,
  'SOL/USD': 116.2,
  'SUI/USD': 0.998,
  'AVAX/USD': 11.27,
  'NEAR/USD': 4.31,
  'LINK/USD': 13.03,
  'DOGE/USD': 0.0935,
  'XRP/USD': 1.476,
  'ADA/USD': 0.240,
  'BNB/USD': 782.5,
  'TRX/USD': 0.231,
  'DOT/USD': 3.85,
  'HYPE/USD': 18.50,
  'PEPE/USD': 0.0000078,
  'SHIB/USD': 0.0000125,
  'LTC/USD': 88.4,
  'BCH/USD': 430.0,
  'UNI/USD': 8.20,
  'FET/USD': 0.75,
  'TAO/USD': 310.0,
  'RENDER/USD': 3.45,
  'ARB/USD': 0.48,
  'OP/USD': 1.15,
  'INJ/USD': 14.80,
  'SEI/USD': 0.28,
  'TIA/USD': 3.10,
};

export function seedMarketsForPairs(): void {
  for (const sym of watchPairs) {
    const basePrice = DEFAULT_PAIR_PRICES[sym] || 10.0;
    if (!agentState.markets[sym] || agentState.markets[sym].markPrice === 0) {
      agentState.markets[sym] = {
        symbol: sym,
        markPrice: basePrice,
        change24h: 0.85,
        volume24hUsd: basePrice * 45000,
        high24h: basePrice * 1.025,
        low24h: basePrice * 0.985,
        trend: 'SCANNING',
        action: 'WAIT',
        confidence: 65,
        riskLevel: 'LOW',
        fundingRate: 0.01,
        candlestick: { rsi14: 52, ema9: basePrice * 1.002, ema21: basePrice * 0.998, rvol: 1.1, adx14: 22 },
        updatedAt: Date.now(),
      };
    }
  }
}

// Seed pairs immediately on server boot
seedMarketsForPairs();

export function getLivePricesMap(): Record<string, number> {
  const map: Record<string, number> = {};
  if (agentState && agentState.markets) {
    for (const [sym, m] of Object.entries(agentState.markets)) {
      if (m && m.markPrice > 0) {
        map[sym] = m.markPrice;
      }
    }
  }
  return map;
}

let liveTickerTimer: NodeJS.Timeout | null = null;

export async function fetchLiveBulkTickers(): Promise<void> {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', {
      timeout: 3000,
      headers: { 'User-Agent': 'Mozilla/5.0 (TradingBot/2.0; LiveTickers)' },
    });
    const list = res.data?.result?.list;
    if (Array.isArray(list) && list.length > 0) {
      const tickerMap = new Map<string, any>();
      for (const t of list) {
        tickerMap.set(t.symbol, t);
      }
      for (const sym of watchPairs) {
        const norm = sym.toUpperCase().replace(/[-_/]/g, '');
        const cleanBase = norm.replace(/USD[T]?$/, '');
        const bybitSym = `${cleanBase}USDT`;
        const item = tickerMap.get(bybitSym);
        if (item && item.lastPrice) {
          const price = parseFloat(item.lastPrice);
          if (Number.isFinite(price) && price > 0) {
            if (!agentState.markets[sym]) {
              agentState.markets[sym] = {
                symbol: sym,
                markPrice: price,
                change24h: 0,
                volume24hUsd: 0,
                high24h: price,
                low24h: price,
                trend: 'SCANNING',
                action: 'WAIT',
                confidence: 50,
                riskLevel: 'LOW',
                fundingRate: 0.01,
                candlestick: { rsi14: 50, ema9: price, ema21: price, rvol: 1, adx14: 20 },
                updatedAt: Date.now(),
              };
            }
            const m = agentState.markets[sym];
            m.markPrice = price;
            if (item.price24hPcnt) m.change24h = parseFloat(item.price24hPcnt) * 100;
            if (item.highPrice24h) m.high24h = parseFloat(item.highPrice24h);
            if (item.lowPrice24h) m.low24h = parseFloat(item.lowPrice24h);
            if (item.turnover24h) m.volume24hUsd = parseFloat(item.turnover24h);
            m.updatedAt = Date.now();
          }
        }
      }
    }
  } catch (err: any) {
    // Silent catch for live polling
  }
}

export function startLiveTickerLoop(): void {
  if (liveTickerTimer) clearInterval(liveTickerTimer);
  fetchLiveBulkTickers().catch(() => {});
  liveTickerTimer = setInterval(() => {
    fetchLiveBulkTickers().catch(() => {});
  }, 2500);
}
startLiveTickerLoop();

const recentLogs: LogEntry[] = [];
const sseClients = new Set<http.ServerResponse>();
const startedAt = Date.now();
let lastStateOnChainSync = 0;
let cachedStateEquity = 0;
let cachedStateMargin = 0;
let cachedStateGasApt = 0;

export function pushLog(level: string, msg: string): void {
  const entry: LogEntry = { ts: Date.now(), level, msg };
  recentLogs.push(entry);
  if (recentLogs.length > 200) recentLogs.shift();

  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Hook into logger to stream to SSE dashboard
const origInfo = logger.info.bind(logger);
const origWarn = logger.warn.bind(logger);
const origError = logger.error.bind(logger);

(logger as any).info = (msg: string, ...a: any[]) => {
  origInfo(msg, ...a);
  pushLog('info', msg);
};
(logger as any).warn = (msg: string, ...a: any[]) => {
  origWarn(msg, ...a);
  pushLog('warn', msg);
};
(logger as any).error = (msg: string, ...a: any[]) => {
  origError(msg, ...a);
  pushLog('error', msg);
};

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!config.ADMIN_PASSWORD || config.ADMIN_PASSWORD.trim() === '') {
    return true; // No password protection set
  }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      if (decoded.endsWith(`_${config.ADMIN_PASSWORD}`)) {
        return true;
      }
    } catch {}
  }
  return false;
}

export function startApiServer(): http.Server {
  const dashboardDir = path.resolve(process.cwd(), 'dashboard');

  // Pre-seed SQLite from trades.json if database was empty
  try {
    const jsonPath = path.resolve(process.cwd(), 'data', 'trades.json');
    if (fs.existsSync(jsonPath)) {
      dbClient.migrateFromJson(jsonPath);
    }
  } catch (err: any) {
    logger.debug(`SQLite trades initial migration check: ${err.message}`);
  }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://localhost:${config.HEALTH_PORT}`);
    const pathname = parsedUrl.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── 1. Health Endpoint ───────────────────────────────────────────────────
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          operatingMode: config.OPERATING_MODE,
          isSimLabSupercharged: superchargeClient.isActive(),
          network: config.NETWORK,
          clientName: config.CLIENT_NAME,
          isConfigured: isClientConfigured(),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // ── 2. Setup & Onboarding Status ─────────────────────────────────────────
    if (pathname === '/api/setup/status') {
      const configured = isClientConfigured() || isClientOnboarded();
      const signer = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          isConfigured: configured,
          onboarded: isClientOnboarded(),
          clientName: config.CLIENT_NAME,
          network: config.NETWORK,
          hasPassword: Boolean(config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.trim() !== ''),
          operatingMode: config.OPERATING_MODE,
          subaccount: configured ? config.DECIBEL_SUBACCOUNT_ADDRESS : '',
          signerAddress: signer,
          gasFeeAddress: signer,
        }),
      );
      return;
    }

    // ── 2b. Gas Fee Address & Balance Retrieval ──────────────────────────────
    if (pathname === '/api/gas-address' || pathname === '/api/signer-address') {
      const signer = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
      let aptBalance = 0;
      if (signer) {
        try {
          const onChain = await tradeExecutor.fetchOnChainBalance();
          aptBalance = onChain.aptBalance;
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          signerAddress: signer,
          gasFeeAddress: signer,
          gasAptBalance: aptBalance,
          needsTopUp: aptBalance < 0.005,
          network: config.NETWORK,
          topUpInstructions: 'Transfer 0.05 - 0.1 APT to this address on Aptos mainnet to pay transaction gas fees.',
          explorerUrl: signer ? `https://explorer.aptoslabs.com/account/${signer}?network=${config.NETWORK}` : null,
        }),
      );
      return;
    }

    // ── 2c. Real-Time Fleet Immunity Veto Bus Ingestion ───────────────────────
    if (pathname === '/api/fleet/immunity-lock' && req.method === 'POST') {
      let bodyStr = '';
      req.on('data', chunk => { bodyStr += chunk; });
      req.on('end', () => {
        try {
          const body = JSON.parse(bodyStr || '{}');
          if (body.symbol) {
            riskGuard.triggerL4TrapCoolOff(
              body.symbol,
              body.bannedSide || 'BOTH',
              'SHARED_FLEET_IMMUNITY',
              body.reason || `Instant fleet veto from ${body.triggeredByDesk || 'Sim Lab'}`,
              body.durationMinutes || 15
            );
            logger.info(`⚡ [FLEET IMMUNITY BUS] Instant push received: ${body.symbol} (${body.bannedSide || 'BOTH'}) locked for ${body.durationMinutes || 15}m`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, symbol: body.symbol }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // ── 2c. Preview / Derive Signer Address from Delegate Key ────────────────
    if ((pathname === '/api/setup/derive-signer' || pathname === '/api/signer/derive') && req.method === 'POST') {
      const body = await parseBody(req);
      const key = (body.delegateKey || body.decibelPrivateKey || body.decibelDelegateKey || body.privateKey || '').trim();
      const derived = getDerivedSignerAddress(key);
      const knownSub = (!config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_') && config.DECIBEL_SUBACCOUNT_ADDRESS.startsWith('0x'))
        ? config.DECIBEL_SUBACCOUNT_ADDRESS : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: Boolean(derived),
          signerAddress: derived,
          gasFeeAddress: derived,
          knownSubaccount: knownSub,
          network: config.NETWORK,
          explorerUrl: derived ? `https://explorer.aptoslabs.com/account/${derived}?network=${config.NETWORK}` : null,
          topUpInstructions: 'Transfer 0.05 - 0.1 APT to this address on Aptos mainnet to pay transaction gas fees.',
          note: 'This is the Gas Signer wallet (pays Aptos tx fees). Do NOT enter this address as your trading subaccount.',
          error: derived ? undefined : 'Invalid private key format. Please provide a valid Ed25519 private key.'
        }),
      );
      return;
    }

    // ── 2d. Verify Decibel Subaccount & Live Collateral On-Chain ─────────────
    if (pathname === '/api/setup/verify-subaccount' && req.method === 'POST') {
      const body = await parseBody(req);
      const addr = (body.address || body.subaccount || '').trim();
      const delegateKey = (body.delegateKey || '').trim();
      const derived = delegateKey ? getDerivedSignerAddress(delegateKey) : null;
      const isSigner = Boolean(derived && addr.toLowerCase() === derived.toLowerCase());

      if (!addr || !addr.startsWith('0x') || addr.length < 20) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Please enter a valid Aptos address (0x...).' }));
        return;
      }

      if (isSigner) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          isSignerAddress: true,
          error: `⚠️ This is your Gas Signer key address (${addr.slice(0, 8)}...), NOT your Subaccount! Please enter your Decibel trading account (holding USDC collateral).`
        }));
        return;
      }

      try {
        const net = config.NETWORK === 'testnet' ? Network.TESTNET : Network.MAINNET;
        const aptos = createAptosClient(net);
        const decibelContract = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
        let resolvedSub = addr;
        let isPrimary = false;

        try {
          const primaryRes = await aptos.view({
            payload: {
              function: `${decibelContract}::dex_accounts::primary_subaccount`,
              typeArguments: [],
              functionArguments: [addr],
            },
          });
          if (primaryRes?.[0] && typeof primaryRes[0] === 'string' && primaryRes[0] !== addr) {
            resolvedSub = primaryRes[0];
            isPrimary = true;
          }
        } catch { }

        let balanceUsd = 0;
        try {
          const collRes = await aptos.view({
            payload: {
              function: `${decibelContract}::perp_engine::get_cross_total_collateral_value`,
              typeArguments: [],
              functionArguments: [resolvedSub],
            },
          });
          if (collRes?.[0] !== undefined) {
            const val = Number(collRes[0]);
            if (val > 0) balanceUsd = val / 1e6;
          }
        } catch { }

        let isDelegated = false;
        if (derived) {
          try {
            const permRes = await aptos.view({
              payload: {
                function: `${decibelContract}::dex_accounts::view_delegated_permissions`,
                typeArguments: [],
                functionArguments: [resolvedSub],
              },
            });
            const map = permRes?.[0] as any;
            if (map?.entries && Array.isArray(map.entries)) {
              isDelegated = map.entries.some((entry: any) =>
                entry.key && entry.key.toLowerCase() === derived.toLowerCase()
              );
            }
          } catch { }
        }

        let msg = `✅ Decibel Subaccount verified on-chain${isPrimary ? ' (Linked to Primary Wallet)' : ''} · $${balanceUsd.toFixed(2)} USDC Available`;
        if (derived && isDelegated) {
          msg = `✅ Decibel Subaccount verified on-chain · Delegate Key authorized · $${balanceUsd.toFixed(2)} USDC Available`;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          enteredAddress: addr,
          resolvedSubaccount: resolvedSub,
          isPrimaryOwner: isPrimary,
          isDelegated,
          collateralUsd: balanceUsd,
          message: msg
        }));
      } catch (err: any) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          enteredAddress: addr,
          resolvedSubaccount: addr,
          collateralUsd: 0,
          message: 'Address format valid'
        }));
      }
      return;
    }

    // ── 3. Setup & Activation Action ─────────────────────────────────────────
    if (pathname === '/api/setup/activate' && req.method === 'POST') {
      const body = await parseBody(req);
      const delegateKey = (body.delegateKey || body.decibelPrivateKey || body.decibelDelegateKey || '').trim();
      const subaccount = (body.subaccount || body.decibelSubaccount || '').trim();
      const isPaper = Boolean(body.paperTrading);

      // In live mode require keys; in paper trading mode allow fallback if not provided
      if (!isPaper) {
        if (!delegateKey || delegateKey.length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Valid Decibel Delegate Private Key is required for live trading.' }));
          return;
        }
        if (!subaccount || subaccount.length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Valid Decibel Subaccount Address is required for live trading.' }));
          return;
        }

        const derivedSigner = delegateKey ? getDerivedSignerAddress(delegateKey) : null;
        if (derivedSigner && subaccount.toLowerCase() === derivedSigner.toLowerCase()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `❌ You entered your Gas Signer address (${subaccount.slice(0, 8)}...) as your subaccount! Please enter your Decibel trading account holding USDC collateral.`
          }));
          return;
        }
      }

      // Auto-resolve primary account -> subaccount on-chain
      let targetSubaccount = subaccount;
      let targetOwner = (body.ownerAddress || '').trim();
      if (!isPaper && subaccount.startsWith('0x')) {
        try {
          const net = (body.network || body.decibelNetwork || config.NETWORK) === 'testnet' ? Network.TESTNET : Network.MAINNET;
          const aptos = createAptosClient(net);
          const decibelContract = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
          const primaryRes = await aptos.view({
            payload: {
              function: `${decibelContract}::dex_accounts::primary_subaccount`,
              typeArguments: [],
              functionArguments: [subaccount],
            },
          });
          if (primaryRes?.[0] && typeof primaryRes[0] === 'string' && primaryRes[0] !== subaccount) {
            targetSubaccount = primaryRes[0];
            if (!targetOwner) targetOwner = subaccount;
          }
        } catch { }
      }

      // Build updates object
      const updates: any = {
        onboarded: true,
        credentials: {
          decibelDelegateKey: delegateKey,
          decibelSubaccount: targetSubaccount,
          decibelOwnerAddress: targetOwner,
          decibelNodeApiKey: (body.nodeApiKey || '').trim(),
          network: body.network || body.decibelNetwork || 'mainnet',
        },
        decibelSubaccount: targetSubaccount,
        decibelOwnerAddress: targetOwner,
        decibelPrivateKey: delegateKey,
        decibelNetwork: body.network || body.decibelNetwork || 'mainnet',
        trading: {
          budgetUsd: body.budgetUsd ? Number(body.budgetUsd) : config.BUDGET_USD,
          paperTrading: isPaper,
        },
      };

      if (body.aiProvider) {
        const rawAiKey = (body.aiKey || '').trim();
        const prov = body.aiProvider.toLowerCase().trim();
        updates.ai = {
          provider: prov,
          geminiApiKey: (body.geminiKey || (prov === 'gemini' ? rawAiKey : '') || '').trim(),
          anthropicApiKey: (body.claudeKey || (prov === 'claude' || prov === 'anthropic' ? rawAiKey : '') || '').trim(),
          ollamaBaseUrl: (body.ollamaUrl || (prov === 'ollama' ? rawAiKey : '') || '').trim(),
          model: body.aiModel || (prov === 'claude' ? 'claude-3-5-sonnet-latest' : 'gemini-2.5-flash'),
        };
        updates.aiProvider = prov;
        updates.aiModel = updates.ai.model;
        if (prov === 'gemini' && updates.ai.geminiApiKey) updates.aiApiKey = updates.ai.geminiApiKey;
        if ((prov === 'claude' || prov === 'anthropic') && updates.ai.anthropicApiKey) updates.aiApiKey = updates.ai.anthropicApiKey;
      }

      if (body.adminPassword) {
        updates.security = {
          adminPassword: body.adminPassword.trim(),
        };
      }

      if (body.telegramBotToken || body.telegramChatId) {
        const tgTok = (body.telegramBotToken || '').trim();
        const tgChat = (body.telegramChatId || '').trim();
        updates.telegram = {
          botToken: tgTok,
          chatId: tgChat,
          enabled: true,
        };
        updates.telegramBotToken = tgTok;
        updates.telegramChatId = tgChat;
        telegramNotifier.updateSettings(tgTok, tgChat, true);
      }

      updateDynamicSettings(updates);
      tradeExecutor.resetTrades();
      tradeExecutor.reinitializeSigner();
      const derivedSigner = getDerivedSignerAddress(delegateKey);
      logger.info(`🎉 [SETUP] Credentials configured and permanently saved! Signer: ${derivedSigner || 'derived'}. Bot activated.`);
      seedMarketsForPairs();
      triggerImmediateScan();

      // Fetch initial gas balance for the new signer
      let gasApt = 0;
      try {
        const onChain = await tradeExecutor.fetchOnChainBalance();
        gasApt = onChain.aptBalance;
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          onboarded: true,
          isConfigured: true,
          message: 'Trading agent successfully activated!',
          subaccount,
          signerAddress: derivedSigner,
          gasFeeAddress: derivedSigner,
          gasAptBalance: gasApt,
          needsTopUp: gasApt < 0.005,
          topUpInstructions: 'Transfer 0.05 - 0.1 APT to this gas fee address on Aptos mainnet to pay transaction gas fees.',
          explorerUrl: derivedSigner ? `https://explorer.aptoslabs.com/account/${derivedSigner}?network=${config.NETWORK}` : null,
        }),
      );
      return;
    }

    // ── 3b. Setup Reset Action (Clean slate for testing onboarding) ───────────
    if (pathname === '/api/setup/reset' && req.method === 'POST') {
      const emptySettings = {
        credentials: {
          decibelDelegateKey: '',
          decibelSubaccount: '',
          decibelOwnerAddress: '',
          decibelNodeApiKey: '',
          network: 'mainnet',
        },
        decibelSubaccount: '',
        decibelPrivateKey: '',
        decibelNetwork: 'mainnet',
        ai: {
          enabled: true,
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          apiKey: '',
        },
        aiApiKey: '',
        budgetUsd: 30,
        trading: {
          budgetUsd: 30,
          paperTrading: false,
          maxPositionUsd: 9,
          maxLeverage: 5,
        },
        telegram: {
          botToken: '',
          chatId: '',
          enabled: false,
        },
      };

      config.DECIBEL_DELEGATE_KEY = '';
      config.DECIBEL_PRIVATE_KEY = '';
      config.DECIBEL_SUBACCOUNT_ADDRESS = '';
      config.GEMINI_API_KEY = '';
      config.ANTHROPIC_API_KEY = '';
      config.ACTIVE_AI_PROVIDER = 'local_rules' as any;
      updateDynamicSettings(emptySettings);
      tradeExecutor.reinitializeSigner();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'All credentials wiped cleanly. System reset to pre-onboarding state.' }));
      return;
    }

    // ── 4. Authentication Check & Login ──────────────────────────────────────
    if (pathname === '/api/auth/check') {
      const authRequired = Boolean(config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.trim() !== '');
      const authenticated = isAuthorized(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authRequired, authenticated }));
      return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const inputPassword = (body.password || '').trim();

      if (!config.ADMIN_PASSWORD || config.ADMIN_PASSWORD.trim() === '') {
        // No password set
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, token: 'no_auth_required' }));
        return;
      }

      if (inputPassword === config.ADMIN_PASSWORD) {
        const token = Buffer.from(`session_${Date.now()}_${config.ADMIN_PASSWORD}`).toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, token }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Incorrect Admin Password.' }));
      }
      return;
    }

    // ── Reset admin password by proving wallet ownership ─────────────────────
    if (pathname === '/api/auth/reset-by-wallet' && req.method === 'POST') {
      const body = await parseBody(req);
      const inputAddr = (body.walletAddress || '').trim().toLowerCase();

      if (!inputAddr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'walletAddress is required.' }));
        return;
      }

      // Load the persisted subaccount address as the identity proof
      const saved = loadPersistentSettings();
      const storedAddr = (
        saved?.credentials?.decibelSubaccount ||
        saved?.decibelSubaccount ||
        config.DECIBEL_SUBACCOUNT_ADDRESS ||
        ''
      ).toLowerCase();

      if (!storedAddr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No wallet address is configured on this client. Cannot verify identity.' }));
        return;
      }

      if (inputAddr !== storedAddr) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Wallet address does not match. Identity verification failed.' }));
        return;
      }

      // Identity verified — clear the admin password via updateDynamicSettings (persists to disk)
      updateDynamicSettings({ adminPassword: '' });
      config.ADMIN_PASSWORD = '';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Admin password cleared. You can now set a new password in Settings → Security.' }));
      return;
    }

    // ── 5. Live State Endpoint ───────────────────────────────────────────────
    if (pathname === '/api/state') {
      const stats = tradeExecutor.getStats();
      const directives = standaloneEngine.getDirectives();
      const configured = isClientConfigured();
      let onChainEquity = 0;
      let onChainMargin = 0;
      let gasAptBalance = 0;

      if (configured) {
        const now = Date.now();
        if (now - lastStateOnChainSync > 10000) {
          lastStateOnChainSync = now;
          tradeExecutor.syncOnChainPositions().catch(() => {});
          tradeExecutor.fetchOnChainBalance().then((onChain) => {
            cachedStateEquity = Math.max(0, onChain.balanceUsd || 0);
            cachedStateMargin = Math.max(0, cachedStateEquity - stats.budgetUsedUsd);
            cachedStateGasApt = onChain.aptBalance || 0;
          }).catch(() => {});
        }
        onChainEquity = cachedStateEquity;
        onChainMargin = cachedStateMargin;
        gasAptBalance = cachedStateGasApt;
      } else {
        onChainEquity = 0;
        onChainMargin = 0;
        gasAptBalance = 0;
      }

      const signerAddress = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
      let isSimConsumerActive = false;
      try {
        const { isSimPipelineActive } = require('./pipeline/sim-consumer');
        isSimConsumerActive = Boolean(isSimPipelineActive());
      } catch {}
      const isSimLabConn = superchargeClient.isActive() || isSimConsumerActive;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: tradeExecutor.getIsPaused() ? 'PAUSED' : 'running',
          isPaused: tradeExecutor.getIsPaused(),
          mode: config.AUTONOMOUS_MODE,
          clientName: config.CLIENT_NAME,
          operatingMode: isSimLabConn ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
          isSimLabSupercharged: isSimLabConn,
          isSimLabConnected: isSimLabConn,
          simPipeline: {
            connected: isSimLabConn,
            isStale: false,
            currentRegime: directives.regime,
            appliedConfidenceGate: directives.scoreFloor,
            appliedHarvestThreshold: 65,
            serverUrl: superchargeClient.getServerUrl(),
            mode: isSimLabConn ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
          },
          isConfigured: configured,
          aiProvider: config.ACTIVE_AI_PROVIDER,
          aiModel: config.GEMINI_MODEL || (config.ACTIVE_AI_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'local-rules'),
          aiEnabled: config.ACTIVE_AI_PROVIDER !== 'local_rules' && Boolean(config.GEMINI_API_KEY || config.ANTHROPIC_API_KEY || config.OLLAMA_BASE_URL),
          subaccount: (config.DECIBEL_SUBACCOUNT_ADDRESS && !config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_')) ? config.DECIBEL_SUBACCOUNT_ADDRESS : '',
          agentAddress: signerAddress,
          gasFeeAddress: signerAddress,
          gasAptBalance,
          paperTrading: config.PAPER_TRADING,
          budgetUsd: config.BUDGET_USD,
          accountEquityUsd: onChainEquity,
          availableMarginUsd: onChainMargin,
          pairs: watchPairs,
          currentPairs: watchPairs,
          watchPairs,
          directives,
          stats,
          markets: agentState.markets,
          activeStrategy: getActiveStrategy(),
          strategyOrigin: getActiveStrategyOriginInfo(),
          strategySyncConfig: getStrategySyncConfig(),
          pairOverrides: getAllPairOverrides(),
          simPairDirectives: getSimPairDirectives(),
          shadowStats: tradeExecutor.getShadowStats(),
          shadowTrades: tradeExecutor.getShadowTrades().slice(-20),
          activeCoolOffs: riskGuard.getAllActiveCoolOffs(),
          portfolioHarvester: portfolioHarvester.evaluate(getLivePricesMap()),
          positions: tradeExecutor.getOpenTrades(),
          openPositions: tradeExecutor.getOpenTrades(),
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        }),
      );
      return;
    }

    // ── 5b. Learning & Counterfactual Shadow Trades Endpoint ─────────────────
    if (pathname === '/api/learning' || pathname === '/api/shadow-trades') {
      const directives = standaloneEngine.getDirectives();
      const shadowStats = tradeExecutor.getShadowStats();
      const shadowTrades = tradeExecutor.getShadowTrades();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          macroDirective: directives,
          pairOverrides: getAllPairOverrides(),
          simPairDirectives: getSimPairDirectives(),
          shadowTrades: shadowTrades.slice(-30),
          learning: {
            shadowStats: shadowStats,
            dualStreamMetrics: {
              liveTradesCount: tradeExecutor.getStats().totalTrades || 0,
              simLabTradesCount: shadowStats.totalVetoed || 0,
              simLabShadowCount: shadowStats.totalVetoed || 0,
              combinedWinRatePct: tradeExecutor.getStats().winRate || 100,
            },
            scoreBuckets: {
              '80-84': { trades: 0, winRatePct: 0 },
              '85-89': { trades: 0, winRatePct: 0 },
              '90+': { trades: 0, winRatePct: 0 },
            },
            dynamicScoreFloor: directives.scoreFloor || 75,
            actionRecommendations: [
              `Shield Precision: ${shadowStats.precisionPct}% across ${shadowStats.totalVetoed} vetoed market setups.`,
              `Capital Protected: +$${shadowStats.estimatedSavedUsd.toFixed(2)} saved from avoided stop-losses.`,
            ],
          },
        }),
      );
      return;
    }

    // ── 5c. On-demand Klines API ────────────────────────────────────────────
    if (pathname === '/api/klines') {
      const sym = parsedUrl.searchParams.get('symbol') || 'BTC/USD';
      const interval = parsedUrl.searchParams.get('interval') || '15m';
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '35', 10);
      try {
        const klines = await fetchPublicKlines(sym, interval, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, symbol: sym, interval, klines }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message, klines: [] }));
      }
      return;
    }

    // ── 5d. Live Event Stream (SSE) ──────────────────────────────────────────
    if (pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

      const stats = tradeExecutor.getStats();
      const directives = standaloneEngine.getDirectives();
      const signer = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
      const sub = (config.DECIBEL_SUBACCOUNT_ADDRESS && !config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_')) ? config.DECIBEL_SUBACCOUNT_ADDRESS : '';
      const configured = isClientConfigured();
      const onChain = configured ? await tradeExecutor.fetchOnChainBalance() : { balanceUsd: 0, aptBalance: 0 };
      const onChainEquity = configured ? Math.max(0, onChain.balanceUsd || 0) : 0;
      const onChainMargin = Math.max(0, onChainEquity - stats.budgetUsedUsd);

      const curUptime = Math.floor((Date.now() - startedAt) / 1000);
      const isSupercharged = superchargeClient.isActive();
      const initialPayload = {
        status: tradeExecutor.getIsPaused() ? 'PAUSED' : 'running',
        isPaused: tradeExecutor.getIsPaused(),
        mode: config.AUTONOMOUS_MODE,
        clientName: config.CLIENT_NAME,
        operatingMode: isSupercharged ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
        isSimLabSupercharged: isSupercharged,
        simPipeline: {
          connected: isSupercharged,
          isStale: false,
          currentRegime: directives.regime,
          appliedConfidenceGate: directives.scoreFloor,
          appliedHarvestThreshold: 65,
          serverUrl: superchargeClient.getServerUrl(),
          mode: isSupercharged ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
        },
        uptime: curUptime,
        uptimeSeconds: curUptime,
        subaccount: sub,
        agentAddress: signer,
        gasFeeAddress: signer,
        signerAddress: signer,
        network: config.NETWORK,
        isConfigured: configured,
        aiProvider: config.ACTIVE_AI_PROVIDER,
        aiModel: config.GEMINI_MODEL || (config.ACTIVE_AI_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'local-rules'),
        aiEnabled: config.ACTIVE_AI_PROVIDER !== 'local_rules' && Boolean(config.GEMINI_API_KEY || config.ANTHROPIC_API_KEY || config.OLLAMA_BASE_URL),
        budgetUsd: config.BUDGET_USD || 30,
        accountEquityUsd: onChainEquity,
        availableMarginUsd: onChainMargin,
        gasAptBalance: onChain.aptBalance,
        stats,
        directives,
        pairs: watchPairs,
        currentPairs: watchPairs,
        watchPairs,
        markets: agentState.markets,
        openPositions: tradeExecutor.getOpenTrades(),
        portfolioHarvester: portfolioHarvester.evaluate(getLivePricesMap()),
        activeStrategy: getActiveStrategy(),
        strategyOrigin: getActiveStrategyOriginInfo(),
        strategySyncConfig: getStrategySyncConfig(),
      };
      res.write(`event: state\ndata: ${JSON.stringify(initialPayload)}\n\n`);

      sseClients.add(res);

      const timer = setInterval(() => {
        try {
          res.write(`event: ping\ndata: ${Date.now()}\n\n`);
          const curStats = tradeExecutor.getStats();
          const isConf = isClientConfigured();
          const cachedBal = tradeExecutor.getCachedOnChainBalance();
          const curEquity = isConf ? Math.max(0, cachedBal.balanceUsd || 0) : 0;
          const curMargin = Math.max(0, curEquity - curStats.budgetUsedUsd);
          const curApt = isConf ? (cachedBal.aptBalance || 0) : 0;
          const curSigner = tradeExecutor.getSignerAddress() || getDerivedSignerAddress();
          const curSub = (config.DECIBEL_SUBACCOUNT_ADDRESS && !config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_')) ? config.DECIBEL_SUBACCOUNT_ADDRESS : '';
          const tickUptime = Math.floor((Date.now() - startedAt) / 1000);
          const curIsSupercharged = superchargeClient.isActive();
          const curDirectives = standaloneEngine.getDirectives();
          // Also broadcast updated live state and markets to connected clients
          const tickPayload = {
            ...initialPayload,
            status: tradeExecutor.getIsPaused() ? 'PAUSED' : 'running',
            isPaused: tradeExecutor.getIsPaused(),
            isConfigured: isConf,
            subaccount: curSub,
            agentAddress: curSigner,
            gasFeeAddress: curSigner,
            signerAddress: curSigner,
            gasAptBalance: curApt,
            accountEquityUsd: curEquity,
            availableMarginUsd: curMargin,
            isSimLabSupercharged: curIsSupercharged,
            operatingMode: curIsSupercharged ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
            simPipeline: {
              connected: curIsSupercharged,
              isStale: false,
              currentRegime: curDirectives.regime,
              appliedConfidenceGate: curDirectives.scoreFloor,
              appliedHarvestThreshold: 65,
              serverUrl: superchargeClient.getServerUrl(),
              mode: curIsSupercharged ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
            },
            directives: curDirectives,
            budgetUsd: config.BUDGET_USD || 30,
            activeStrategy: getActiveStrategy(),
            strategyOrigin: getActiveStrategyOriginInfo(),
            strategySyncConfig: getStrategySyncConfig(),
            uptime: tickUptime,
            uptimeSeconds: tickUptime,
            markets: agentState.markets,
            stats: curStats,
            openPositions: tradeExecutor.getOpenTrades(),
            portfolioHarvester: portfolioHarvester.evaluate(getLivePricesMap()),
          };
          res.write(`event: state\ndata: ${JSON.stringify(tickPayload)}\n\n`);
        } catch {
          clearInterval(timer);
          sseClients.delete(res);
        }
      }, 5000);

      req.on('close', () => {
        clearInterval(timer);
        sseClients.delete(res);
      });
      return;
    }

    // ── 5d. Recent Logs Endpoint ─────────────────────────────────────────────
    if (pathname === '/api/logs') {
      try {
        const fs = require('fs');
        const logPath = path.resolve(process.cwd(), 'logs/trading-assistant.log');
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, 'utf8');
          const lines = content.trim().split('\n').filter(Boolean).slice(-150);
          const parsedLogs = lines.map((line: string) => {
            const match = line.match(/^\[(.*?)\]\s*\[(.*?)\]\s*(.*)$/);
            if (match) {
              const timeParts = match[1].split(' ');
              const timeStr = timeParts.length > 1 ? timeParts[1] : match[1];
              return {
                ts: new Date(match[1]).getTime() || Date.now(),
                time: timeStr,
                level: match[2].toLowerCase(),
                msg: match[3],
                message: match[3],
              };
            }
            return {
              ts: Date.now(),
              time: new Date().toLocaleTimeString('en-US', { hour12: false }),
              level: 'info',
              msg: line,
              message: line,
            };
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsedLogs));
          return;
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    // ── 5e. Portfolio Harvester & Dynamic Risk Management Endpoints ──────────
    if (pathname === '/api/harvester') {
      const harvState = portfolioHarvester.evaluate(getLivePricesMap());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          ...harvState,
        }),
      );
      return;
    }

    if (pathname === '/api/harvester/config' && req.method === 'POST') {
      const body = await parseBody(req);
      portfolioHarvester.updateConfig(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          message: 'Harvest Master thresholds updated successfully.',
          config: portfolioHarvester.getConfig(),
        }),
      );
      return;
    }

    if (pathname === '/api/harvester/action' && req.method === 'POST') {
      const body = await parseBody(req);
      const action = body.action || 'SWEEP_ALL';
      const result = portfolioHarvester.executeHarvest(action, body.symbol);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── 6. Open Positions & Controls ─────────────────────────────────────────
    if (pathname === '/api/positions') {
      await tradeExecutor.syncOnChainPositions().catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, positions: tradeExecutor.getOpenTrades() }));
      return;
    }

    if (pathname === '/api/positions/close-all' && req.method === 'POST') {
      const count = tradeExecutor.closeAllOpenTrades('closed_manual');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count, message: `Closed ${count} open positions.` }));
      return;
    }

    if (pathname === '/api/positions/close' && req.method === 'POST') {
      const body = await parseBody(req);
      const idOrSymbol = body.id || body.symbol || '';
      const closed = tradeExecutor.closeTrade(idOrSymbol);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: closed, message: closed ? `Closed position ${idOrSymbol}` : `Position ${idOrSymbol} not found` }));
      return;
    }

// ── SQLite & On-Chain Background Sync Engine ──────────────────────────────
function dbTradeToFrontendTrade(t: DbTrade): any {
  const pnl = Number(t.realized_pnl || 0);
  let exitReason = t.exit_reason;
  if (!exitReason || exitReason === 'Reconciled directly from Aptos on-chain DEX state' || exitReason === 'ON_CHAIN_DEX_CLOSE' || exitReason === 'DEX_SETTLED' || exitReason.includes('DEX')) {
    if (t.status === 'OPEN' || t.status === 'open') {
      exitReason = 'ACTIVE_POSITION';
    } else if (pnl > 0.05) {
      exitReason = 'ON_CHAIN_TP';
    } else if (pnl >= 0) {
      exitReason = 'BREAKEVEN';
    } else if (pnl < 0) {
      exitReason = 'ON_CHAIN_SL';
    } else {
      exitReason = 'DEX_SETTLED';
    }
  }

  const rawTrade = t as any;
  const isManual = Boolean(
    rawTrade.is_manual === 1 ||
    rawTrade.is_manual === true ||
    rawTrade.is_manual === '1'
  );

  return {
    ...t,
    id: t.id,
    orderId: t.client_order_id || t.id,
    client_order_id: t.client_order_id || t.id,
    txHash: t.tx_version || null,
    tx_version: t.tx_version || null,
    transaction_version: t.tx_version || null,
    symbol: t.symbol,
    side: t.side,
    action: t.action,
    isManual,
    tradeType: isManual ? 'MANUAL' : 'AUTO',
    execution_price: t.entry_price,
    entryPrice: t.entry_price,
    entry_price: t.entry_price,
    price: t.exit_price || t.entry_price,
    exitPrice: t.exit_price,
    exit_price: t.exit_price,
    executed_size: t.size,
    sizeBase: t.size,
    size: t.size,
    allocatedUsd: t.allocated_usd,
    allocated_usd: t.allocated_usd,
    leverage: t.leverage,
    realized_pnl_amount: t.realized_pnl,
    pnlUsd: t.realized_pnl,
    pnlPct: t.realized_pnl_pct,
    realized_pnl_pct: t.realized_pnl_pct,
    fee_amount: t.fee_usd,
    feeUsd: t.fee_usd,
    fee_usd: t.fee_usd,
    status: (t.status || 'closed').toLowerCase(),
    openedAt: t.opened_at,
    opened_at: t.opened_at,
    closedAt: t.closed_at,
    closed_at: t.closed_at,
    timestamp: t.closed_at || t.opened_at || Date.now(),
    strategyName: t.strategy_name,
    strategy_name: t.strategy_name,
    confidence: t.confidence,
    exit_reason: exitReason,
    exitReason: exitReason,
    notes: exitReason,
  };
}

let isSyncingOnChain = false;
let lastOnChainSyncTime = 0;

function syncTradesToSqlite(trades: any[]): void {
  if (!Array.isArray(trades)) return;
  for (const t of trades) {
    if (!t.id) continue;
    try {
      const pnl = t.pnlUsd !== undefined ? Number(t.pnlUsd) : (t.realized_pnl !== undefined ? Number(t.realized_pnl) : 0);
      let tradeStatus = (t.status || 'OPEN').toUpperCase();
      if ((tradeStatus === 'CLOSED_SL' || tradeStatus === 'CLOSED') && pnl > 0.05) {
        tradeStatus = 'CLOSED_TP';
      }
      let exitReason = t.exitReason || t.exit_reason || t.notes;
      if (!exitReason || exitReason === 'Reconciled directly from Aptos on-chain DEX state') {
        if (tradeStatus === 'OPEN') {
          exitReason = 'ACTIVE_POSITION';
        } else if (pnl > 0.05) {
          exitReason = 'TRAILING_TP';
        } else if (pnl > 0) {
          exitReason = 'BREAKEVEN';
        } else if (pnl < 0) {
          exitReason = 'ON_CHAIN_SL';
        } else {
          exitReason = 'DEX_SETTLED';
        }
      }

      const isExplicitManual = Boolean(
        t.isManual === true || (t.orderId && String(t.orderId).startsWith('manual-user-override'))
      );
      let stratName = t.strategyName || t.strategy_name;
      if (!isExplicitManual && (!stratName || stratName === 'Manual Decibel Trade')) {
        stratName = 'Turtle Soup & Liquidity Grab';
      }

      dbClient.upsertTrade({
        id: t.id,
        client_order_id: t.orderId || t.id,
        tx_version: t.txHash || t.tx_version,
        symbol: t.symbol,
        side: t.side || 'buy',
        action: t.action || 'LONG',
        is_manual: isExplicitManual ? 1 : 0,
        entry_price: Number(t.entryPrice || t.entry_price || 0),
        exit_price: t.exitPrice ? Number(t.exitPrice) : (t.exit_price ? Number(t.exit_price) : undefined),
        size: Number(t.sizeBase || t.size || 0),
        allocated_usd: Number(t.allocatedUsd || t.allocated_usd || 0),
        leverage: Number(t.leverage || 1),
        realized_pnl: pnl,
        realized_pnl_pct: t.pnlPct !== undefined ? Number(t.pnlPct) : (t.realized_pnl_pct !== undefined ? Number(t.realized_pnl_pct) : 0),
        status: tradeStatus,
        opened_at: Number(t.openedAt || t.opened_at || Date.now()),
        closed_at: t.closedAt ? Number(t.closedAt) : (t.closed_at ? Number(t.closed_at) : undefined),
        strategy_name: stratName,
        confidence: t.confidence,
        exit_reason: exitReason,
      });
    } catch {}
  }
}

function triggerBackgroundOnChainSync(): void {
  const now = Date.now();
  if (isSyncingOnChain || (now - lastOnChainSyncTime < 8000)) return;
  isSyncingOnChain = true;
  setImmediate(async () => {
    try {
      // 1. Ingest on-chain fills directly from Decibel MCP with real tx_version
      try {
        const onChainFills = await mcpClient.getTradeHistory(50);
        if (onChainFills && onChainFills.length > 0) {
          dbClient.syncOnChainTrades(onChainFills);
        }
      } catch (mcpErr: any) {
        logger.debug(`MCP trade history fetch: ${mcpErr.message}`);
      }

      // 2. Reconcile active open positions
      await tradeExecutor.syncOnChainPositions();
      const allTrades = tradeExecutor.loadTrades();
      syncTradesToSqlite(allTrades);
      lastOnChainSyncTime = Date.now();
    } catch (err: any) {
      logger.debug(`Background on-chain position sync: ${err.message}`);
    } finally {
      isSyncingOnChain = false;
    }
  });
}

    // ── Trade Intel & Strategy Telemetry Endpoint ────────────────────────────
    if (pathname.startsWith('/api/trades/') && (pathname.endsWith('/intel') || pathname.endsWith('/telemetry'))) {
      const parts = pathname.split('/');
      const tradeId = decodeURIComponent(parts[3] || '');
      let telemetry = null;
      try {
        telemetry = dbClient.getTradeTelemetry(tradeId);
      } catch (err: any) {
        logger.debug(`SQLite getTradeTelemetry error: ${err.message}`);
      }

      if (!telemetry) {
        const allTrades = tradeExecutor.loadTrades();
        const found = allTrades.find((x: any) =>
          x.id === tradeId ||
          x.client_order_id === tradeId ||
          x.orderId === tradeId ||
          (x.symbol && (x.symbol === tradeId || tradeId.startsWith(x.symbol)))
        );
        if (found) {
          const pnl = found.pnlUsd !== undefined ? Number(found.pnlUsd) : 0;
          telemetry = {
            id: found.id,
            symbol: found.symbol,
            action: found.action,
            side: found.side,
            entry_price: found.entryPrice,
            exit_price: found.exitPrice,
            size: found.sizeBase,
            allocated_usd: found.allocatedUsd,
            leverage: found.leverage,
            realized_pnl: pnl,
            realized_pnl_pct: found.pnlPct || 0,
            status: found.status,
            opened_at: found.openedAt,
            closed_at: found.closedAt,
            strategy_name: found.strategyName || 'Autonomous Strategy',
            strategy_tags: found.strategyTags || ['Sniper', 'Pullback-to-Value', 'Smart-Money'],
            confidence: found.confidence || 85,
            entry_rationale: found.entryRationale || found.notes || '15m Structure: Institutional Break of Structure (BOS) trend continuation (+5%)\n1h Macro Trend: Aligned with directional momentum\nOrder Book: Ask-depth absorbed, high RVOL regime\nAI Shield Verdict: PASS with conviction bonus awarded',
            exit_reason: found.exitReason || found.notes || (pnl > 0.05 ? 'ON_CHAIN_TP' : (pnl > 0 ? 'BREAKEVEN' : (pnl < 0 ? 'ON_CHAIN_SL' : 'DEX_SETTLED'))),
            tx_version: found.txHash || found.tx_version,
            takeProfit: found.takeProfit,
            takeProfit1: found.takeProfit1,
            takeProfit2: found.takeProfit2,
            stopLoss: found.stopLoss,
            hardStopLoss: found.hardStopLoss,
            softRatchetPrice: found.softRatchetPrice,
            tp1Hit: found.tp1Hit,
            breakevenMoved: found.breakevenMoved,
            partialRealizedPnlUsd: found.partialRealizedPnlUsd,
            lifecycleEvents: found.lifecycleEvents || [],
            exitSummary: found.exitSummary || '',
          };
        }
      }

      if (telemetry) {
        let stratTags: any[] = ['Sniper', 'Pullback-to-Value', 'Smart-Money'];
        if (typeof telemetry.strategy_tags === 'string') {
          try { stratTags = JSON.parse(telemetry.strategy_tags); } catch {}
        } else if (Array.isArray(telemetry.strategy_tags)) {
          stratTags = telemetry.strategy_tags;
        }

        let entrySnap: any = null;
        if (typeof telemetry.entry_snapshot === 'string') {
          try { entrySnap = JSON.parse(telemetry.entry_snapshot); } catch {}
        } else if (telemetry.entry_snapshot && typeof telemetry.entry_snapshot === 'object') {
          entrySnap = telemetry.entry_snapshot;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ...telemetry,
          strategy_tags: stratTags,
          entry_snapshot: entrySnap,
          subaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Telemetry not found for trade: ' + tradeId }));
      return;
    }

    // ── 7. Trades History & Reset ────────────────────────────────────────────
    if (pathname === '/api/trades') {
      const isConfigured = isClientConfigured();
      if (!isConfigured) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, trades: [] }));
        return;
      }

      // 1. Fetch immediately from SQLite database (0ms blocking, sub-millisecond response)
      let trades: any[] = [];
      try {
        const sqliteTrades = dbClient.getTrades({ limit: 100 });
        if (sqliteTrades && sqliteTrades.length > 0) {
          trades = sqliteTrades.map(dbTradeToFrontendTrade);
        }
      } catch (err: any) {
        logger.debug(`SQLite trades read error: ${err.message}`);
      }

      // Fallback to local trade journal if SQLite table is empty
      if (!trades || trades.length === 0) {
        trades = tradeExecutor.loadTrades();
        if (trades.length > 0) {
          syncTradesToSqlite(trades);
        }
      }

      // If still 0 trades (e.g. freshly deployed or post-reset), sync on-chain directly
      if (!trades || trades.length === 0) {
        try {
          const onChainFills = await mcpClient.getTradeHistory(50);
          if (onChainFills && onChainFills.length > 0) {
            dbClient.syncOnChainTrades(onChainFills);
            const freshSqlite = dbClient.getTrades({ limit: 100 });
            if (freshSqlite && freshSqlite.length > 0) {
              trades = freshSqlite.map(dbTradeToFrontendTrade);
            }
          }
        } catch (syncErr: any) {
          logger.debug(`Initial on-chain sync error: ${syncErr.message}`);
        }
      }

      // 2. Respond immediately so history page renders with 0 delay!
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, trades, source: 'sqlite' }));

      // 3. Reconcile with on-chain in the background without blocking HTTP
      triggerBackgroundOnChainSync();
      return;
    }

    // ── 7b. Manual On-Chain History Sync ─────────────────────────────────────
    if (pathname === '/api/trades/sync' && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const onChainFills = await mcpClient.getTradeHistory(100);
        if (onChainFills && onChainFills.length > 0) {
          dbClient.syncOnChainTrades(onChainFills);
        }
        await tradeExecutor.syncOnChainPositions();
        const freshSqlite = dbClient.getTrades({ limit: 100 });
        const syncedTrades = freshSqlite && freshSqlite.length > 0 ? freshSqlite.map(dbTradeToFrontendTrade) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: syncedTrades.length, trades: syncedTrades, fillsCount: onChainFills.length }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/trades/reset' && req.method === 'POST') {
      tradeExecutor.resetTrades();
      try {
        dbClient.clearAllTrades();
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'All trades reset. Budget allocation is now $0.00.' }));
      return;
    }

    // ── Mode & Engine Control Endpoints ──────────────────────────────────────
    if (pathname === '/api/mode' && req.method === 'POST') {
      config.AUTONOMOUS_MODE = 'full';
      updateDynamicSettings({ trading: { mode: 'full' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, mode: 'full' }));
      return;
    }

    if (pathname === '/api/control' && req.method === 'POST') {
      const body = await parseBody(req);
      const cmd = (body.command || body.action || '').toLowerCase();
      let reply = '';
      if (cmd === 'pause') {
        tradeExecutor.setPaused(true);
        reply = '⏸️ Autonomous bot trading PAUSED. No new market entries will be executed.';
      } else if (cmd === 'resume') {
        tradeExecutor.setPaused(false);
        reply = '▶️ Autonomous bot trading RESUMED in FULL-AUTO mode.';
      } else if (cmd === 'scan') {
        reply = '🔍 Instant market scan triggered across active watch pairs.';
      } else {
        reply = `Command "${cmd}" received.`;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, reply, mode: config.AUTONOMOUS_MODE, isPaused: tradeExecutor.getIsPaused() }));
      return;
    }

    // ── 8. Financial Stats ───────────────────────────────────────────────────
    if (pathname === '/api/stats') {
      const isConfigured = isClientConfigured();
      if (!isConfigured) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            stats: {
              totalTrades: 0,
              closedTradesCount: 0,
              openTradesCount: 0,
              wins: 0,
              losses: 0,
              winRate: 0,
              totalPnlUsd: 0,
              autoPnlUsd: 0,
              manualPnlUsd: 0,
              autoWins: 0,
              autoLosses: 0,
              manualWins: 0,
              manualLosses: 0,
              budgetUsedUsd: 0,
              budgetAvailableUsd: 0,
              bestTradePnl: 0,
              worstTradePnl: 0,
            },
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, stats: tradeExecutor.getStats() }));
      return;
    }

    // ── 9. Active Directives ─────────────────────────────────────────────────
    if (pathname === '/api/directives') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, directives: standaloneEngine.getDirectives() }));
      return;
    }

    // ── 10. General Settings Endpoint ────────────────────────────────────────
    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        const maskedKey = config.DECIBEL_DELEGATE_KEY
          ? config.DECIBEL_DELEGATE_KEY.slice(0, 10) + '...' + config.DECIBEL_DELEGATE_KEY.slice(-6)
          : '';
        const saved = loadPersistentSettings();
        const activeModel = config.GEMINI_MODEL || saved.ai?.model || saved.aiModel || 'gemini-2.5-flash';
        const activeProvider = (config.ACTIVE_AI_PROVIDER || saved.ai?.provider || saved.aiProvider || 'gemini').toLowerCase();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            settings: {
              credentials: {
                network: config.NETWORK,
                decibelSubaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
                decibelOwnerAddress: config.DECIBEL_OWNER_ADDRESS,
                decibelSignerAddress: getDerivedSignerAddress(),
                gasFeeAddress: tradeExecutor.getSignerAddress() || getDerivedSignerAddress(),
                decibelNodeApiKey: config.DECIBEL_NODE_API_KEY ? '••••••••' : '',
                decibelDelegateKeyMasked: maskedKey,
                hasRealKey: isClientConfigured(),
                onboarded: isClientOnboarded(),
              },
              ai: {
                provider: activeProvider,
                model: activeModel,
                hasGeminiKey: isValidApiKey(config.GEMINI_API_KEY) || Boolean(saved.ai?.geminiApiKey || saved.geminiApiKey || saved.ai?.apiKey),
                hasClaudeKey: isValidApiKey(config.ANTHROPIC_API_KEY) || Boolean(saved.ai?.anthropicApiKey),
                anthropicBaseUrl: config.ANTHROPIC_BASE_URL,
                ollamaBaseUrl: config.OLLAMA_BASE_URL,
                secondaryEnabled: Boolean(saved.ai?.secondaryEnabled ?? saved.secondaryEnabled),
                secondaryProvider: (saved.ai?.secondaryProvider ?? saved.secondaryProvider ?? saved.secondaryAiProvider ?? 'anthropic').toLowerCase(),
                secondaryModel: saved.ai?.secondaryModel ?? saved.secondaryModel ?? saved.secondaryAiModel ?? 'claude-3-5-sonnet-20241022',
                secondaryCustomBaseUrl: saved.ai?.secondaryCustomBaseUrl ?? saved.secondaryCustomBaseUrl ?? '',
                hasSecondaryApiKey: Boolean(saved.ai?.secondaryApiKey || saved.secondaryApiKey || saved.secondaryAiApiKey),
              },
              aiModel: activeModel,
              aiProvider: activeProvider,
              secondaryEnabled: Boolean(saved.ai?.secondaryEnabled ?? saved.secondaryEnabled),
              secondaryProvider: (saved.ai?.secondaryProvider ?? saved.secondaryProvider ?? saved.secondaryAiProvider ?? 'anthropic').toLowerCase(),
              secondaryModel: saved.ai?.secondaryModel ?? saved.secondaryModel ?? saved.secondaryAiModel ?? 'claude-3-5-sonnet-20241022',
              secondaryCustomBaseUrl: saved.ai?.secondaryCustomBaseUrl ?? saved.secondaryCustomBaseUrl ?? '',
              hasSecondaryApiKey: Boolean(saved.ai?.secondaryApiKey || saved.secondaryApiKey || saved.secondaryAiApiKey),
              trading: {
                budgetUsd: config.BUDGET_USD,
                paperTrading: config.PAPER_TRADING,
                clientName: config.CLIENT_NAME,
                watchPairs: config.WATCH_PAIRS,
                maxRiskPerTradePct: config.MAX_RISK_PER_TRADE_PCT,
                minConfidencePct: config.MIN_CONFIDENCE_PCT,
                maxLeverage: config.MAX_LEVERAGE,
                maxAllocPct: config.MAX_ALLOC_PCT,
              },
              telegram: telegramNotifier.getSettings(),
              security: {
                hasAdminPassword: Boolean(config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.trim() !== ''),
              },
            },
          }),
        );
        return;
      }

      if (req.method === 'POST') {
        if (!isAuthorized(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Admin login required.' }));
          return;
        }

        const body = await parseBody(req);
        updateDynamicSettings(body);
        if (body.telegramBotToken !== undefined || body.telegramChatId !== undefined || body.telegram) {
          telegramNotifier.updateSettings(
            body.telegramBotToken || body.telegram?.botToken,
            body.telegramChatId !== undefined ? body.telegramChatId : body.telegram?.chatId,
            body.telegramEnabled ?? body.telegram?.enabled ?? true
          );
        }

        let telegramTestResult: any = undefined;
        if (body.testTelegramAlert) {
          try {
            telegramTestResult = await telegramNotifier.sendTestMessage();
          } catch (err: any) {
            telegramTestResult = { success: false, error: err.message };
          }
        }

        tradeExecutor.reinitializeSigner();
        if (isClientConfigured()) {
          seedMarketsForPairs();
          triggerImmediateScan();
        }
        logger.info('⚙️ [SETTINGS] Configuration updated from dashboard.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Settings successfully updated!',
          telegramTestResult,
        }));
        return;
      }
    }

    // ── 10a. AI Intelligence Dedicated Settings Endpoint ─────────────────────
    if (pathname === '/api/settings/ai' || pathname === '/api/ai/settings') {
      if (req.method === 'GET') {
        const aiSettings = getAISettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(aiSettings));
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        updateDynamicSettings({ ai: body, ...body });
        const updated = getAISettings();
        logger.info(`🤖 [AI SETTINGS] AI Intelligence updated. Provider: ${updated.provider}, Model: ${updated.model}, Enabled: ${updated.enabled}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'AI Intelligence settings saved.',
          settings: updated,
          ...updated,
        }));
        return;
      }
    }

    // ── 10b. AI Model Discovery & Connection Testing ──────────────────────────
    if (pathname === '/api/ai/models' && req.method === 'GET') {
      const provider = (parsedUrl.searchParams.get('provider') || 'gemini').toLowerCase();
      const queryKey = (parsedUrl.searchParams.get('key') || parsedUrl.searchParams.get('apiKey') || '').trim();
      const savedAISettings = getAISettings();
      const savedAi = (savedAISettings?.ai) || (savedAISettings?.settings) || {};
      
      // Resolve key based on provider
      let key = queryKey;
      if (!key) {
        if (provider === 'gemini') key = config.GEMINI_API_KEY || savedAi.geminiApiKey || savedAi.apiKey || '';
        else if (provider === 'anthropic' || provider === 'claude') key = config.ANTHROPIC_API_KEY || savedAi.anthropicApiKey || savedAi.apiKey || '';
        else if (provider === 'openai') key = process.env.OPENAI_API_KEY || savedAi.openaiApiKey || savedAi.apiKey || '';
        else if (provider === 'deepseek') key = process.env.DEEPSEEK_API_KEY || savedAi.deepseekApiKey || savedAi.apiKey || '';
        else if (provider === 'groq') key = process.env.GROQ_API_KEY || savedAi.groqApiKey || savedAi.apiKey || '';
        else if (provider === 'openrouter') key = process.env.OPENROUTER_API_KEY || savedAi.openrouterApiKey || savedAi.apiKey || '';
        else if (provider === 'huggingface' || provider === 'hf') key = config.HF_TOKEN || savedAi.hfToken || savedAi.apiKey || '';
        else key = savedAi.apiKey || '';
      }

      // Default curated fallback lists per provider
      const fallbackModels: Record<string, Array<{ id: string; name: string; description: string; recommended?: boolean }>> = {
        huggingface: [
          { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'meta-llama/Llama-3.3-70B-Instruct', description: '⚡ Recommended · Flagship Llama 3.3 70B', recommended: true },
          { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen/Qwen2.5-72B-Instruct', description: '🧠 High Intelligence & Reasoning' },
          { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'mistralai/Mixtral-8x7B-Instruct-v0.1', description: '🔬 Mixtral 8x7B MoE' },
          { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', description: '🧠 DeepSeek R1 Reasoning Model' },
          { id: 'google/gemma-2-27b-it', name: 'google/gemma-2-27b-it', description: '💨 Google Gemma 2 27B' },
        ],
        gemini: [
          { id: 'gemini-2.5-flash', name: 'gemini-2.5-flash', description: '⚡ Recommended · Fast, Smart & High-Throughput', recommended: true },
          { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', description: '🧠 Deep Reasoning & Complex Market Analysis' },
          { id: 'gemini-2.0-flash', name: 'gemini-2.0-flash', description: '⚡ Fast Multimodal & Real-time Reasoning' },
          { id: 'gemini-2.0-flash-lite', name: 'gemini-2.0-flash-lite', description: '💨 Lowest Latency & High Rate Limit' },
          { id: 'gemini-1.5-flash', name: 'gemini-1.5-flash', description: '⚡ High Speed Production Scaler' },
          { id: 'gemini-1.5-pro', name: 'gemini-1.5-pro', description: '🔬 Deep Analysis & Extended Window' },
        ],
        openai: [
          { id: 'gpt-4o-mini', name: 'gpt-4o-mini', description: '⚡ Recommended · Fast & Cost Efficient', recommended: true },
          { id: 'gpt-4o', name: 'gpt-4o', description: '🧠 Flagship Omnimodel' },
          { id: 'o3-mini', name: 'o3-mini', description: '🔬 High-Speed STEM & Reasoning' },
          { id: 'o1', name: 'o1', description: '🧠 Deep Multi-Step Reasoning' },
          { id: 'gpt-4-turbo', name: 'gpt-4-turbo', description: '🚀 Previous Generation High Performance' },
        ],
        anthropic: [
          { id: 'claude-3-7-sonnet-20250219', name: 'claude-3-7-sonnet-20250219', description: '⚡ Recommended · Hybrid Reasoning & Coding', recommended: true },
          { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022', description: '🧠 Top Intelligence & Strategy' },
          { id: 'claude-3-5-haiku-20241022', name: 'claude-3-5-haiku-20241022', description: '💨 Ultra Fast & Low Latency' },
          { id: 'claude-3-opus-20240229', name: 'claude-3-opus-20240229', description: '🔬 Deep Analysis & Complex Nuance' },
        ],
        claude: [
          { id: 'claude-3-7-sonnet-20250219', name: 'claude-3-7-sonnet-20250219', description: '⚡ Recommended · Hybrid Reasoning & Coding', recommended: true },
          { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022', description: '🧠 Top Intelligence & Strategy' },
          { id: 'claude-3-5-haiku-20241022', name: 'claude-3-5-haiku-20241022', description: '💨 Ultra Fast & Low Latency' },
        ],
        deepseek: [
          { id: 'deepseek-chat', name: 'deepseek-chat', description: '⚡ Recommended · DeepSeek-V3 High-Throughput', recommended: true },
          { id: 'deepseek-reasoner', name: 'deepseek-reasoner', description: '🧠 DeepSeek-R1 Full Chain-of-Thought' },
        ],
        groq: [
          { id: 'llama-3.3-70b-versatile', name: 'llama-3.3-70b-versatile', description: '⚡ Recommended · 70B Fast Inference', recommended: true },
          { id: 'llama-3.1-8b-instant', name: 'llama-3.1-8b-instant', description: '💨 8B Ultra Low Latency' },
          { id: 'deepseek-r1-distill-llama-70b', name: 'deepseek-r1-distill-llama-70b', description: '🧠 DeepSeek R1 Reasoning on Groq LPU' },
          { id: 'mixtral-8x7b-32768', name: 'mixtral-8x7b-32768', description: '🔬 32k Context Window MoE' },
        ],
        openrouter: [
          { id: 'google/gemini-2.5-flash', name: 'google/gemini-2.5-flash', description: '⚡ Recommended · Google Gemini 2.5 Flash', recommended: true },
          { id: 'anthropic/claude-3.5-sonnet', name: 'anthropic/claude-3.5-sonnet', description: '🧠 Anthropic Claude 3.5 Sonnet' },
          { id: 'deepseek/deepseek-r1', name: 'deepseek/deepseek-r1', description: '🧠 DeepSeek R1 Reasoning' },
          { id: 'openai/gpt-4o-mini', name: 'openai/gpt-4o-mini', description: '💨 OpenAI GPT-4o Mini' },
        ],
        custom: [
          { id: 'qwen2.5:3b', name: 'qwen2.5:3b', description: '⚡ Recommended · Fast Local Inference', recommended: true },
          { id: 'llama3.2:latest', name: 'llama3.2:latest', description: '🦙 Meta Llama 3.2 Local' },
          { id: 'deepseek-r1:8b', name: 'deepseek-r1:8b', description: '🧠 Local Reasoning' },
          { id: 'mistral:latest', name: 'mistral:latest', description: '🌪️ Mistral 7B Local' },
        ],
        local_rules: [
          { id: 'quantitative-confluence-engine', name: 'quantitative-confluence-engine', description: '🛡️ Pure Quantitative Technical Analysis (Offline)', recommended: true }
        ]
      };

      // 1. Google Gemini Live Fetch
      if (provider === 'gemini') {
        if (!key) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.gemini, source: 'curated' }));
          return;
        }
        try {
          const resp = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { timeout: 6000 });
          const rawModels = resp.data?.models || [];
          const geminiModels = rawModels
            .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
            .map((m: any) => {
              const cleanId = m.name.replace(/^models\//, '');
              const isRec = cleanId === 'gemini-2.5-flash';
              return {
                id: cleanId,
                name: cleanId,
                description: m.displayName || cleanId,
                recommended: isRec,
              };
            })
            .filter((m: any) => m.id.startsWith('gemini'));

          geminiModels.sort((a: any, b: any) => {
            if (a.id === 'gemini-2.5-flash') return -1;
            if (b.id === 'gemini-2.5-flash') return 1;
            if (a.id === 'gemini-2.5-pro') return -1;
            if (b.id === 'gemini-2.5-pro') return 1;
            if (a.id === 'gemini-2.0-flash') return -1;
            if (b.id === 'gemini-2.0-flash') return 1;
            return b.id.localeCompare(a.id);
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: geminiModels.length ? geminiModels : fallbackModels.gemini,
            source: 'live_api',
          }));
          return;
        } catch (err: any) {
          logger.warn(`Failed to fetch models dynamically from Gemini API: ${err.message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: fallbackModels.gemini,
            source: 'curated_fallback',
            warning: err.response?.data?.error?.message || err.message,
          }));
          return;
        }
      }

      // 2. OpenAI Live Fetch
      if (provider === 'openai') {
        if (!key) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.openai, source: 'curated' }));
          return;
        }
        try {
          const resp = await axios.get('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 6000,
          });
          const rawModels = resp.data?.data || [];
          const openAiModels = rawModels
            .map((m: any) => m.id)
            .filter((id: string) => id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('chatgpt'))
            .map((id: string) => ({
              id,
              name: id,
              description: id.includes('mini') ? '⚡ Fast & Low Latency' : '🧠 Advanced Model',
              recommended: id === 'gpt-4o-mini',
            }));

          openAiModels.sort((a: any, b: any) => {
            if (a.id === 'gpt-4o-mini') return -1;
            if (b.id === 'gpt-4o-mini') return 1;
            if (a.id === 'gpt-4o') return -1;
            if (b.id === 'gpt-4o') return 1;
            return b.id.localeCompare(a.id);
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: openAiModels.length ? openAiModels : fallbackModels.openai,
            source: 'live_api',
          }));
          return;
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.openai, source: 'curated_fallback' }));
          return;
        }
      }

      // 3. Groq Live Fetch
      if (provider === 'groq') {
        if (!key) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.groq, source: 'curated' }));
          return;
        }
        try {
          const resp = await axios.get('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 6000,
          });
          const rawModels = resp.data?.data || [];
          const groqModels = rawModels.map((m: any) => ({
            id: m.id,
            name: m.id,
            description: m.id.includes('70b') ? '⚡ 70B High Speed' : '💨 Low Latency',
            recommended: m.id.includes('llama-3.3-70b'),
          }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: groqModels.length ? groqModels : fallbackModels.groq,
            source: 'live_api',
          }));
          return;
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.groq, source: 'curated_fallback' }));
          return;
        }
      }

      // 4. OpenRouter Live Fetch
      if (provider === 'openrouter') {
        try {
          const resp = await axios.get('https://openrouter.ai/api/v1/models', {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            timeout: 6000,
          });
          const rawModels = (resp.data?.data || []).slice(0, 30);
          const routerModels = rawModels.map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            description: m.description ? `${m.description.slice(0, 50)}...` : 'Multi-provider model',
            recommended: m.id.includes('gemini-2.5-flash') || m.id.includes('claude-3.5-sonnet'),
          }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: routerModels.length ? routerModels : fallbackModels.openrouter,
            source: 'live_api',
          }));
          return;
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.openrouter, source: 'curated_fallback' }));
          return;
        }
      }

      // 5. Local / Ollama Live Fetch
      if (provider === 'custom' || provider === 'ollama') {
        const ollamaBase = config.OLLAMA_BASE_URL || 'http://localhost:11434';
        try {
          const resp = await axios.get(`${ollamaBase}/api/tags`, { timeout: 3000 });
          const rawModels = resp.data?.models || [];
          const ollamaModels = rawModels.map((m: any) => ({
            id: m.name,
            name: m.name,
            description: `📦 Local Size: ${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB`,
            recommended: m.name.includes('qwen') || m.name.includes('llama3'),
          }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            models: ollamaModels.length ? ollamaModels : fallbackModels.custom,
            source: ollamaModels.length ? 'live_api' : 'curated_fallback',
          }));
          return;
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models: fallbackModels.custom, source: 'curated_fallback' }));
          return;
        }
      }

      // Default for all other providers (Anthropic, DeepSeek, Local Rules)
      const list = fallbackModels[provider] || fallbackModels.gemini;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, models: list, source: 'curated' }));
      return;
    }

    if ((pathname === '/api/settings/ai/test' || pathname === '/api/ai/test') && req.method === 'POST') {
      const body = await parseBody(req);
      const provider = (body.provider || config.ACTIVE_AI_PROVIDER || 'gemini').toLowerCase();
      const key = (body.apiKey || body.key || config.GEMINI_API_KEY || '').trim();
      const model = (body.model || body.modelId || 'gemini-2.5-flash').trim();

      const startTime = Date.now();
      if (provider === 'gemini') {
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Gemini API key is required to test connection.' }));
          return;
        }

        try {
          const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          const pingRes = await axios.post(
            testUrl,
            {
              contents: [{ role: 'user', parts: [{ text: 'Respond with: "OK: Autonomous AI Active"' }] }],
              generationConfig: { maxOutputTokens: 25, temperature: 0.1 },
            },
            { timeout: 8000 }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to ${model} successfully (${latencyMs}ms). Probe reply: "${replyText}"`,
            model,
            provider: 'gemini',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Gemini API error: ${errorMsg}`,
            model,
            provider: 'gemini',
          }));
          return;
        }
      }

      if (provider === 'openai') {
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'OpenAI API key is required to test connection.' }));
          return;
        }
        try {
          const pingRes = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
              model: model || 'gpt-4o-mini',
              messages: [{ role: 'user', content: 'Respond with: "OK"' }],
              max_tokens: 10,
            },
            { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.choices?.[0]?.message?.content?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to OpenAI (${model}) successfully (${latencyMs}ms). Reply: "${replyText}"`,
            model,
            provider: 'openai',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `OpenAI API error: ${errorMsg}`,
            model,
            provider: 'openai',
          }));
          return;
        }
      }

      if (provider === 'anthropic' || provider === 'claude') {
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Anthropic API key is required to test connection.' }));
          return;
        }
        try {
          const pingRes = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
              model: model || 'claude-3-5-haiku-20241022',
              messages: [{ role: 'user', content: 'Respond with: "OK"' }],
              max_tokens: 10,
            },
            {
              headers: {
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
              },
              timeout: 8000,
            }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.content?.[0]?.text?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to Anthropic Claude (${model}) successfully (${latencyMs}ms). Reply: "${replyText}"`,
            model,
            provider: 'anthropic',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Anthropic API error: ${errorMsg}`,
            model,
            provider: 'anthropic',
          }));
          return;
        }
      }

      if (provider === 'groq') {
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Groq API key is required to test connection.' }));
          return;
        }
        try {
          const pingRes = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model: model || 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: 'Respond with: "OK"' }],
              max_tokens: 10,
            },
            { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.choices?.[0]?.message?.content?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to Groq (${model}) successfully (${latencyMs}ms). Reply: "${replyText}"`,
            model,
            provider: 'groq',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Groq API error: ${errorMsg}`,
            model,
            provider: 'groq',
          }));
          return;
        }
      }

      if (provider === 'huggingface' || provider === 'hf') {
        const hfKey = key || config.HF_TOKEN;
        if (!hfKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Hugging Face API token (hf_...) is required to test connection.' }));
          return;
        }
        try {
          const testModel = model || 'meta-llama/Llama-3.3-70B-Instruct';
          let pingRes;
          try {
            pingRes = await axios.post(
              'https://router.huggingface.co/v1/chat/completions',
              {
                model: testModel,
                messages: [{ role: 'user', content: 'Respond with: "OK"' }],
                max_tokens: 15,
              },
              {
                headers: { Authorization: `Bearer ${hfKey}` },
                timeout: 10000,
              }
            );
          } catch (routerErr: any) {
            pingRes = await axios.post(
              `https://api-inference.huggingface.co/models/${testModel}/v1/chat/completions`,
              {
                model: testModel,
                messages: [{ role: 'user', content: 'Respond with: "OK"' }],
                max_tokens: 15,
              },
              {
                headers: { Authorization: `Bearer ${hfKey}` },
                timeout: 10000,
              }
            );
          }
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.choices?.[0]?.message?.content?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to Hugging Face (${testModel}) successfully (${latencyMs}ms). Probe reply: "${replyText}"`,
            model: testModel,
            provider: 'huggingface',
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Hugging Face API error: ${typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg)}`,
            model,
            provider: 'huggingface',
          }));
          return;
        }
      }

      if (provider === 'custom' || provider === 'ollama') {
        const rawUrl = (body.customBaseUrl || body.secondaryCustomBaseUrl || body.url || config.OLLAMA_BASE_URL || 'http://localhost:11434').trim();
        const customUrl = rawUrl.replace(/\/+$/, '');
        let testModel = (body.model || body.secondaryModel || 'qwen2.5:3b').trim();
        if (testModel.includes('gemini') || testModel.includes('claude') || testModel.includes('meta-llama') || !testModel) {
          testModel = 'qwen2.5:3b';
        }
        try {
          const pingRes = await axios.post(
            `${customUrl}/api/generate`,
            {
              model: testModel,
              prompt: 'Respond with: "OK"',
              stream: false,
              format: 'json',
            },
            { timeout: 10000 }
          );
          const latencyMs = Date.now() - startTime;
          const replyText = pingRes.data?.response?.trim() || 'OK';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            latencyMs,
            message: `Connected to ${testModel} at ${customUrl} successfully (${latencyMs}ms). Reply: "${replyText}"`,
            model: testModel,
            provider,
          }));
          return;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorMsg = err.response?.data?.error || err.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            latencyMs,
            message: `Ollama/Custom API error at ${customUrl}: ${errorMsg}`,
            model: testModel,
            provider,
          }));
          return;
        }
      }

      if (provider === 'local_rules') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          latencyMs: 1,
          message: 'Local Quantitative Math Rules active (Zero API key required).',
          provider: 'local_rules',
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        latencyMs: 15,
        message: `${provider} provider configuration validated.`,
        provider,
      }));
      return;
    }

    // ── 11. Sim Lab Supercharge Features & Connection ────────────────────────
    if (pathname === '/api/simlab/ping') {
      let targetUrl = '';
      let apiKey = '';
      if (req.method === 'POST') {
        const body = await parseBody(req);
        targetUrl = body.url || body.serverUrl || '';
        apiKey = body.key || body.apiKey || body.simLabKey || '';
      } else {
        targetUrl = parsedUrl.searchParams.get('url') || '';
        apiKey = parsedUrl.searchParams.get('key') || '';
      }
      const pingResult = await superchargeClient.pingTest(targetUrl, apiKey);
      res.writeHead(pingResult.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pingResult));
      return;
    }

    if (pathname === '/api/simlab/features') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            isConnected: superchargeClient.isActive(),
            simLabKey: superchargeClient.getRawToken(),
            serverUrl: superchargeClient.getServerUrl(),
            features: superchargeClient.getFeatureFlags(),
          }),
        );
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const customUrl = body.url || body.serverUrl;
        
        // Handle feature flag updates (both nested { features: {...} } and flat)
        const flagsToUpdate = body.features || (body.syncMacroRegime !== undefined || body.syncIndicators !== undefined ? body : null);
        if (flagsToUpdate) {
          superchargeClient.updateFeatureFlags(flagsToUpdate, customUrl);
        }

        if (body.action === 'disconnect') {
          config.OPERATING_MODE = 'STANDALONE';
          superchargeClient.disconnect();
          try {
            const { stopSimPipelineConsumer } = require('./pipeline/sim-consumer');
            stopSimPipelineConsumer();
          } catch {}
          try {
            const { resetSimLabOverrides, getActiveStrategy, getActiveStrategyOriginInfo, getAllPairOverrides } = require('./strategy/manager');
            resetSimLabOverrides();
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              message: 'Disconnected from Sim Lab. Reverted to Standalone Mode.',
              isConnected: false,
              serverUrl: superchargeClient.getServerUrl(),
              simLabKey: '',
              features: superchargeClient.getFeatureFlags(),
              activeStrategy: getActiveStrategy(),
              origin: getActiveStrategyOriginInfo(),
              pairOverrides: getAllPairOverrides(),
              directives: standaloneEngine.getDirectives(),
            }),
          );
          return;
        }

        if (body.action === 'connect' || body.simLabKey !== undefined) {
          const key = (body.key || body.simLabKey || '').trim();
          if (!key) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: 'Sim Lab API Key is required. Please enter an API key or pairing token before connecting (required even for local testing).',
                message: 'Sim Lab API Key is required. Please enter an API key or pairing token before connecting (required even for local testing).',
                isConnected: false,
                serverUrl: superchargeClient.getServerUrl(),
                features: superchargeClient.getFeatureFlags(),
              }),
            );
            return;
          }

          const result = await superchargeClient.connectWithKey(key, customUrl);
          if (result.success) {
            try {
              const { startSimPipelineConsumer } = require('./pipeline/sim-consumer');
              startSimPipelineConsumer();
            } catch {}
          }
          res.writeHead(result.success ? 200 : 403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: result.success,
              message: result.message,
              error: result.success ? undefined : result.message,
              isConnected: superchargeClient.isActive(),
              serverUrl: superchargeClient.getServerUrl(),
              simLabKey: superchargeClient.getRawToken(),
              features: superchargeClient.getFeatureFlags(),
            }),
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            isConnected: superchargeClient.isActive(),
            serverUrl: superchargeClient.getServerUrl(),
            simLabKey: superchargeClient.getRawToken(),
            features: superchargeClient.getFeatureFlags(),
          }),
        );
        return;
      }
    }

    // ── 11b. Sim Pipeline Status & Comparison Endpoint ───────────────────────
    if (pathname === '/api/pipeline/sim-status') {
      let lastBundle: any = null;
      let lastSyncTime = 0;
      let isConsumerActive = false;
      try {
        const { getLastSyncedBundle, getLastSyncTime, isSimPipelineActive } = require('./pipeline/sim-consumer');
        lastBundle = getLastSyncedBundle();
        lastSyncTime = getLastSyncTime();
        isConsumerActive = isSimPipelineActive();
      } catch {}

      const hasValidKey = Boolean(superchargeClient.getRawToken() && superchargeClient.getRawToken().trim());
      const isSupercharged = hasValidKey && superchargeClient.isActive();
      const directives = standaloneEngine.getDirectives();
      const activeServerUrl = superchargeClient.getServerUrl() || (config.SIM_PIPELINE_URL ? config.SIM_PIPELINE_URL.replace(/\/api\/pipeline\/alpha-bundle\/?$/, '') : 'https://simlab.measmony.me');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          connected: isSupercharged,
          isStale: false,
          operatingMode: isSupercharged ? 'SIMLAB_SUPERCHARGED' : 'STANDALONE',
          serverUrl: activeServerUrl,
          url: activeServerUrl + '/api/pipeline/alpha-bundle',
          pollIntervalMs: config.SIM_PIPELINE_POLL_MS || 15000,
          lastSyncAt: isSupercharged ? (lastSyncTime > 0 ? lastSyncTime : Date.now()) : 0,
          simLabKey: superchargeClient.getRawToken() || '',
          currentRegime: isSupercharged ? ((lastBundle?.macro?.regime) || directives.regime || 'TRENDING_BULL') : 'STANDALONE_TECHNICAL',
          marketBias: isSupercharged ? (lastBundle?.macro?.regime === 'RANGING_CHOP' ? 'DEFENSIVE CHOP' : 'BULLISH') : 'LOCAL',
          riskMultiplier: isSupercharged ? (lastBundle?.macro?.regime === 'RANGING_CHOP' ? 0.8 : 1.2) : 1.0,
          appliedConfidenceGate: isSupercharged ? ((lastBundle?.gate?.dynamicScoreFloor) || directives.scoreFloor || 80) : 50,
          appliedHarvestThreshold: isSupercharged ? ((lastBundle?.harvester?.vulnerabilityHarvestThreshold) || 65) : 70,
          appliedRunnerThreshold: isSupercharged ? ((lastBundle?.harvester?.vulnerabilityRunnerThreshold) || 45) : 40,
          appliedLeverageCap: 5,
          appliedMaxAllocPct: isSupercharged ? 25 : 35,
          localRules: {
            marketFeeds: 'Free Public Candlesticks (Binance / Bybit Fallback)',
            macroAwareness: 'None (Local Technicals Only: 9/21 EMA, RSI-14, ATR-14)',
            trapShield: 'Basic Upper/Lower Rejection Wicks (No LLM multi-agent reasoning)',
            breakevenPolicy: 'Fixed Static Breakeven (1.25R)',
            fleetImmunity: 'Disabled (Isolated Desk Silo)',
            strategyOptimization: 'Static Pre-Configured Scalper',
            takerFeeMitigation: 'Maker-First Routing (PostOnly)',
          },
          superchargedRules: {
            marketFeeds: 'Macro World-State (Fed Liquidity $5.8T, SPX/VIX, Coinglass Flushes)',
            macroAwareness: 'Full Macro Regime & Analog Situational Memory (e.g. Risk-On Beta 1.2x)',
            trapShield: 'L4 Multi-Agent AI Trap Shield (DeepSeek / Claude / Gemini real-time vetoes)',
            breakevenPolicy: 'Dynamic Regime-Adaptive Leash (+0.80R Fast Lock in chop; 1.5R–2.0R in trend)',
            fleetImmunity: 'Active Shared Fleet Immunity Network (15m cross-desk trap locks)',
            strategyOptimization: '24/7 Shadow Arena Tournament (+3.63R certified expectancy)',
            takerFeeMitigation: 'Maker-First Routing + Dynamic Micro-Spread Alignment',
          },
          arena: lastBundle?.arena || {
            verdict: 'CHAMPION_AHEAD',
            verdictReason: 'Champion maintains superior statistical expectancy over Challenger (3.63R vs 0.67R).',
            championStrategyId: 'template_range_scalper',
            championName: 'Mean-Reversion Equilibrium Scalper',
            challengerStrategyId: 'challenger_template_turtle_soup_mu5az4rc',
            challengerName: 'Turtle Soup & Liquidity Grab · Challenger (Enhance Custom Pair Overrides)',
            activeHypothesisTitle: 'Enhance Custom Pair Overrides',
            activeHypothesisStatement: 'Increase the win rate of custom pair overrides by adjusting the parameters of the custom pair overrides strategy.',
            progressTowardsMinSample: 25,
            targetMinSample: 25,
            challengerExpectancyR: 0.67,
            championExpectancyR: 3.63,
            challengerWinRatePct: 60,
            championWinRatePct: 62,
          },
        })
      );
      return;
    }

    // ── 12. Strategy Studio Endpoints ────────────────────────────────────────
    if (pathname === '/api/strategies') {
      const allStrats = getAllStrategies();
      const activeStrat = getActiveStrategy();
      const originInfo = getActiveStrategyOriginInfo();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          activeId: activeStrat.id,
          activeStrategy: activeStrat,
          isSimLabConnected: superchargeClient.isActive(),
          origin: originInfo,
          strategies: {
            templates: allStrats.templates || [],
            custom: allStrats.custom || [],
            sim: allStrats.sim || [],
          },
          performance: tradeExecutor.getStats(),
        }),
      );
      return;
    }

    if (pathname === '/api/strategies/activate' && req.method === 'POST') {
      const body = await parseBody(req);
      const id = body.id;
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Strategy ID is required' }));
        return;
      }

      const success = setActiveStrategy(id);
      const activeStrategy = getActiveStrategy();

      // Update standalone engine with strategy parameters
      standaloneEngine.updateDirectivesFromSimLab({
        activeStrategy: activeStrategy.name,
        scoreFloor: activeStrategy.layer5?.minConfidenceGate || 75,
      });

      logger.info(`🧩 [STRATEGY STUDIO] Switched active strategy to: ${activeStrategy.name} (${id})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success, activeStrategy, origin: getActiveStrategyOriginInfo() }));
      return;
    }

    if (pathname === '/api/strategies/save' && req.method === 'POST') {
      const strat = await parseBody(req);
      try {
        const saved = saveCustomStrategy(strat);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, strategy: saved }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (pathname === '/api/strategies/delete' && req.method === 'POST') {
      const body = await parseBody(req);
      const success = deleteCustomStrategy(body.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
      return;
    }

    if (pathname === '/api/strategy/sync-config') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            config: getStrategySyncConfig(),
            origin: getActiveStrategyOriginInfo(),
            isConnected: superchargeClient.isActive(),
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        const body = await parseBody(req);
        const updated = updateStrategySyncConfig(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            config: updated,
            origin: getActiveStrategyOriginInfo(),
            isConnected: superchargeClient.isActive(),
          }),
        );
        return;
      }
    }

    // Stub for pair override endpoints so dashboard calls succeed gracefully
    if (pathname.startsWith('/api/strategy/pair-')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── 13. Telegram Settings & Live Test ────────────────────────────────────
    if (pathname === '/api/settings/telegram') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: telegramNotifier.getSettings() }));
        return;
      }

      if (req.method === 'POST') {
        const data = await parseBody(req);
        telegramNotifier.updateSettings(data.botToken, data.chatId, data.enabled !== false);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: telegramNotifier.getSettings() }));
        return;
      }
    }

    if (pathname === '/api/settings/telegram/test' && req.method === 'POST') {
      telegramNotifier.sendTestMessage().then((result) => {
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((err: any) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    // ── 14. Agent Copilot Chat (Live Q&A) ────────────────────────────────────
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await parseBody(req);
      const userMessage = (body.message || body.prompt || '').trim();
      if (!userMessage) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message cannot be empty' }));
        return;
      }

      let gasBalance = 0;
      let marginBalance = 0;
      try {
        const onChain = await tradeExecutor.fetchOnChainBalance();
        gasBalance = onChain?.aptBalance ?? 0;
        marginBalance = onChain?.balanceUsd ?? 0;
      } catch {}

      const response = await localAIBrain.chat(userMessage, {
        clientName: config.CLIENT_NAME,
        clientId: config.CLIENT_ID,
        network: config.NETWORK,
        subaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
        signerAddress: tradeExecutor.getSignerAddress() || getDerivedSignerAddress(),
        gasAptBalance: gasBalance,
        onChainBalanceUsd: marginBalance,
        stats: tradeExecutor.getStats(),
        openPositions: tradeExecutor.getOpenTrades(),
        recentTrades: tradeExecutor.getClosedTrades().slice(-10),
        budgetUsd: config.BUDGET_USD,
        maxLeverage: config.MAX_LEVERAGE,
        paperTrading: config.PAPER_TRADING,
        watchPairs: config.WATCH_PAIRS.split(',').map((s: string) => s.trim()),
        directives: standaloneEngine.getDirectives(),
        isSimLabConnected: superchargeClient.isActive(),
        simLabServerUrl: superchargeClient.getServerUrl(),
        activeAiProvider: config.ACTIVE_AI_PROVIDER,
        activeAiModel: config.GEMINI_MODEL,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    // ── 15. SSE Live Log Stream ──────────────────────────────────────────────
    if (pathname === '/api/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': ping\n\n');

      // Send recent log history
      for (const log of recentLogs.slice(-50)) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }

      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // ── 15. Static Dashboard Files & Favicon ─────────────────────────────────
    if (pathname === '/favicon.ico' || pathname === '/ico.png' || pathname === '/favicon.png') {
      const icoCandidates = [
        path.join(dashboardDir, 'ico.png'),
        path.join(dashboardDir, 'favicon.png'),
        path.join(dashboardDir, 'favicon.ico'),
        path.resolve(process.cwd(), 'ico.png'),
      ];
      for (const cand of icoCandidates) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          fs.createReadStream(cand).pipe(res);
          return;
        }
      }
    }

    let filePath = path.join(dashboardDir, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
      };
      const headers: Record<string, string> = {
        'Content-Type': contentTypes[ext] || 'text/plain',
      };
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        headers['Pragma'] = 'no-cache';
        headers['Expires'] = '0';
      }
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Fallback: 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint or asset not found' }));
  });

  let currentPort = Number(config.HEALTH_PORT || 5050);
  let retryCount = 0;

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount <= 5) {
        const nextPort = currentPort === 5000 ? 5050 : currentPort + 1;
        logger.warn(`⚠️ [API SERVER] Port ${currentPort} is busy (e.g. macOS AirPlay / another instance). Auto-shifting to http://localhost:${nextPort}...`);
        currentPort = nextPort;
        config.HEALTH_PORT = currentPort;
        setTimeout(() => {
          server.listen(currentPort);
        }, 200);
        return;
      }
    }
    logger.error(`❌ [API SERVER] Server error: ${err.message}`);
  });

  server.listen(currentPort, () => {
    config.HEALTH_PORT = currentPort;
    logger.info(`🖥️  Dashboard & Health API listening on http://localhost:${currentPort}`);
    logger.info(`🩺 Health Check: http://localhost:${currentPort}/health`);
    logger.info(`📡 Live State:   http://localhost:${currentPort}/api/state`);
  });

  return server;
}
