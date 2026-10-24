/**
 * Decibel MCP Client
 * 
 * Spawns the official `decibel-mcp` process (from @decibeltrade/cli) as a
 * local stdio child process and communicates via the Model Context Protocol.
 * This matches exactly how Claude Desktop / Claude Code connects to Decibel.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Account, Ed25519PrivateKey, Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import { createAptosClient } from '../utils/node-key-resolver';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { config } from '../config';

async function httpsGetText(url: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout ${url}`)); });
  });
}

async function getBackupPrice(symbol: string): Promise<number> {
  const norm = symbol.toUpperCase().replace(/[-_/]/g, '');
  const cleanBase = norm.replace(/USD[T]?$/, '');
  try {
    const raw = await httpsGetText(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${cleanBase}USDT`, 2500);
    const data = JSON.parse(raw);
    const p = parseFloat(data?.result?.list?.[0]?.lastPrice);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {}
  try {
    const pair = norm.endsWith('USD') ? norm + 'T' : norm;
    const raw = await httpsGetText(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, 2000);
    const data = JSON.parse(raw);
    const p = parseFloat(data.price);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {}
  return 0;
}

async function get24hTicker(symbol: string, fallbackPrice: number): Promise<{ change24h: number; high24h: number; low24h: number; volume24hUsd: number }> {
  const norm = symbol.toUpperCase().replace(/[-_/]/g, '');
  const cleanBase = norm.replace(/USD[T]?$/, '');
  try {
    const raw = await httpsGetText(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${cleanBase}USDT`, 2500);
    const data = JSON.parse(raw);
    const item = data?.result?.list?.[0];
    if (item) {
      return {
        change24h: parseFloat(item.price24hPcnt) * 100 || 0,
        high24h: parseFloat(item.highPrice24h) || fallbackPrice,
        low24h: parseFloat(item.lowPrice24h) || fallbackPrice,
        volume24hUsd: parseFloat(item.turnover24h) || 0,
      };
    }
  } catch {}
  return { change24h: 0, high24h: fallbackPrice, low24h: fallbackPrice, volume24hUsd: 0 };
}

async function getBackupOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
  const norm = symbol.toUpperCase().replace(/[-_/]/g, '');
  const cleanBase = norm.replace(/USD[T]?$/, '');
  try {
    const raw = await httpsGetText(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${cleanBase}USDT&limit=${Math.min(depth, 50)}`, 2500);
    const data = JSON.parse(raw);
    const res = data?.result;
    if (res && Array.isArray(res.b) && Array.isArray(res.a)) {
      return {
        symbol,
        bids: res.b.map((b: any) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })),
        asks: res.a.map((a: any) => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })),
        timestamp: Date.now(),
      };
    }
  } catch {}
  return { symbol, bids: [], asks: [], timestamp: Date.now() };
}

export interface MarketDetail {
  name: string;
  address: string;
  tickSize: number;
  minSize: number;
  lotSize: number;
  sizeDecimals: number;
  priceDecimals: number;
  maxLeverage?: number;
  rawTickSize?: number;
  rawLotSize?: number;
  rawMinSize?: number;
}

export const AUTHORITATIVE_DECIBEL_MARKETS: Record<string, MarketDetail> = {
  'BTC/USD': {
    name: 'BTC/USD',
    address: '0x5e0e16f34adfb4b316f8d532d68acbfa206826feaaa418d3938046bdc2044861',
    tickSize: 100000,
    minSize: 2000,
    lotSize: 1000,
    sizeDecimals: 8,
    priceDecimals: 6,
  },
  'ETH/USD': {
    name: 'ETH/USD',
    address: '0x96c3c2e77041264d082d03365e9c346fbc6be9c9428a401be8e70dcb60dc60c6',
    tickSize: 100000,
    minSize: 50000,
    lotSize: 10000,
    sizeDecimals: 8,
    priceDecimals: 6,
  },
  'SOL/USD': {
    name: 'SOL/USD',
    address: '0xdf3f9b3241aaf20c47e99eac29f3ff2f736e40644c856e0db612a22e62b847f3',
    tickSize: 10000,
    minSize: 200000,
    lotSize: 10000,
    sizeDecimals: 7,
    priceDecimals: 6,
  },
  'SUI/USD': {
    name: 'SUI/USD',
    address: '0xe7da11926e61dbd227170d1271f73bfaf9f5aab7605fac1ae62541dd3810ae76',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
    maxLeverage: 5,
  },
  'APT/USD': {
    name: 'APT/USD',
    address: '0xda8615922bac85a53811e845ce39110713be6d80366f4477d5427002ac0162e3',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
  },
  'BNB/USD': {
    name: 'BNB/USD',
    address: '0xa0b805baf5e69adbb717e3daefe71f5ebaae708dd480fbb964ad324f9c5e6490',
    tickSize: 10000,
    minSize: 20000,
    lotSize: 10000,
    sizeDecimals: 7,
    priceDecimals: 6,
  },
  'XRP/USD': {
    name: 'XRP/USD',
    address: '0xd3223402bb7b156fad9a645a8c114a5e08eda8e492a38e42db1b0df1d3ba1058',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
  },
  'DOGE/USD': {
    name: 'DOGE/USD',
    address: '0xd62d10d1ef0cbe2103b5bd479691ac38222a85140fcbe7c2dc66ed23bdef58ae',
    tickSize: 10,
    minSize: 200000,
    lotSize: 10000,
    sizeDecimals: 4,
    priceDecimals: 6,
  },
  'AVAX/USD': {
    name: 'AVAX/USD',
    address: '0x696289fb9fe35b78a7803fcd67e47f8e941d192b119196af62d89a3245f7e378',
    tickSize: 1000,
    minSize: 200000,
    lotSize: 10000,
    sizeDecimals: 6,
    priceDecimals: 6,
  },
  'NEAR/USD': {
    name: 'NEAR/USD',
    address: '0xc29172db08345aceadb2306320c3239a212d55fdb6c728109a0de62864c4a02f',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
    maxLeverage: 5,
  },
  'LINK/USD': {
    name: 'LINK/USD',
    address: '0xcf99921aced56e32ddc907b9b16bf13601ac247e0090adc4cc728b6fa9e770cf',
    tickSize: 1000,
    minSize: 200000,
    lotSize: 10000,
    sizeDecimals: 6,
    priceDecimals: 6,
  },
  'ADA/USD': {
    name: 'ADA/USD',
    address: '0x386bfa4f18abc8ca926b7ade89ad5aaad34cf9a0a8bd828b7059f17b252f8607',
    tickSize: 10,
    minSize: 50000,
    lotSize: 10000,
    sizeDecimals: 4,
    priceDecimals: 6,
  },
  'DOT/USD': {
    name: 'DOT/USD',
    address: '0x2d8be07621a1f0a1ea3ef396c276329bb6d8a43f87b8d8be07f2b1d7d066eeec',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
  },
  'LTC/USD': {
    name: 'LTC/USD',
    address: '0x7e02e1c3a7eb6d953ce02b0c4ea484dc38ad26a3f9cfb404dbbe937b4b1a43a2',
    tickSize: 1000,
    minSize: 50000,
    lotSize: 10000,
    sizeDecimals: 6,
    priceDecimals: 6,
  },
  'BCH/USD': {
    name: 'BCH/USD',
    address: '0x4990d091fc057790b9b47e2ee2a4c1737bebaab0a72ad0a4bb6d790d95267129',
    tickSize: 10000,
    minSize: 20000,
    lotSize: 10000,
    sizeDecimals: 7,
    priceDecimals: 6,
  },
  'UNI/USD': {
    name: 'UNI/USD',
    address: '0xb2319084803aa71a62451368b693ca2871f3014a0f443b2cf725227318ec852c',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
  },
  'AAVE/USD': {
    name: 'AAVE/USD',
    address: '0x94821a0c326fbfe8a4b67e76550fa4bc11985c5451e9b251d5c21fbeea333a36',
    tickSize: 10000,
    minSize: 20000,
    lotSize: 10000,
    sizeDecimals: 7,
    priceDecimals: 6,
  },
  'TAO/USD': {
    name: 'TAO/USD',
    address: '0x0d3fc394d6e9e4f00aa3b8277a83d78c3b7dc53eb495ea5016e1df76db08c6bf',
    tickSize: 10000,
    minSize: 20000,
    lotSize: 10000,
    sizeDecimals: 7,
    priceDecimals: 6,
    maxLeverage: 5,
  },
  'SEI/USD': {
    name: 'SEI/USD',
    address: '0x99539327db5b8fba6b139db0808ebcae7d2350ef6567ceb8a24555b0a34b2f4c',
    tickSize: 10,
    minSize: 200000,
    lotSize: 10000,
    sizeDecimals: 4,
    priceDecimals: 6,
  },
  'TIA/USD': {
    name: 'TIA/USD',
    address: '0x9115f013444b08709cae142daec98e3b1ba3f009fbb82cb2015faae00ec8061c',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
  },
  'INJ/USD': {
    name: 'INJ/USD',
    address: '0xa7df57fbf046522fc5a87be2e30773d328406f85e495fe6fba89b9d31154c1bb',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
  },
  'RENDER/USD': {
    name: 'RENDER/USD',
    address: '0x95971a0beffafabeb6774cba02b4bb9b52a70cb355606d203f191b5853245cbb',
    tickSize: 100,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
  },
  'FET/USD': {
    name: 'FET/USD',
    address: '0x9d4a3fa626b911c75057b5610738a416bcaebaa8bc4cb62657e28b26e0b7cb8b',
    tickSize: 10,
    minSize: 100000,
    lotSize: 10000,
    sizeDecimals: 4,
    priceDecimals: 6,
  },
  'ENA/USD': {
    name: 'ENA/USD',
    address: '0x2e8f170f3f2ebcba08f86ab0d16df5baea7b420f0ee3dc20bf10e42d729a65cc',
    tickSize: 10,
    minSize: 200000,
    lotSize: 10000,
    sizeDecimals: 4,
    priceDecimals: 6,
  },
  'HYPE/USD': {
    name: 'HYPE/USD',
    address: '0x0c6b3fa01e6ee89b04fe3960d8d6377ebbe6caa8e47d87c2120dae1492044df2',
    tickSize: 1000,
    minSize: 50000,
    lotSize: 10000,
    sizeDecimals: 6,
    priceDecimals: 6,
  },
  'ZRO/USD': {
    name: 'ZRO/USD',
    address: '0xe191d266c868d52b71e0f51d87ce04bddd1238aacf8236e3967735da22074b97',
    tickSize: 100,
    minSize: 200000,
    lotSize: 10000,
    sizeDecimals: 5,
    priceDecimals: 6,
    maxLeverage: 5,
  },
  'PEPE/USD': {
    name: 'PEPE/USD',
    address: '0x53df5e9759c25ba9d16bfa09955e8841da52dc2fbbcf0bfdb32e0e5ebfba930d',
    tickSize: 1,
    minSize: 50000,
    lotSize: 10000,
    sizeDecimals: 3,
    priceDecimals: 6,
    maxLeverage: 5,
  },
  'SHIB/USD': {
    name: 'SHIB/USD',
    address: '0x7e2db1b75dfa3d5eec3a42ebba649e794fb3c5eb2ef75e9b740520bc9e47228f',
    tickSize: 1,
    minSize: 50000,
    lotSize: 10000,
    sizeDecimals: 3,
    priceDecimals: 6,
    maxLeverage: 5,
  },
  'TRX/USD': {
    name: 'TRX/USD',
    address: '0xe8b16194b75213292454fcff0b890e2f3289e40904d2edcd1b2e491464540c73',
    tickSize: 10,
    minSize: 50000,
    lotSize: 10000,
    sizeDecimals: 4,
    priceDecimals: 6,
  },
  'ZEC/USD': {
    name: 'ZEC/USD',
    address: '0xaef108ea0590464effd25054e2e1b66b6ea8be088c479da63518983e4728282b',
    tickSize: 10000,
    minSize: 50000,
    lotSize: 10000,
    sizeDecimals: 7,
    priceDecimals: 6,
  },
};

/**
 * Quantize price and size to strictly respect on-chain Decibel perp contract rules:
 * - price % tickSize === 0 (Move abort: EPRICE_NOT_RESPECTING_TICKER_SIZE 0x6)
 * - size % lotSize === 0 (Move abort: ESIZE_NOT_RESPECTING_LOT_SIZE 0x5)
 * - size >= minSize
 */
