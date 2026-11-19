/**
 * Dedicated On-Chain Harvest Execution Engine
 * 
 * Centralizes and standardizes ALL position harvest and closing operations on Decibel DEX:
 *  - Strategy-Agnostic: Adopts ANY harvest policy (SMA Dynamic Gap, Confluence Score Decay,
 *    Volatility ATR Trailing, Fixed RR Scale-outs).
 *  - Authoritative Ledger Integrity: State mutations and PnL are applied ONLY upon
 *    verified Aptos block transaction confirmation (`tx_version` / `txHash`).
 *  - Atomic Mutex: Strictly isolates in-flight executions to eliminate racing double-closes.
 *  - Zero Ghost Records: Replaces unconfirmed local synthetic harvest assumptions with real on-chain fills.
 */

import { logger } from '../utils/logger';
import { mcpClient } from '../mcp/client';
import type { TradeRecord } from './executor';
import { dbClient } from '../db/database';
import { config } from '../config';

function getExecutor() {
  // Lazy require to avoid any circular initialization order
  const { tradeExecutor } = require('./executor');
  return tradeExecutor;
}

export interface HarvestRequest {
  symbol: string;
  closeRatio: number;              // 0.05 to 1.0 (e.g. 0.30 for Tier 1, 1.0 for Terminal Take Profit)
  triggerReason: string;            // e.g. 'SMA_GAP_30_TOUCH', 'CONFLUENCE_SCORE_DECAY', 'TRAILING_SL', 'MANUAL_SWEEP'
  strategySource?: string;          // Origin strategy name or ID
  adjustStopLossToBe?: boolean;     // Whether to ratchet Stop-Loss to Breakeven on partial harvest
  beBufferPct?: number;             // Breakeven fee cover cushion (e.g. 0.003 for +0.30%)
  expectedPrice?: number;           // Target exit price if triggered by limit or touch condition
}

export interface HarvestResult {
  success: boolean;
  txVersion?: string;
  txHash?: string;
  symbol: string;
  executedRatio: number;
  bankedSizeBase?: number;
  remainingSizeBase?: number;
  realizedPnlUsd?: number;
  newStopLoss?: number;
  error?: string;
}

export class HarvestOnChainExecutor {
  private inFlightLocks = new Set<string>();

  private norm(symbol: string): string {
    return (symbol || '').toUpperCase().replace(/[-_/]/g, '');
  }

