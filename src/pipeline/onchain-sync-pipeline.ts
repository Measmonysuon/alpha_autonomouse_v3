/**
 * Centralized On-Chain Sync Pipeline Service
 * 
 * Sinks and consolidates all Decibel DEX on-chain data in one single, coordinated pipeline:
 *  - Subaccount USD collateral & withdrawable margin (direct smart contract view)
 *  - Ed25519 signer APT fuel balance (gas reserve)
 *  - On-chain positions (Decibel MCP / contract state)
 *  - Resting limit orders (CLOB)
 *  - On-chain trade fills (Decibel trade history)
 * 
 * Reconciles the trading journal and wallet equity:
 *  - Total Money (Account Equity) = On-Chain Subaccount Collateral + Net Unrealized PnL
 *  - Available Margin = Total Money - Sum(Allocated Margin)
 *  - Unrecognized on-chain positions/trades without an internal bot client order ID
 *    are automatically classified as "human trade DEX" (isManual = true)
 * 
 * Serves in-memory cached responses to UI endpoints (/api/state, /api/positions, /api/trades)
 * with 0ms latency, eliminating HTTP/1.1 socket exhaustion and RPC drift.
 */

import { Aptos, Network } from '@aptos-labs/ts-sdk';
import { createAptosClient } from '../utils/node-key-resolver';
import { config, isClientConfigured, getDerivedSignerAddress } from '../config';
import { logger } from '../utils/logger';
import { mcpClient } from '../mcp/client';
import { tradeExecutor, TradeRecord } from '../trades/executor';
import { dbClient } from '../db/database';

export interface ConsolidatedOnChainState {
  timestamp: number;
  isConfigured: boolean;
  subaccount: string;
  signerAddress: string;
  network: string;
  // Balances
  totalCollateralUsd: number;
  unrealizedPnlUsd: number;
  accountEquityUsd: number;
  allocatedMarginUsd: number;
  availableMarginUsd: number;
  gasAptBalance: number;
  // Position & Order counts
  openPositionsCount: number;
  autoPositionsCount: number;
  humanPositionsCount: number;
  openPositions: TradeRecord[];
  restingOrders: any[];
  // Health
  lastSyncDurationMs: number;
  lastSuccessfulSync: number;
  isSyncing: boolean;
  lastError?: string;
}

class OnChainSyncPipelineService {
  private syncTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private isSyncing: boolean = false;
  private inFlightSyncPromise: Promise<ConsolidatedOnChainState> | null = null;
  private aptos: Aptos | null = null;
  private readonly DEFAULT_SYNC_INTERVAL_MS = 2_000; // 2 seconds high-frequency on-chain reconciliation

  // Consolidated in-memory snapshot
  private state: ConsolidatedOnChainState = {
    timestamp: 0,
    isConfigured: false,
    subaccount: '',
    signerAddress: '',
    network: config.NETWORK || 'mainnet',
    totalCollateralUsd: 0,
    unrealizedPnlUsd: 0,
    accountEquityUsd: 0,
    allocatedMarginUsd: 0,
    availableMarginUsd: 0,
    gasAptBalance: 0,
    openPositionsCount: 0,
    autoPositionsCount: 0,
    humanPositionsCount: 0,
    openPositions: [],
    restingOrders: [],
    lastSyncDurationMs: 0,
    lastSuccessfulSync: 0,
    isSyncing: false,
  };

  constructor() {
    this.initAptos();
  }

  private initAptos(): void {
    try {
      const net = config.NETWORK === 'testnet' ? Network.TESTNET : Network.MAINNET;
      this.aptos = createAptosClient(net);
    } catch (e: any) {
      logger.debug(`[ONCHAIN PIPELINE] Aptos client init: ${e.message}`);
    }
  }