export function parseChainTickSize(m: any, priceDecimals: number, fallbackTick?: number): number {
  const raw = m?.rawTickSize ?? m?.raw_tick_size;
  if (raw && Number(raw) >= 1) return Math.round(Number(raw));
  if (typeof m?.tickSize === 'number' && m.tickSize >= 1) return Math.round(m.tickSize);
  if (typeof m?.tick_size === 'number' && m.tick_size >= 1) return Math.round(m.tick_size);
  const human = Number(m?.tickSize ?? m?.tick_size);
  if (human > 0 && human < 1) {
    return Math.max(1, Math.round(human * Math.pow(10, priceDecimals)));
  }
  return Math.max(1, Math.round(fallbackTick || 100));
}

export function parseChainLotSize(m: any, sizeDecimals: number, fallbackLot?: number): number {
  const raw = m?.rawLotSize ?? m?.raw_lot_size;
  if (raw && Number(raw) >= 1) return Math.round(Number(raw));
  if (typeof m?.lotSize === 'number' && m.lotSize >= 1) return Math.round(m.lotSize);
  if (typeof m?.lot_size === 'number' && m.lot_size >= 1) return Math.round(m.lot_size);
  const human = Number(m?.lotSize ?? m?.lot_size);
  if (human > 0 && human < 1) {
    return Math.max(1, Math.round(human * Math.pow(10, sizeDecimals)));
  }
  return Math.max(1, Math.round(fallbackLot || 10000));
}

export function parseChainMinSize(m: any, sizeDecimals: number, fallbackMin?: number, lotSize: number = 10000): number {
  const raw = m?.rawMinSize ?? m?.raw_min_size;
  if (raw && Number(raw) >= 1) return Math.round(Number(raw));
  if (typeof m?.minSize === 'number' && m.minSize >= 1) return Math.round(m.minSize);
  if (typeof m?.min_size === 'number' && m.min_size >= 1) return Math.round(m.min_size);
  const human = Number(m?.minSize ?? m?.min_size);
  if (human > 0 && human < 1) {
    return Math.max(lotSize, Math.round(human * Math.pow(10, sizeDecimals)));
  }
  return Math.max(lotSize, Math.round(fallbackMin || 100000));
}