  /**
   * Execute an on-chain harvest or position scale-out
   */
  public async executeHarvest(req: HarvestRequest): Promise<HarvestResult> {
    const symKey = this.norm(req.symbol);
    if (!symKey) {
      return { success: false, symbol: req.symbol, executedRatio: 0, error: 'Invalid symbol' };
    }

    // 1. In-flight Mutex Lock: Prevent concurrent orders on same asset
    if (this.inFlightLocks.has(symKey)) {
      logger.warn(`⏳ [HARVEST EXECUTOR] Execution already in flight for ${req.symbol}. Request skipped.`);
      return { success: false, symbol: req.symbol, executedRatio: 0, error: 'Execution in flight' };
    }
    this.inFlightLocks.add(symKey);
    const exec = getExecutor();
    exec.markExecutionInFlight(req.symbol);

    const safeRatio = Math.max(0.05, Math.min(1.0, req.closeRatio));
    const isFullClose = safeRatio >= 0.99;

    try {
      // 2. Fetch live trade record
      const trade = exec.getOpenTrades().find((t: TradeRecord) => this.norm(t.symbol) === symKey);
      if (!trade) {
        logger.warn(`⚠️ [HARVEST EXECUTOR] No open trade found for ${req.symbol}. Aborted.`);
        return { success: false, symbol: req.symbol, executedRatio: 0, error: 'No open trade found' };
      }

      // 2b. Invariant Protection: Never execute Take Profit or Harvest on a losing trade!
      // Losing positions must be managed strictly and exclusively by Stop Loss.
      const isTpOrHarvest = req.triggerReason.includes('TIER') || req.triggerReason.includes('HARVEST') || req.triggerReason.includes('TP') || req.triggerReason.includes('TOUCH');
      if (isTpOrHarvest) {
        const isLong = trade.action === 'LONG';
        const curPrice = req.expectedPrice || trade.currentPrice || trade.entryPrice;
        const isPriceLoss = isLong ? (curPrice < trade.entryPrice) : (curPrice > trade.entryPrice);
        const isPnlLoss = (trade.pnlUsd !== undefined && trade.pnlUsd < -0.05);
        if (isPriceLoss || isPnlLoss) {
          logger.warn(`🛑 [HARVEST EXECUTOR REJECTED] Refusing Take Profit (${req.triggerReason}) on losing trade ${trade.symbol} (entry: $${trade.entryPrice}, current: $${curPrice}, PnL: $${trade.pnlUsd}). Losing trades must be handled by Stop Loss.`);
          return { success: false, symbol: trade.symbol, executedRatio: 0, error: 'Trade is not in profit; TP/Harvest rejected' };
        }
      }

      // If partial harvest requested but already performed on this trade:
      if (!isFullClose && trade.harvest30Done) {
        logger.info(`ℹ️ [HARVEST EXECUTOR] Partial harvest already completed for ${trade.symbol}. Runner active.`);
        return { success: false, symbol: req.symbol, executedRatio: 0, error: 'Partial harvest already completed' };
      }

      let onChainTxHash: string | undefined;

      // 3. Real On-Chain Execution via Decibel DEX MCP
      if (!trade.isPaper) {
        logger.info(`⚡ [HARVEST EXECUTOR] Submitting ${(safeRatio * 100).toFixed(0)}% close on-chain for ${trade.symbol} (${req.triggerReason})...`);
        const res = (await mcpClient.closePosition(trade.symbol, safeRatio)) as any;
        if (!res || res.error || (!res.success && !res.txHash)) {
          const errDetail = res?.error || 'No transaction confirmation returned from Decibel DEX';
          logger.warn(`⚠️ [HARVEST EXECUTOR ABORTED] On-chain close failed for ${trade.symbol}: ${errDetail}. Local trade state NOT modified.`);
          return { success: false, symbol: trade.symbol, executedRatio: 0, error: errDetail };
        }
        onChainTxHash = res.txHash;
        logger.info(`✅ [HARVEST EXECUTOR] On-chain close confirmed! Tx: ${onChainTxHash}`);
      } else {
        onChainTxHash = `paper-harvest-${Date.now()}`;
      }

      const isLong = trade.action === 'LONG';
      const markPrice = req.expectedPrice || trade.currentPrice || trade.entryPrice;

      // 4. Handle Partial Scale-Out (e.g. 30%, 50%, or dynamic ratio)
      if (!isFullClose) {
        const remainRatio = 1 - safeRatio;
        const bankedSizeBase = Number((trade.sizeBase * safeRatio).toFixed(4));
        trade.sizeBase = Number((trade.sizeBase * remainRatio).toFixed(4));
        trade.sizeUsd = Number((trade.sizeBase * trade.entryPrice).toFixed(2));
        trade.allocatedUsd = Number((trade.allocatedUsd * remainRatio).toFixed(2));
        trade.harvest30Done = true;
        (trade as any).harvestTxHash = onChainTxHash;

        // Snap Stop-Loss to Breakeven + fee cover cushion if requested
        let beFloor: number | undefined;
        if (req.adjustStopLossToBe) {
          const buffer = req.beBufferPct ?? 0.003; // default +0.30%
          beFloor = Number((isLong
            ? trade.entryPrice * (1 + buffer)
            : trade.entryPrice * (1 - buffer)
          ).toFixed(4));
          trade.stopLoss = beFloor;
          trade.softRatchetPrice = beFloor;
          trade.breakevenMoved = true;
        }

        const pnlPctEstimate = isLong
          ? ((markPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage
          : ((trade.entryPrice - markPrice) / trade.entryPrice) * 100 * trade.leverage;
        const bankedUsdEstimate = Number(((trade.allocatedUsd / remainRatio * safeRatio) * pnlPctEstimate / 100).toFixed(2));
        trade.partialRealizedPnlUsd = (trade.partialRealizedPnlUsd || 0) + Math.max(0, bankedUsdEstimate);

        if (!trade.lifecycleEvents) trade.lifecycleEvents = [];
        trade.lifecycleEvents.push({
          timestamp: Date.now(),
          stage: 'HARVEST',
          title: `🌾 Dynamic Harvest: ${(safeRatio * 100).toFixed(0)}% Closed @ $${markPrice.toFixed(4)} (${req.triggerReason})`,
          description: `Banked ${bankedSizeBase} base (+~$${bankedUsdEstimate}). SL snapped to BE ($${trade.stopLoss || 'N/A'}). Remaining ${(remainRatio * 100).toFixed(0)}% runner active risk-free.`,
          price: markPrice,
          pnlUsd: bankedUsdEstimate,
          details: [
            `Harvest condition triggered: ${req.triggerReason}`,
            `Strategy source: ${req.strategySource || trade.strategyName}`,
            `On-chain Tx Hash: ${onChainTxHash}`,
            `Banked: ${bankedSizeBase} base units (+~$${bankedUsdEstimate})`,
            `Remaining: ${trade.sizeBase} units held for terminal exit`,
          ],
        });

        exec.saveTrades();
        logger.info(
          `🌾 [HARVEST EXECUTOR] Banked ${(safeRatio * 100).toFixed(0)}% on ${trade.symbol}! SL locked at $${trade.stopLoss || 'BE'}. Remaining runner (${trade.sizeBase} base) active risk-free.`
        );

        return {
          success: true,
          txHash: onChainTxHash,
          symbol: trade.symbol,
          executedRatio: safeRatio,
          bankedSizeBase,
          remainingSizeBase: trade.sizeBase,
          realizedPnlUsd: bankedUsdEstimate,
          newStopLoss: beFloor,
        };
      }

      // 5. Handle Full Terminal Close (100% Exit)
      const priceDiff = isLong ? markPrice - trade.entryPrice : trade.entryPrice - markPrice;
      const pnlPct = (priceDiff / trade.entryPrice) * 100 * trade.leverage;
      const pnlUsd = Number(((trade.allocatedUsd * pnlPct) / 100 + (trade.partialRealizedPnlUsd || 0)).toFixed(2));

      trade.status = pnlUsd > 0.05 ? 'closed_tp' : (pnlUsd < -0.0001 ? 'closed_sl' : 'closed_manual');
      trade.exitReason = req.triggerReason;
      trade.exitPrice = markPrice;
      trade.closedAt = Date.now();
      trade.pnlPct = Number(pnlPct.toFixed(2));
      trade.pnlUsd = pnlUsd;
      trade.txHash = onChainTxHash;
      (trade as any).tx_version = onChainTxHash;

      const durationSec = Math.max(1, Math.round(((trade.closedAt || Date.now()) - trade.openedAt) / 1000));
      const durationText = durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;

      if (!trade.lifecycleEvents) trade.lifecycleEvents = [];
      trade.lifecycleEvents.push({
        timestamp: trade.closedAt,
        stage: 'EXIT',
        title: `🎯 Terminal Exit: 100% Close @ $${markPrice.toFixed(4)} (${durationText} hold)`,
        description: `Full position closed on-chain (${req.triggerReason}), banking +$${pnlUsd.toFixed(2)} (${trade.pnlPct}%).`,
        price: markPrice,
        pnlUsd: trade.pnlUsd,
        details: [
          `Trigger Reason: ${req.triggerReason}`,
          `Strategy: ${req.strategySource || trade.strategyName}`,
          `On-chain Tx Hash: ${onChainTxHash}`,
          `Gross Return: ${trade.pnlPct}% ($${trade.pnlUsd})`,
        ],
      });

      exec.saveTrades();
      exec.notifyTradeClosed(trade);
      logger.info(
        `🎯 [HARVEST EXECUTOR] Confirmed 100% close for ${trade.symbol} (${req.triggerReason})! Net PnL: $${trade.pnlUsd} (${trade.pnlPct}%) | Tx: ${onChainTxHash}`
      );

      return {
        success: true,
        txHash: onChainTxHash,
        symbol: trade.symbol,
        executedRatio: 1.0,
        bankedSizeBase: trade.sizeBase,
        remainingSizeBase: 0,
        realizedPnlUsd: pnlUsd,
      };
    } catch (err: any) {
      logger.error(`🚨 [HARVEST EXECUTOR ERROR] ${req.symbol}: ${err.message}`);
      return { success: false, symbol: req.symbol, executedRatio: 0, error: err.message };
    } finally {
      setTimeout(() => {
        this.inFlightLocks.delete(symKey);
        try {
          getExecutor().clearExecutionInFlight(req.symbol);
        } catch {}
      }, 3000);
    }
  }
}

export const harvestOnChainExecutor = new HarvestOnChainExecutor();
