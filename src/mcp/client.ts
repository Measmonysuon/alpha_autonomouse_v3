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
    this.transport = new StdioClientTransport({
      command: 'decibel-mcp',
      args: [],
      env: {
        ...process.env,
        DECIBEL_NETWORK: config.DECIBEL_NETWORK,
        DECIBEL_NODE_API_KEY: config.DECIBEL_NODE_API_KEY,
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
        const entryPrice = Number(p.entry_price ?? 0);
        const leverage = Number(p.user_leverage ?? 1);
        const sizeBase = Math.abs(rawSize);
        const sizeUsd = sizeBase * entryPrice;
        const action: 'LONG' | 'SHORT' = rawSize > 0 ? 'LONG' : 'SHORT';
        const side: 'buy' | 'sell' = rawSize > 0 ? 'buy' : 'sell';

        normalized.push({
          symbol,
          side,
          action,
          entryPrice,
          sizeBase,
          sizeUsd,
          leverage,
          allocatedUsd: sizeUsd / (leverage || 1),
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
    try {
      const cachePath = path.resolve(process.cwd(), 'data', 'decibel-markets.json');
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        for (const [key, m] of Object.entries(cached as Record<string, any>)) {
          if (m?.address) {
            const detail: MarketDetail = {
              name: m.name || key,
              address: m.address,
              tickSize: Number(m.tickSize ?? 100),
              minSize: Number(m.minSize ?? 100000),
              lotSize: Number(m.lotSize ?? 10000),
              sizeDecimals: Number(m.sizeDecimals ?? 5),
              priceDecimals: Number(m.priceDecimals ?? 6),
            };
            this.marketDetails.set(key.toUpperCase(), detail);
            this.marketMap.set(m.address.toLowerCase(), m.name || key);
          }
        }
      }
    } catch (cacheErr: any) {
      logger.warn(`Could not load local market cache: ${cacheErr.message}`);
    }
  }

  async getMarketDetail(symbol: string): Promise<MarketDetail | undefined> {
    const symUpper = symbol.toUpperCase();
    if (this.marketDetails.size === 0) {
      this.loadMarketsFromCache();
    }
    if (this.marketDetails.has(symUpper)) {
      return this.marketDetails.get(symUpper);
    }
    if (this.connected) {
      try {
        const res: any = await this.getMarkets();
        const list: any[] = Array.isArray(res) ? res : (res?.markets || []);
        for (const m of list) {
          if (m?.name && m?.address) {
            const detail: MarketDetail = {
              name: m.name,
              address: m.address,
              tickSize: Number(m.tickSize ?? 100),
              minSize: Number(m.minSize ?? 100000),
              lotSize: Number(m.lotSize ?? 10000),
              sizeDecimals: Number(m.sizeDecimals ?? 5),
              priceDecimals: Number(m.priceDecimals ?? 6),
            };
            this.marketDetails.set(m.name.toUpperCase(), detail);
            this.marketMap.set(m.address.toLowerCase(), m.name);
          }
        }
      } catch (err: any) {
        logger.debug(`Could not refresh market details from MCP: ${err.message}`);
      }
    }
    return this.marketDetails.get(symUpper);
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
          const offset = params.makerOffsetPct ?? 0.0003;
          let limitPrice = markPrice > 0
            ? (useMaker
                ? (isBuy ? markPrice * (1 - offset) : markPrice * (1 + offset))
                : (isBuy ? markPrice * 1.02 : markPrice * 0.98))
            : 0;

          let chainPrice = limitPrice > 0
            ? Math.round((limitPrice * Math.pow(10, market.priceDecimals)) / market.tickSize) * market.tickSize
            : (isBuy ? 999999999999 : 1);

          let chainSize = Math.round(params.size * Math.pow(10, market.sizeDecimals));
          // Decibel on-chain contract strictly enforces ESIZE_NOT_RESPECTING_LOT_SIZE
          if (market.lotSize && market.lotSize > 0) {
            chainSize = Math.round(chainSize / market.lotSize) * market.lotSize;
          }
          if (market.minSize && chainSize < market.minSize) {
            chainSize = market.minSize;
          }
          if (chainSize <= 0) {
            chainSize = market.minSize || market.lotSize || 1;
          }

          const effectiveSize = chainSize / Math.pow(10, market.sizeDecimals);
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
        logger.warn(`Direct Aptos SDK setTpSl failed: ${err.message}. Falling back to MCP tool...`);
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

  async cancelAllOrders(symbol?: string): Promise<unknown> {
    logger.info(`🚫 Cancelling all open orders ${symbol ? `for ${symbol}` : ''}`);
    return this.call('cancel_all_orders', {
      venue: 'decibel',
      ...(symbol ? { symbol } : {}),
    });
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
        const pos = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
        const market = await this.getMarketDetail(symbol);
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

          const chainPrice = limitPrice > 0
            ? Math.round((limitPrice * Math.pow(10, market.priceDecimals)) / market.tickSize) * market.tickSize
            : (isBuy ? 999999999999 : 1);

          const targetUnits = isPartial ? pos.sizeBase * partialRatio : pos.sizeBase;
          let chainSize = Math.round(targetUnits * Math.pow(10, market.sizeDecimals));
          if (market.lotSize && market.lotSize > 0) {
            chainSize = Math.round(chainSize / market.lotSize) * market.lotSize;
          }
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
    const toolName = this.hasTool('get_trade_history') ? 'get_trade_history' : 'trade_history';
    try {
      const res = await this.call<any>(toolName, { limit });
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
        const symbol = this.marketMap.get(marketAddr) || t.symbol || (marketAddr.length > 10 ? `${marketAddr.slice(0, 6)}...${marketAddr.slice(-4)}` : 'DEX');
        const isAgent = Boolean(
          t.client_order_id &&
          (String(t.client_order_id).startsWith('agent-') ||
           String(t.client_order_id).startsWith('decibel-') ||
           String(t.client_order_id).startsWith('close-'))
        );
        return {
          ...t,
          symbol,
          isManual: !isAgent,
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