export function quantizeOrderParameters(
  market: MarketDetail,
  rawPrice: number,
  rawSizeBase: number,
  isBuy: boolean,
): { chainPrice: number; chainSize: number; effectiveBaseSize: number } {
  const normSym = market.name.replace('-', '/').toUpperCase();
  const known = AUTHORITATIVE_DECIBEL_MARKETS[normSym];
  const priceDecimals = market.priceDecimals || known?.priceDecimals || 6;
  const sizeDecimals = market.sizeDecimals || known?.sizeDecimals || 5;
  const tickSize = parseChainTickSize(market, priceDecimals, known?.tickSize);
  const lotSize = parseChainLotSize(market, sizeDecimals, known?.lotSize);
  const minSize = parseChainMinSize(market, sizeDecimals, known?.minSize, lotSize);

  let chainPrice: number;
  if (rawPrice > 0) {
    const rawChainUnits = rawPrice * Math.pow(10, priceDecimals);
    chainPrice = Math.round(rawChainUnits / tickSize) * tickSize;
    const remPrice = chainPrice % tickSize;
    if (remPrice !== 0) {
      chainPrice = isBuy
        ? chainPrice - remPrice
        : chainPrice + (tickSize - remPrice);
    }
  } else {
    chainPrice = isBuy ? 999999999999 : 1;
    chainPrice = Math.floor(chainPrice / tickSize) * tickSize;
  }

  // Size calculation
  const rawSizeUnits = Math.round(rawSizeBase * Math.pow(10, sizeDecimals));
  let chainSize = Math.round(rawSizeUnits / lotSize) * lotSize;
  if (chainSize < minSize) {
    chainSize = minSize;
  }
  const remSize = chainSize % lotSize;
  if (remSize !== 0) {
    chainSize = Math.floor(chainSize / lotSize) * lotSize;
  }
  if (chainSize < minSize) {
    chainSize = Math.ceil(minSize / lotSize) * lotSize;
  }

  // Pre-flight assertion guards to strictly prevent gas drawdown from on-chain Move aborts
  if (chainPrice % tickSize !== 0) {
    throw new Error(
      `[PRE-FLIGHT GUARD] chainPrice (${chainPrice}) does not respect tickSize (${tickSize}) for ${market.name}. Submission aborted to save gas.`
    );
  }
  if (chainSize % lotSize !== 0) {
    throw new Error(
      `[PRE-FLIGHT GUARD] chainSize (${chainSize}) does not respect lotSize (${lotSize}) for ${market.name}. Submission aborted to save gas.`
    );
  }

  const effectiveBaseSize = chainSize / Math.pow(10, sizeDecimals);
  return { chainPrice, chainSize, effectiveBaseSize };
}

// ─── MCP Result helpers ────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text as string)
      .join('\n');
  }
  return String(content);
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Try extracting JSON from mixed text
    const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]) as T;
    throw new Error(`Cannot parse MCP response as JSON: ${raw.slice(0, 200)}`);
  }
}

// ─── Domain types ──────────────────────────────────────────────────────────────

export interface MarketPrice {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  lastPrice: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24hUsd: number;
  openInterestUsd: number;
  fundingRate: number;
  nextFundingTime: number;
}

export interface OrderBookLevel { price: number; size: number; }
export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface AccountBalance {
  // Real field names from decibel-cli JSON output
  subaccountAddress?: string;
  perpEquityBalance: number;       // total equity in USD
  crossWithdrawable: number;       // available margin
  isolatedWithdrawable: number;
  totalMargin: number;
  maintenanceMargin: number;
  unrealizedPnl: number;

  // Normalized aliases used by risk guard & dashboard
  totalEquityUsd: number;
  availableMarginUsd: number;
  unrealizedPnlUsd: number;
  marginUsedUsd: number;
}

export interface PlaceOrderResult {
  orderId: string;
  txHash: string;
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  status: string;
  timestamp: number;
}

// ─── MCP Client ───────────────────────────────────────────────────────────────

export class DecibelMCPClient {
  private client!: Client;
  private transport!: StdioClientTransport;
  private connected = false;
  private availableTools: Set<string> = new Set();
  private aptos?: Aptos;
  private aptosAccount?: Account;
  private marketDetails: Map<string, MarketDetail> = new Map();

  constructor() {
    this.initTransport();
    this.loadMarketsFromCache();

    if (config.DECIBEL_PRIVATE_KEY) {
      try {
        const cleanPk = config.DECIBEL_PRIVATE_KEY.replace(/^ed25519-priv-/, '');
        const pk = new Ed25519PrivateKey(cleanPk);
        this.aptosAccount = Account.fromPrivateKey({ privateKey: pk });
        const network = config.DECIBEL_NETWORK === 'testnet' ? Network.TESTNET : Network.MAINNET;
        this.aptos = createAptosClient(network);
      } catch (err: any) {
        logger.warn(`Direct Aptos SDK init skipped: ${err.message}`);
      }
    }
  }

  private initTransport(): void {
    const nodeKey = process.env.DECIBEL_NODE_API_KEY || config.DECIBEL_NODE_API_KEY || '';
    this.transport = new StdioClientTransport({
      command: 'decibel-mcp',
      args: [],
      env: {
        ...process.env,
        DECIBEL_NETWORK: config.DECIBEL_NETWORK,
        DECIBEL_NODE_API_KEY: nodeKey,
        DECIBEL_PRIVATE_KEY: config.DECIBEL_PRIVATE_KEY,
        DECIBEL_SUBACCOUNT_ADDRESS: config.DECIBEL_SUBACCOUNT_ADDRESS,
      },
    });

    this.client = new Client(
      { name: 'decibel-trading-agent', version: '1.0.0' },
      { capabilities: {} },
    );

    this.transport.onerror = (err) => {
      logger.warn(`Decibel MCP transport error: ${err.message}`);
      this.connected = false;
    };
    this.transport.onclose = () => {
      this.connected = false;
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      this.initTransport();
      await this.client.connect(this.transport);
      this.connected = true;

      // Discover tools registered on the server (Decibel MCP tool discovery)
      try {
        const toolsRes = await this.client.listTools();
        if (toolsRes?.tools && Array.isArray(toolsRes.tools)) {
          this.availableTools.clear();
          for (const t of toolsRes.tools) {
            this.availableTools.add(t.name);
          }
          logger.info(`✅ Connected to Decibel MCP via stdio (${this.availableTools.size} tools detected)`);
        } else {
          logger.info(`✅ Connected to Decibel MCP via stdio`);
        }
      } catch {
        logger.info(`✅ Connected to Decibel MCP via stdio`);
      }

      logger.info(`   Network:    ${config.DECIBEL_NETWORK}`);
      logger.info(`   Subaccount: ${config.DECIBEL_SUBACCOUNT_ADDRESS}`);
    } catch (err: any) {
      this.connected = false;
      throw err;
    }
  }

  isConnected(): boolean { return this.connected; }
  hasTool(name: string): boolean { return this.availableTools.has(name); }