  /**
   * Start the coordinated sync loop
   */
  public start(intervalMs = this.DEFAULT_SYNC_INTERVAL_MS): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`⚡ [ONCHAIN PIPELINE] Starting centralized on-chain synchronization pipeline (polling every ${intervalMs / 1000}s)...`);

    // Run first cycle immediately
    this.syncNow().catch((err) => {
      logger.debug(`[ONCHAIN PIPELINE] Initial sync notice: ${err.message}`);
    });

    this.syncTimer = setInterval(() => {
      if (!this.isRunning) return;
      this.syncNow().catch((err) => {
        logger.debug(`[ONCHAIN PIPELINE] Periodic sync notice: ${err.message}`);
      });
    }, intervalMs);
  }

  /**
   * Stop the pipeline
   */
  public stop(): void {
    this.isRunning = false;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    logger.info('🛑 [ONCHAIN PIPELINE] Stopped on-chain sync pipeline.');
  }

  /**
   * Get the current cached consolidated snapshot (0ms latency)
   */
  public getConsolidatedState(): ConsolidatedOnChainState {
    return { ...this.state };
  }

  /**
   * Get open positions from cache
   */
  public getPositions(): TradeRecord[] {
    return this.state.openPositions;
  }

  /**
   * Immediately evict a position when closed (eliminates stale position ghosting)
   */
  public evictPosition(symbol?: string): void {
    if (!symbol) {
      this.state.openPositions = [];
      this.state.openPositionsCount = 0;
      this.state.autoPositionsCount = 0;
      this.state.humanPositionsCount = 0;
      return;
    }
    const symNorm = symbol.replace('-', '/').toUpperCase();
    this.state.openPositions = (this.state.openPositions || []).filter(
      p => p.symbol.replace('-', '/').toUpperCase() !== symNorm
    );
    this.state.openPositionsCount = this.state.openPositions.length;
  }

  /**
   * Get resting orders from cache
   */
  public getOrders(): any[] {
    return this.state.restingOrders;
  }

  /**
   * Force an immediate sync (de-duplicated across concurrent callers)
   */
  public async syncNow(): Promise<ConsolidatedOnChainState> {
    if (this.inFlightSyncPromise) {
      return this.inFlightSyncPromise;
    }

    this.inFlightSyncPromise = this.executeSyncCycle().finally(() => {
      this.inFlightSyncPromise = null;
    });

    return this.inFlightSyncPromise;
  }

  /**
   * Internal execution cycle
   */
  private async executeSyncCycle(): Promise<ConsolidatedOnChainState> {
    const startTime = Date.now();
    this.isSyncing = true;
    this.state.isSyncing = true;

    const configured = isClientConfigured();
    const subaccount = (config.DECIBEL_SUBACCOUNT_ADDRESS && !config.DECIBEL_SUBACCOUNT_ADDRESS.includes('your_'))
      ? config.DECIBEL_SUBACCOUNT_ADDRESS
      : '';
    const signerAddress = tradeExecutor.getSignerAddress() || getDerivedSignerAddress() || '';

    this.state.isConfigured = configured;
    this.state.subaccount = subaccount;
    this.state.signerAddress = signerAddress;
    this.state.network = config.NETWORK;

    if (!configured || !subaccount) {
      this.state.isSyncing = false;
      this.state.timestamp = Date.now();
      return this.state;
    }

    try {
      // 1. Fetch on-chain balances: Collateral, withdrawable margin, and APT fuel in parallel
      const balancePromise = this.fetchOnChainBalances(subaccount, signerAddress);

      // 2. Fetch positions and resting orders via MCP / contract
      const positionsPromise = tradeExecutor.syncOnChainPositions().catch(() => tradeExecutor.getOpenTrades());
      const ordersPromise = mcpClient.getOrders().catch(() => tradeExecutor.getRestingOrders());

      // 3. Fetch trade history fills to reconcile journal
      const tradeHistoryPromise = mcpClient.getTradeHistory(50).catch(() => []);

      const [balances, positions, orders, tradeHistory] = await Promise.all([
        balancePromise,
        positionsPromise,
        ordersPromise,
        tradeHistoryPromise,
      ]);

      // 4. Ingest and reconcile trade fills into SQLite
      if (Array.isArray(tradeHistory) && tradeHistory.length > 0) {
        try {
          dbClient.syncOnChainTrades(tradeHistory);
        } catch (dbErr: any) {
          logger.debug(`[ONCHAIN PIPELINE] Database sync error: ${dbErr.message}`);
        }
      }

      // 5. Categorize open positions into Auto AI vs human trade DEX
      const validPositions: TradeRecord[] = Array.isArray(positions) ? positions : [];
      let autoCount = 0;
      let humanCount = 0;
      let sumUnrealizedPnl = 0;
      let sumAllocatedMargin = 0;

      const openSymbols = new Set(validPositions.map(p => (p.symbol || '').replace('-', '/').toUpperCase()));

      for (const p of validPositions) {
        const isHuman = Boolean(p.isManual === true || p.strategyName === 'human trade DEX');
        if (isHuman) humanCount++;
        else autoCount++;

        const uPnl = p.unrealizedPnlUsd !== undefined ? p.unrealizedPnlUsd : (p.pnlUsd || 0);
        sumUnrealizedPnl += uPnl;
        sumAllocatedMargin += (p.allocatedUsd || 0);
      }

      // 5b. Strictly isolate genuine Resting Limit Orders from Stop/TP/SL trigger orders
      const rawOrders = Array.isArray(orders) ? orders : [];
      const genuineRestingOrders = rawOrders.filter((o: any) => {
        const oSym = (o.symbol || o.market || '').replace('-', '/').toUpperCase();
        // If an open position already exists for this symbol, protective trigger orders are attached to the position
        if (openSymbols.has(oSym)) return false;
        if (o.isRestingLimit) return true;
        const isTrigger = Boolean(o.is_tpsl || o.is_reduce_only || o.order_type === 'Stop Market' || o.order_type === 'Stop Limit');
        const hasValidPrice = typeof o.price === 'number' ? o.price > 0 : parseFloat(o.price || '0') > 0;
        return !isTrigger && hasValidPrice;
      });
      tradeExecutor.setRestingOrders(genuineRestingOrders);

      // 6. Strict Mathematical Reconciliation:
      // Total Money (Account Equity) = Verified Subaccount Collateral + Net Unrealized PnL
      const collateral = balances.totalCollateralUsd > 0
        ? balances.totalCollateralUsd
        : (this.state.totalCollateralUsd || 0);

      const netEquity = Math.max(0, Number((collateral + sumUnrealizedPnl).toFixed(2)));
      const availableMargin = Math.max(0, Number((netEquity - sumAllocatedMargin).toFixed(2)));
      const aptGas = balances.gasAptBalance > 0
        ? balances.gasAptBalance
        : (this.state.gasAptBalance || 0);

      // 7. Update consolidated state snapshot
      this.state = {
        timestamp: Date.now(),
        isConfigured: true,
        subaccount: (balances as any).activeSubaccount || subaccount,
        signerAddress,
        network: config.NETWORK,
        totalCollateralUsd: collateral,
        unrealizedPnlUsd: Number(sumUnrealizedPnl.toFixed(4)),
        accountEquityUsd: netEquity,
        allocatedMarginUsd: Number(sumAllocatedMargin.toFixed(2)),
        availableMarginUsd: availableMargin,
        gasAptBalance: aptGas,
        openPositionsCount: validPositions.length,
        autoPositionsCount: autoCount,
        humanPositionsCount: humanCount,
        openPositions: validPositions,
        restingOrders: genuineRestingOrders,
        lastSyncDurationMs: Date.now() - startTime,
        lastSuccessfulSync: Date.now(),
        isSyncing: false,
        lastError: undefined,
      };

      return this.state;
    } catch (err: any) {
      this.state.lastError = err.message;
      this.state.isSyncing = false;
      this.state.lastSyncDurationMs = Date.now() - startTime;
      logger.debug(`[ONCHAIN PIPELINE] Sync cycle error: ${err.message}`);
      return this.state;
    }
  }

  /**
   * Direct on-chain query for subaccount collateral and signer APT gas balance
   */
  private async fetchOnChainBalances(
    subaccount: string,
    signerAddress: string,
  ): Promise<{ totalCollateralUsd: number; availableMarginUsd: number; gasAptBalance: number }> {
    let totalCollateralUsd = 0;
    let availableMarginUsd = 0;
    let gasAptBalance = 0;

    if (!this.aptos) this.initAptos();
    if (!this.aptos) return { totalCollateralUsd: 0, availableMarginUsd: 0, gasAptBalance: 0 };

    const decibelContract = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
    const gasTarget = (signerAddress && signerAddress.startsWith('0x') && !signerAddress.includes('your_'))
      ? signerAddress
      : subaccount;

    // 1. Gas APT balance on signer address
    try {
      const octas = await this.aptos.getAccountAPTAmount({ accountAddress: gasTarget });
      gasAptBalance = Number(octas) / 1e8;
    } catch {
      // Fallback: check subaccount address for APT
      if (subaccount && subaccount !== gasTarget) {
        try {
          const octasSub = await this.aptos.getAccountAPTAmount({ accountAddress: subaccount });
          gasAptBalance = Math.max(gasAptBalance, Number(octasSub) / 1e8);
        } catch { }
      }
    }

    // Direct public Aptos fullnode REST fallback (100% reliable, zero key dependencies)
    if (gasAptBalance === 0 && gasTarget) {
      try {
        const directRes = await fetch('https://fullnode.mainnet.aptoslabs.com/v1/view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            function: '0x1::coin::balance',
            type_arguments: ['0x1::aptos_coin::AptosCoin'],
            arguments: [gasTarget],
          }),
        });
        if (directRes.ok) {
          const data = (await directRes.json()) as any;
          if (Array.isArray(data) && data[0] !== undefined) {
            gasAptBalance = Number(data[0]) / 1e8;
          }
        }
      } catch { }
    }

    // 2. Query Decibel subaccount collateral on-chain across candidate addresses
    const candidates = [subaccount];
    if (config.DECIBEL_SUBACCOUNT_ADDRESS && !candidates.includes(config.DECIBEL_SUBACCOUNT_ADDRESS)) {
      candidates.push(config.DECIBEL_SUBACCOUNT_ADDRESS);
    }
    if (process.env.DECIBEL_SUBACCOUNT_ADDRESS && !candidates.includes(process.env.DECIBEL_SUBACCOUNT_ADDRESS)) {
      candidates.push(process.env.DECIBEL_SUBACCOUNT_ADDRESS);
    }
    if (config.DECIBEL_OWNER_ADDRESS && !candidates.includes(config.DECIBEL_OWNER_ADDRESS)) {
      candidates.push(config.DECIBEL_OWNER_ADDRESS);
    }

    let activeSubaccount = subaccount;
    for (const target of candidates) {
      if (!target || target.includes('your_') || target.length < 10) continue;
      try {
        const collRes = await this.aptos.view({
          payload: {
            function: `${decibelContract}::perp_engine::get_cross_total_collateral_value`,
            typeArguments: [],
            functionArguments: [target],
          },
        });
        if (collRes?.[0] !== undefined) {
          const raw = Number(collRes[0]);
          if (raw > 0) {
            const val = raw / 1e6;
            if (val > totalCollateralUsd) {
              totalCollateralUsd = val;
              activeSubaccount = target;
            }
          }
        }
      } catch { }

      try {
        const marginRes = await this.aptos.view({
          payload: {
            function: `${decibelContract}::accounts_collateral::available_order_margin`,
            typeArguments: [],
            functionArguments: [target],
          },
        });
        if (marginRes?.[0] !== undefined) {
          const raw = Number(marginRes[0]);
          if (raw > 0) {
            availableMarginUsd = Math.max(availableMarginUsd, raw / 1e6);
          }
        }
      } catch { }
    }

    // Fallback: If view functions returned 0, try MCP balances
    if (totalCollateralUsd === 0) {
      try {
        const mcpBal = await mcpClient.getBalances();
        if (mcpBal) {
          totalCollateralUsd = mcpBal.perpEquityBalance || mcpBal.totalEquityUsd || 0;
          availableMarginUsd = mcpBal.crossWithdrawable || mcpBal.availableMarginUsd || totalCollateralUsd;
        }
      } catch { }
    }

    return {
      totalCollateralUsd: Number(totalCollateralUsd.toFixed(2)),
      availableMarginUsd: Number(availableMarginUsd.toFixed(2)),
      gasAptBalance: Number(gasAptBalance.toFixed(4)),
    };
  }
}

export const onChainPipeline = new OnChainSyncPipelineService();