  /** Generic MCP tool call with strict circuit-breaker timeout */
  private async call<T>(tool: string, args: Record<string, unknown> = {}, timeoutMs = 2500): Promise<T> {
    logger.debug(`MCP call: ${tool}`, args);
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP call ${tool} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const result = await Promise.race([
        this.client.callTool({ name: tool, arguments: args }),
        timeoutPromise,
      ]);
      const text = extractText(result.content);
      return parseJson<T>(text);
    } catch (err: any) {
      if (err?.message?.includes('Connection closed') || err?.code === -32000) {
        this.connected = false;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Market Data ──────────────────────────────────────────────────────────────

  /**
   * Fetch current market price, funding rate, and open interest.
   * Resiliently cascades to Binance/Bybit public feeds if Decibel MCP node is slow or returns 0.
   */
  async getPrice(symbol: string): Promise<MarketPrice> {
    let raw: any = null;
    const toolName = this.hasTool('ticker') ? 'ticker' : 'get_price';
    const toolArgs = toolName === 'ticker'
      ? { venue: 'decibel', market: symbol }
      : { symbol };

    try {
      raw = await this.call<any>(toolName, toolArgs);
    } catch (err: any) {
      logger.debug(`MCP ${toolName} call failed for ${symbol}: ${err.message}`);
    }

    let markPrice = Number(raw?.markPrice ?? raw?.lastPrice ?? raw?.oraclePrice ?? raw?.midPrice ?? 0);
    let indexPrice = Number(raw?.oraclePrice ?? raw?.indexPrice ?? markPrice);
    let lastPrice = Number(raw?.lastPrice ?? markPrice);

    // Fallback: If Decibel MCP returned 0, null, or failed, use Binance/Bybit public ticker
    if (!markPrice || !Number.isFinite(markPrice) || markPrice <= 0) {
      const backupPrice = await getBackupPrice(symbol);
      if (backupPrice > 0) {
        logger.warn(`⚠️ Decibel MCP ${toolName} unavailable or 0 for ${symbol} — using backup price feed: $${backupPrice}`);
        markPrice = backupPrice;
        if (!indexPrice || indexPrice <= 0) indexPrice = backupPrice;
        if (!lastPrice || lastPrice <= 0) lastPrice = backupPrice;
      } else {
        throw new Error(`Invalid price feed for ${symbol}: both Decibel MCP and backup price feeds returned 0`);
      }
    }

    const ticker = await get24hTicker(symbol, markPrice);

    return {
      symbol: raw?.symbol || symbol,
      markPrice,
      indexPrice,
      lastPrice,
      change24h: ticker.change24h,
      high24h: ticker.high24h > 0 ? ticker.high24h : markPrice,
      low24h: ticker.low24h > 0 ? ticker.low24h : markPrice,
      volume24hUsd: ticker.volume24hUsd,
      openInterestUsd: raw?.openInterest ? Number(raw.openInterest) * markPrice : (raw?.openInterestUsd ?? 0),
      fundingRate: raw?.fundingRateBps != null ? Number(raw.fundingRateBps) / 100 : (raw?.fundingRate ?? 0),
      nextFundingTime: raw?.nextFundingTime ?? (Date.now() + 3600000),
    };
  }

  /**
   * Fetch order book L2 snapshot with automatic fallback to Binance depth
   */
  async getOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    const toolName = this.hasTool('orderbook') ? 'orderbook' : 'get_orderbook';
    const toolArgs = toolName === 'orderbook'
      ? { venue: 'decibel', market: symbol, depth }
      : { symbol, depth };

    try {
      const ob = await this.call<OrderBook>(toolName, toolArgs);
      if (ob && Array.isArray(ob.bids) && Array.isArray(ob.asks) && (ob.bids.length > 0 || ob.asks.length > 0)) {
        return ob;
      }
    } catch (err: any) {
      logger.debug(`MCP ${toolName} failed for ${symbol}: ${err.message}`);
    }

    // Fallback to Binance public orderbook depth
    return getBackupOrderBook(symbol, depth);
  }

  async getMarkets(): Promise<unknown[]> {
    const toolName = this.hasTool('markets') ? 'markets' : 'get_markets';
    const toolArgs = toolName === 'markets' ? { venue: 'decibel' } : {};
    return this.call<unknown[]>(toolName, toolArgs);
  }

  // ── Account ──────────────────────────────────────────────────────────────────

  async getBalances(): Promise<AccountBalance> {
    const toolName = this.hasTool('balances') ? 'balances' : 'get_balances';
    const toolArgs = toolName === 'balances' ? { venue: 'decibel' } : {};
    const raw = await this.call<AccountBalance>(toolName, toolArgs, 8000);

    // Normalize real field names → aliases used by risk guard & dashboard
    raw.totalEquityUsd    = raw.perpEquityBalance    ?? raw.totalEquityUsd    ?? 0;
    raw.availableMarginUsd= raw.crossWithdrawable    ?? raw.availableMarginUsd?? 0;
    raw.unrealizedPnlUsd  = raw.unrealizedPnl        ?? raw.unrealizedPnlUsd  ?? 0;
    raw.marginUsedUsd     = (raw.totalMargin ?? 0) - (raw.crossWithdrawable ?? 0);
    return raw;
  }

  private marketMap: Map<string, string> = new Map();

  async getPositions(): Promise<any[]> {
    const toolName = this.hasTool('positions') ? 'positions' : 'get_positions';
    const toolArgs = toolName === 'positions' ? { venue: 'decibel' } : {};
    try {
      const res = await this.call<any>(toolName, toolArgs, 7500);
      const rawList = Array.isArray(res) ? res : (res?.positions || []);

      const normalized = [];
      for (const p of rawList) {
        const rawSize = Number(p.size ?? 0);
        if (rawSize === 0) continue;
        const marketAddr = String(p.market || p.market_id || '').toLowerCase();
        let symbol = this.getSymbolForMarket(marketAddr) || p.symbol;
        if (!symbol && p.market && !String(p.market).startsWith('0x')) {
          symbol = p.market;
        }
        if (!symbol) symbol = 'UNKNOWN';
        const entryPrice = Number(p.entry_price ?? p.entryPrice ?? 0);
        const sizeBase = Math.abs(rawSize);
        const sizeUsd = sizeBase * entryPrice;
        const action: 'LONG' | 'SHORT' = rawSize > 0 ? 'LONG' : 'SHORT';
        const side: 'buy' | 'sell' = rawSize > 0 ? 'buy' : 'sell';

        const rawMargin = Number(p.margin ?? p.position_margin ?? p.collateral ?? p.allocatedUsd ?? 0);
        let leverage = Number(p.leverage ?? p.user_leverage ?? p.target_leverage ?? 0);
        if (leverage <= 0 && rawMargin > 0 && sizeUsd > 0) {
          leverage = Math.round(sizeUsd / rawMargin);
        }
        if (leverage <= 0) {
          leverage = Number(p.user_leverage ?? p.leverage ?? 1);
        }
        const allocatedUsd = rawMargin > 0 ? rawMargin : (sizeUsd / (leverage || 1));

        const unrealizedPnl = p.unrealizedPnl != null ? Number(p.unrealizedPnl) : (p.unrealized_pnl != null ? Number(p.unrealized_pnl) : undefined);
        const markPrice = p.markPrice != null ? Number(p.markPrice) : (p.mark_price != null ? Number(p.mark_price) : undefined);

        normalized.push({
          symbol,
          side,
          action,
          entryPrice,
          sizeBase,
          sizeUsd,
          leverage,
          allocatedUsd,
          unrealizedPnl,
          markPrice,
          liquidationPrice: p.estimated_liquidation_price ? Number(p.estimated_liquidation_price) : undefined,
          takeProfit: p.tp_trigger_price ? Number(p.tp_trigger_price) : undefined,
          stopLoss: p.sl_trigger_price ? Number(p.sl_trigger_price) : undefined,
        });
      }
      return normalized;
    } catch (err: any) {
      logger.warn(`Failed to fetch Decibel positions: ${err.message}`);
      throw err;
    }
  }

  public getSymbolForMarket(marketAddr: string): string | null {
    if (!marketAddr) return null;
    const clean = marketAddr.toLowerCase();
    if (this.marketMap.has(clean)) return this.marketMap.get(clean)!;

    for (const [sym, detail] of Object.entries(AUTHORITATIVE_DECIBEL_MARKETS)) {
      if (detail.address && detail.address.toLowerCase() === clean) {
        this.marketMap.set(clean, detail.name || sym);
        return detail.name || sym;
      }
    }

    if (this.marketDetails.size === 0) {
      this.loadMarketsFromCache();
    }
    for (const [key, detail] of this.marketDetails.entries()) {
      if (detail.address.toLowerCase() === clean) {
        this.marketMap.set(clean, detail.name || key);
        return detail.name || key;
      }
    }
    return null;
  }

  private loadMarketsFromCache(): void {
    // 1. Seed with hardcoded authoritative constants as base
    for (const [key, detail] of Object.entries(AUTHORITATIVE_DECIBEL_MARKETS)) {
      this.marketDetails.set(key.toUpperCase(), { ...detail });
      this.marketMap.set(detail.address.toLowerCase(), detail.name || key);
    }

    try {
      const cachePath = path.resolve(process.cwd(), 'data', 'decibel-markets.json');
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        for (const [key, m] of Object.entries(cached as Record<string, any>)) {
          if (m?.address) {
            const symNorm = (m.name || key).replace('-', '/').toUpperCase();
            const fallback = AUTHORITATIVE_DECIBEL_MARKETS[symNorm];
            const priceDecimals = Number(m.priceDecimals ?? m.price_decimals ?? fallback?.priceDecimals ?? 6);
            const sizeDecimals = Number(m.sizeDecimals ?? m.size_decimals ?? fallback?.sizeDecimals ?? 5);
            const lotSize = parseChainLotSize(m, sizeDecimals, fallback?.lotSize);
            const tickSize = parseChainTickSize(m, priceDecimals, fallback?.tickSize);
            const minSize = parseChainMinSize(m, sizeDecimals, fallback?.minSize, lotSize);

            const detail: MarketDetail = {
              name: m.name || key,
              address: m.address,
              tickSize,
              minSize,
              lotSize,
              sizeDecimals,
              priceDecimals,
              maxLeverage: Number(m.maxLeverage ?? m.max_leverage ?? fallback?.maxLeverage ?? 10),
              rawTickSize: tickSize,
              rawLotSize: lotSize,
              rawMinSize: minSize,
            };
            this.marketDetails.set(symNorm, detail);
            this.marketMap.set(m.address.toLowerCase(), m.name || key);
          }
        }
      }
    } catch (cacheErr: any) {
      logger.warn(`Could not load local market cache: ${cacheErr.message}`);
    }
  }

  async getMarketDetail(symbol: string): Promise<MarketDetail | undefined> {
    const symNorm = symbol.replace('-', '/').toUpperCase();
    if (this.marketDetails.size === 0) {
      this.loadMarketsFromCache();
    }
    if (this.marketDetails.has(symNorm)) {
      return this.marketDetails.get(symNorm);
    }
    if (this.connected) {
      try {
        const res: any = await this.getMarkets();
        const list: any[] = Array.isArray(res) ? res : (res?.markets || []);
        for (const m of list) {
          if (m?.name && m?.address) {
            const mNorm = m.name.replace('-', '/').toUpperCase();
            const fallback = AUTHORITATIVE_DECIBEL_MARKETS[mNorm];
            const priceDecimals = Number(m.priceDecimals ?? m.price_decimals ?? fallback?.priceDecimals ?? 6);
            const sizeDecimals = Number(m.sizeDecimals ?? m.size_decimals ?? fallback?.sizeDecimals ?? 5);
            const lotSize = parseChainLotSize(m, sizeDecimals, fallback?.lotSize);
            const tickSize = parseChainTickSize(m, priceDecimals, fallback?.tickSize);
            const minSize = parseChainMinSize(m, sizeDecimals, fallback?.minSize, lotSize);

            const detail: MarketDetail = {
              name: m.name,
              address: m.address,
              tickSize,
              minSize,
              lotSize,
              sizeDecimals,
              priceDecimals,
              maxLeverage: Number(m.maxLeverage ?? m.max_leverage ?? fallback?.maxLeverage ?? 10),
              rawTickSize: tickSize,
              rawLotSize: lotSize,
              rawMinSize: minSize,
            };
            this.marketDetails.set(mNorm, detail);
            this.marketMap.set(m.address.toLowerCase(), m.name);
          }
        }
      } catch (err: any) {
        logger.debug(`Could not refresh market details from MCP: ${err.message}`);
      }
    }

    if (this.marketDetails.has(symNorm)) {
      return this.marketDetails.get(symNorm);
    }

    if (AUTHORITATIVE_DECIBEL_MARKETS[symNorm]) {
      const auth = { ...AUTHORITATIVE_DECIBEL_MARKETS[symNorm] };
      this.marketDetails.set(symNorm, auth);
      return auth;
    }

    return undefined;
  }

  // ── Orders ───────────────────────────────────────────────────────────────────

  /**
   * Place a market order.
   * Executes directly on-chain via Aptos SDK to bypass sequence number bugs in CLI,
   * falling back to MCP if SDK is unavailable.
   */
  async placeMarketOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    size: number;
    preferMaker?: boolean;
    makerOffsetPct?: number;
  }): Promise<PlaceOrderResult> {
    const useMaker = params.preferMaker ?? true;
    logger.info(`📤 Order ${params.side.toUpperCase()} ${params.size} ${params.symbol} [Routing: ${useMaker ? 'MAKER_POST_ONLY_PREFERRED' : 'TAKER_IOC'}]`);
    const clientOrderId = `decibel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Try direct on-chain Aptos SDK execution first
    if (this.aptos && this.aptosAccount && config.DECIBEL_SUBACCOUNT_ADDRESS) {
      try {
        const market = await this.getMarketDetail(params.symbol);
        if (market) {
          let markPrice = 0;
          try {
            const p = await this.getPrice(params.symbol);
            markPrice = p.markPrice || p.lastPrice || 0;
          } catch {
            // fallback
          }

          const isBuy = params.side === 'buy';
          const offset = params.makerOffsetPct ?? 0.0018;
          let limitPrice = markPrice > 0
            ? (useMaker
                ? (isBuy ? markPrice * (1 - offset) : markPrice * (1 + offset))
                : (isBuy ? markPrice * 1.02 : markPrice * 0.98))
            : 0;

          const { chainPrice, chainSize, effectiveBaseSize: effectiveSize } = quantizeOrderParameters(
            market,
            limitPrice,
            params.size,
            isBuy,
          );
          const tif = useMaker ? 1 : 2; // TimeInForce: 1 = PostOnly (Maker), 2 = ImmediateOrCancel (IOC)

          logger.info(`⚡ Executing on-chain order via Aptos SDK: ${params.symbol} ${params.side.toUpperCase()} size=${chainSize} (${effectiveSize} units) price=${chainPrice} TIF=${tif === 1 ? 'POST_ONLY_MAKER' : 'IOC_TAKER'}`);

          const tx = await this.aptos.transaction.build.simple({
            sender: this.aptosAccount.accountAddress,
            data: {
              function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::place_order_to_subaccount',
              typeArguments: [],
              functionArguments: [
                config.DECIBEL_SUBACCOUNT_ADDRESS,
                market.address,
                chainPrice,
                chainSize,
                isBuy,
                tif,
                false, // reduce only
                clientOrderId,
                null, null, null, null, null,
                null,
                null,
              ],
            },
          });

          const senderAuth = this.aptos.transaction.sign({
            signer: this.aptosAccount,
            transaction: tx,
          });

          const committed = await this.aptos.transaction.submit.simple({
            transaction: tx,
            senderAuthenticator: senderAuth,
          });

          const executed = await this.aptos.waitForTransaction({
            transactionHash: committed.hash,
          });

          if (!executed.success) {
            throw new Error(`On-chain transaction failed: ${executed.vm_status}`);
          }

          logger.info(`✅ On-chain order filled! Tx: ${committed.hash} (gas: ${executed.gas_used})`);

          return {
            orderId: clientOrderId,
            txHash: committed.hash,
            symbol: params.symbol,
            side: params.side,
            size: effectiveSize,
            entryPrice: markPrice || 0,
            status: 'FILLED',
            timestamp: Date.now(),
          };
        }
      } catch (err: any) {
        logger.warn(`Direct Aptos SDK order failed: ${err.message}. Falling back to MCP tool...`);
      }
    }

    // Fallback to MCP tools
    let res: any;
    if (this.hasTool('place_order')) {
      res = await this.call<any>('place_order', {
        venue: 'decibel',
        market: params.symbol,
        side: params.side,
        size: String(params.size),
        tif: 'ioc',
        clientOrderId,
      }, 12000);
    } else {
      res = await this.call<any>('place_market_order', {
        symbol: params.symbol,
        side: params.side,
        size: params.size,
        clientOrderId,
        slippage: 1,
      }, 12000);
    }

    if (res?.success === false || res?.error) {
      throw new Error(res?.error || 'Order rejected by Decibel DEX');
    }

    const txHash = res?.txHash || res?.hash || '';
    if (!txHash) {
      logger.warn(`⚠️ Decibel place_market_order returned without a txHash: ${JSON.stringify(res)}`);
    }

    return {
      orderId: res?.orderId || res?.id || res?.hash || clientOrderId,
      txHash,
      symbol: params.symbol,
      side: res?.side || params.side,
      size: Number(res?.size ?? params.size),
      entryPrice: Number(res?.entryPrice ?? res?.price ?? 0),
      status: res?.status || 'FILLED',
      timestamp: res?.timestamp || Date.now(),
    };
  }

  /**
   * Set TP and SL for an open position.
   * Correctly populates tpTriggerPrice / slTriggerPrice / limit prices according to schema.
   */
  async setTpSl(params: {
    symbol: string;
    side?: 'buy' | 'sell';
    tpTrigger?: number;
    slTrigger?: number;
    tpSize?: number;
    slSize?: number;
  }): Promise<unknown> {
    logger.info(`🎯 Setting TP/SL for ${params.symbol} — TP: ${params.tpTrigger} | SL: ${params.slTrigger}`);

    // Try direct on-chain execution first
    if (this.aptos && this.aptosAccount && config.DECIBEL_SUBACCOUNT_ADDRESS) {
      for (let sdkAttempt = 1; sdkAttempt <= 3; sdkAttempt++) {
        try {
          const market = await this.getMarketDetail(params.symbol);
          if (market) {
            const toChainPrice = (price?: number) => {
              if (!price || price <= 0) return undefined;
              return Math.round((price * Math.pow(10, market.priceDecimals)) / market.tickSize) * market.tickSize;
            };
            const toChainSize = (size?: number) => {
              if (!size || size <= 0) return undefined;
              let sz = Math.round(size * Math.pow(10, market.sizeDecimals));
              if (market.lotSize && market.lotSize > 0) {
                sz = Math.round(sz / market.lotSize) * market.lotSize;
              }
              return sz;
            };

            const roundedTpTrigger = toChainPrice(params.tpTrigger);
            const roundedTpLimit = toChainPrice(params.tpTrigger);
            const roundedSlTrigger = toChainPrice(params.slTrigger);
            const roundedSlLimit = toChainPrice(params.slTrigger);
            const chainTpSize = toChainSize(params.tpSize);
            const chainSlSize = toChainSize(params.slSize);

            const tx = await this.aptos.transaction.build.simple({
              sender: this.aptosAccount.accountAddress,
              data: {
                function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::place_tp_sl_order_for_position',
                typeArguments: [],
                functionArguments: [
                  config.DECIBEL_SUBACCOUNT_ADDRESS,
                  market.address,
                  roundedTpTrigger,
                  roundedTpLimit,
                  chainTpSize,
                  roundedSlTrigger,
                  roundedSlLimit,
                  chainSlSize,
                  undefined,
                  undefined,
                ],
              },
            });

            const senderAuth = this.aptos.transaction.sign({
              signer: this.aptosAccount,
              transaction: tx,
            });

            const committed = await this.aptos.transaction.submit.simple({
              transaction: tx,
              senderAuthenticator: senderAuth,
            });

            const executed = await this.aptos.waitForTransaction({
              transactionHash: committed.hash,
            });

            if (!executed.success) {
              throw new Error(`On-chain TP/SL failed: ${executed.vm_status}`);
            }

            logger.info(`✅ On-chain TP/SL set! Tx: ${committed.hash} (gas: ${executed.gas_used})`);
            return { success: true, txHash: committed.hash };
          }
        } catch (err: any) {
          const isNoPos = err.message?.includes('ENO_POSITION_FOR_TP_SL') || err.message?.includes('0xc');
          if (isNoPos && sdkAttempt < 3) {
            logger.warn(`⏳ [ON-CHAIN TP/SL] Position settlement pending on Decibel DEX (attempt ${sdkAttempt}/3: ENO_POSITION_FOR_TP_SL). Retrying in 1.8s...`);
            await new Promise((r) => setTimeout(r, 1800));
            continue;
          }
          logger.warn(`Direct Aptos SDK setTpSl failed (attempt ${sdkAttempt}/3): ${err.message}. ${sdkAttempt === 3 ? 'Falling back to MCP tool...' : ''}`);
          if (sdkAttempt < 3) {
            await new Promise((r) => setTimeout(r, 1200));
          }
        }
      }
    }

    if (this.hasTool('attach_tpsl')) {
      return this.call('attach_tpsl', {
        venue: 'decibel',
        market: params.symbol,
        tpTriggerPrice: params.tpTrigger ? String(params.tpTrigger) : undefined,
        slTriggerPrice: params.slTrigger ? String(params.slTrigger) : undefined,
      }, 12000);
    }

    return this.call('place_tp_sl', {
      symbol: params.symbol,
      tpTriggerPrice: params.tpTrigger,
      tpLimitPrice: params.tpTrigger,
      tpSize: params.tpSize,
      slTriggerPrice: params.slTrigger,
      slLimitPrice: params.slTrigger,
      slSize: params.slSize,
      // Snake_case aliases for legacy versions
      tp_trigger: params.tpTrigger,
      sl_trigger: params.slTrigger,
    }, 12000);
  }

  async setLeverage(symbol: string, leverage: number, marginType: 'cross' | 'isolated' = 'cross'): Promise<unknown> {
    const isCross = marginType === 'cross';
    const levInt = Math.max(1, Math.min(100, Math.round(leverage)));
    logger.info(`⚙️ Configuring on-chain leverage for ${symbol}: ${levInt}x (${marginType})`);

    // 1. Direct on-chain Aptos SDK execution (bypasses decibel-mcp subaccount 0-APT gas fee bug)
    if (this.aptos && this.aptosAccount && config.DECIBEL_SUBACCOUNT_ADDRESS) {
      try {
        const market = await this.getMarketDetail(symbol);
        if (market) {
          logger.info(`⚡ Executing configure_user_settings_for_market via Aptos SDK: ${symbol} (${market.address}) lev=${levInt}x isCross=${isCross}`);
          const tx = await this.aptos.transaction.build.simple({
            sender: this.aptosAccount.accountAddress,
            data: {
              function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::configure_user_settings_for_market',
              typeArguments: [],
              functionArguments: [
                config.DECIBEL_SUBACCOUNT_ADDRESS,
                market.address,
                isCross,
                levInt,
              ],
            },
          });

          const senderAuth = this.aptos.transaction.sign({
            signer: this.aptosAccount,
            transaction: tx,
          });

          const committed = await this.aptos.transaction.submit.simple({
            transaction: tx,
            senderAuthenticator: senderAuth,
          });

          const executed = await this.aptos.waitForTransaction({
            transactionHash: committed.hash,
          });

          if (!executed.success) {
            throw new Error(`On-chain set_leverage failed: ${executed.vm_status}`);
          }

          logger.info(`✅ On-chain leverage configured to ${levInt}x for ${symbol}! Tx: ${committed.hash} (gas: ${executed.gas_used})`);
          return {
            success: true,
            txHash: committed.hash,
            symbol,
            leverage: levInt,
          };
        }
      } catch (err: any) {
        logger.warn(`Direct Aptos SDK set_leverage failed: ${err.message}. Falling back to MCP tool...`);
      }
    }

    const res = await this.call<any>('set_leverage', { symbol, leverage: levInt, marginType });
    if (res?.error) {
      throw new Error(res.error);
    }
    return res;
  }

  async getOrders(symbol?: string): Promise<any[]> {
    const toolName = this.hasTool('get_orders') ? 'get_orders' : 'orders';
    try {
      // decibel-mcp get_orders tool takes no parameters ({})
      const res = await this.call<any>(toolName, {}, 7500);
      const rawItems = res?.orders?.items || (Array.isArray(res) ? res : (res?.orders || []));
      const items = Array.isArray(rawItems) ? rawItems : [];

      const normalized = items.map((o: any) => {
        const resolvedSym = this.getSymbolForMarket(o.market);
        const sym = resolvedSym || o.symbol || o.market;
        return {
          ...o,
          symbol: sym,
          marketAddress: o.market,
          clientOrderId: o.client_order_id || o.clientOrderId,
          orderId: o.order_id || o.orderId,
          price: typeof o.price === 'number' ? o.price : parseFloat(o.price || '0'),
          size: typeof o.orig_size === 'number' ? o.orig_size : parseFloat(o.orig_size || o.size || '0'),
          remainingSize: typeof o.remaining_size === 'number' ? o.remaining_size : parseFloat(o.remaining_size || '0'),
          isBuy: Boolean(o.is_buy),
        };
      });

      if (!symbol) return normalized;

      const symKey = symbol.replace('-', '/').toUpperCase();
      const baseCoin = symKey.split('/')[0];
      return normalized.filter((o: any) => {
        const oSym = (o.symbol || '').replace('-', '/').toUpperCase();
        return oSym === symKey || oSym.includes(baseCoin);
      });
    } catch (err: any) {
      logger.debug(`MCP get_orders notice for ${symbol || 'all'}: ${err.message}`);
      return [];
    }
  }

  async cancelClientOrder(symbol: string, clientOrderId: string): Promise<unknown> {
    logger.info(`🚫 Cancelling resting order ${clientOrderId} for ${symbol}`);
    if (this.aptos && this.aptosAccount && config.DECIBEL_SUBACCOUNT_ADDRESS) {
      try {
        const market = await this.getMarketDetail(symbol);
        if (market) {
          logger.info(`⚡ Executing cancel_client_order_to_subaccount on-chain: ${clientOrderId} (${symbol})...`);
          const tx = await this.aptos.transaction.build.simple({
            sender: this.aptosAccount.accountAddress,
            data: {
              function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::cancel_client_order_to_subaccount',
              typeArguments: [],
              functionArguments: [
                config.DECIBEL_SUBACCOUNT_ADDRESS,
                clientOrderId,
                market.address,
              ],
            },
          });
          const senderAuth = this.aptos.transaction.sign({
            signer: this.aptosAccount,
            transaction: tx,
          });
          const committed = await this.aptos.transaction.submit.simple({
            transaction: tx,
            senderAuthenticator: senderAuth,
          });
          const executed = await this.aptos.waitForTransaction({
            transactionHash: committed.hash,
          });
          if (executed.success) {
            logger.info(`✅ Successfully cancelled resting order ${clientOrderId} on-chain! Tx: ${committed.hash}`);
            return { success: true, txHash: committed.hash };
          }
        }
      } catch (err: any) {
        logger.warn(`Direct cancel_client_order failed: ${err.message}. Falling back to cancelAllOrders...`);
      }
    }
    return this.cancelAllOrders(symbol);
  }

  async cancelAllOrders(symbol?: string): Promise<unknown> {
    logger.info(`🚫 Cancelling all open orders ${symbol ? `for ${symbol}` : ''}`);

    // 1. Retrieve individual open orders and cancel each via direct on-chain cancel_client_order_to_subaccount
    let sweptCount = 0;
    try {
      const orders = await this.getOrders(symbol);
      if (orders.length > 0) {
        logger.info(`🧹 Found ${orders.length} resting order(s) on Decibel DEX to sweep${symbol ? ` for ${symbol}` : ''}...`);
        for (const ord of orders) {
          const ordSym = ord.symbol || symbol;
          const cid = ord.clientOrderId || ord.client_order_id;
          if (ordSym && cid) {
            await this.cancelClientOrder(ordSym, cid).catch((e: any) => {
              logger.debug(`Failed to cancel specific order ${cid}: ${e.message}`);
            });
            sweptCount++;
          }
        }
      }
    } catch (sweepErr: any) {
      logger.debug(`Individual order sweep notice: ${sweepErr.message}`);
    }

    // If resting individual orders were already cleanly swept, avoid firing failing bulk cancel transaction
    if (sweptCount > 0) {
      return { success: true, count: sweptCount };
    }

    // 2. Direct on-chain bulk cancel via Aptos SDK (for orders placed via place_bulk_orders)
    if (this.aptos && this.aptosAccount && config.DECIBEL_SUBACCOUNT_ADDRESS && symbol) {
      try {
        const market = await this.getMarketDetail(symbol);
        if (market) {
          logger.info(`⚡ Executing cancel_bulk_order_to_subaccount on-chain: ${symbol} (${market.address})...`);
          const tx = await this.aptos.transaction.build.simple({
            sender: this.aptosAccount.accountAddress,
            data: {
              function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::cancel_bulk_order_to_subaccount',
              typeArguments: [],
              functionArguments: [
                config.DECIBEL_SUBACCOUNT_ADDRESS,
                market.address,
              ],
            },
          });
          const senderAuth = this.aptos.transaction.sign({
            signer: this.aptosAccount,
            transaction: tx,
          });
          const committed = await this.aptos.transaction.submit.simple({
            transaction: tx,
            senderAuthenticator: senderAuth,
          });
          const executed = await this.aptos.waitForTransaction({
            transactionHash: committed.hash,
          });
          if (executed.success) {
            logger.info(`✅ Successfully cancelled all resting orders on-chain for ${symbol}! Tx: ${committed.hash}`);
            return { success: true, txHash: committed.hash };
          }
        }
      } catch (err: any) {
        logger.debug(`Direct Aptos SDK cancel_bulk_order notice: ${err.message}`);
      }
    }

    // 3. Fallback to MCP tool with appropriate timeout & subaccount parameter
    return this.call('cancel_all_orders', {}, 12000).catch(() => ({}));
  }

  async closePosition(symbol: string, partialRatio = 1.0): Promise<unknown> {
    const isPartial = partialRatio > 0 && partialRatio < 1.0;
    logger.info(`🔒 Closing position: ${symbol}${isPartial ? ` (${Math.round(partialRatio * 100)}% partial scale-out)` : ''}`);

    if (this.aptos && this.aptosAccount && config.DECIBEL_SUBACCOUNT_ADDRESS) {
      const subaccount = (config.DECIBEL_SUBACCOUNT_ADDRESS || '').trim();
      const signer = this.aptosAccount.accountAddress.toString().toLowerCase();
      if (subaccount.toLowerCase() === signer) {
        logger.warn(`CRITICAL GUARD: Decibel subaccount (${subaccount}) is identical to gas signer address (${signer}). Skipping on-chain close.`);
        return { error: 'Invalid subaccount matches gas signer' };
      }
      try {
        const positions = await this.getPositions();
        const normSym = (s: string) => (s || '').replace(/[-/]/g, '').toUpperCase();
        const pos = positions.find((p) => normSym(p.symbol) === normSym(symbol));
        const market = await this.getMarketDetail(pos?.symbol || symbol);
        if (pos && market) {
          const isBuy = pos.action === 'SHORT';
          let markPrice = pos.entryPrice || 0;
          try {
            const p = await this.getPrice(symbol);
            markPrice = p.markPrice || markPrice;
          } catch {
            // fallback
          }

          const limitPrice = markPrice > 0
            ? (isBuy ? markPrice * 1.05 : markPrice * 0.95)
            : 0;

          const targetUnits = isPartial ? pos.sizeBase * partialRatio : pos.sizeBase;
          const { chainPrice, chainSize } = quantizeOrderParameters(
            market,
            limitPrice,
            targetUnits,
            isBuy,
          );
          const clientOrderId = `close-${Date.now()}`;

          logger.info(`⚡ Executing on-chain close via Aptos SDK: ${symbol} isBuy=${isBuy} size=${chainSize}${isPartial ? ` (${Math.round(partialRatio * 100)}% partial)` : ''}`);

          const tx = await this.aptos.transaction.build.simple({
            sender: this.aptosAccount.accountAddress,
            data: {
              function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::place_order_to_subaccount',
              typeArguments: [],
              functionArguments: [
                config.DECIBEL_SUBACCOUNT_ADDRESS,
                market.address,
                chainPrice,
                chainSize,
                isBuy,
                2, // IOC
                true, // isReduceOnly = true
                clientOrderId,
                null, null, null, null, null,
                null,
                null,
              ],
            },
          });

          const senderAuth = this.aptos.transaction.sign({
            signer: this.aptosAccount,
            transaction: tx,
          });

          const committed = await this.aptos.transaction.submit.simple({
            transaction: tx,
            senderAuthenticator: senderAuth,
          });

          const executed = await this.aptos.waitForTransaction({
            transactionHash: committed.hash,
          });

          logger.info(`✅ On-chain position closed! Tx: ${committed.hash} (gas: ${executed.gas_used})`);
          return { success: true, txHash: committed.hash };
        }
      } catch (err: any) {
        logger.warn(`Direct Aptos SDK close failed: ${err.message}. Falling back to MCP tool...`);
      }
    }

    return this.call('close_position', {
      symbol,
      market: symbol,
      venue: 'decibel',
      slippage: 1,
    }, 12000);
  }

  async getFundingHistory(symbol: string): Promise<unknown[]> {
    return this.call<unknown[]>('get_funding_history', { symbol });
  }

  async getTradeHistory(limit = 50): Promise<any[]> {
    if (!this.connected) {
      await this.connect().catch((e) => logger.debug(`MCP auto-connect in getTradeHistory: ${e.message}`));
    }
    const toolName = this.hasTool('get_trade_history') ? 'get_trade_history' : (this.hasTool('trade_history') ? 'trade_history' : 'get_trade_history');
    try {
      const toolArgs: any = { limit };
      if (config.DECIBEL_SUBACCOUNT_ADDRESS) {
        toolArgs.subaccount = config.DECIBEL_SUBACCOUNT_ADDRESS;
      }
      const res = await this.call<any>(toolName, toolArgs, 15000);
      const rawTrades = Array.isArray(res) ? res : (res?.trades || []);

      if (this.marketMap.size === 0) {
        try {
          const mRes = (await this.getMarkets()) as any;
          const markets = Array.isArray(mRes) ? mRes : (mRes?.markets || []);
          for (const m of markets) {
            if (m?.address && m?.name) {
              this.marketMap.set(m.address.toLowerCase(), m.name);
            }
          }
        } catch {}
      }

      return rawTrades.map((t: any) => {
        const marketAddr = (t.market || '').toLowerCase();
        const symbol = this.getSymbolForMarket(marketAddr) || this.marketMap.get(marketAddr) || t.symbol || (marketAddr.length > 10 ? `${marketAddr.slice(0, 6)}...${marketAddr.slice(-4)}` : 'DEX');
        const isExplicitManual = Boolean(
          t.client_order_id && String(t.client_order_id).startsWith('manual-user-override')
        );
        const isAgent = !isExplicitManual;
        return {
          ...t,
          symbol,
          isManual: isExplicitManual,
          tradeType: isAgent ? 'AUTO' : 'MANUAL',
          timestamp: t.transaction_unix_ms || Date.now(),
        };
      });
    } catch (err: any) {
      logger.warn(`Failed to fetch on-chain trade history from MCP: ${err.message}`);
      return [];
    }
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.connected = false;
    logger.info('Decibel MCP client disconnected');
  }
}

// Singleton
export const mcpClient = new DecibelMCPClient();
