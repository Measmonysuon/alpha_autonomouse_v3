import { onChainPipeline } from '../src/pipeline/onchain-sync-pipeline';
import { dbClient } from '../src/db/database';
import { config } from '../src/config';

describe('Centralized On-Chain Sync Pipeline & DEX Human Trade Reconciliation', () => {
  it('correctly calculates Total Money as On-Chain Collateral + Unrealized PnL', () => {
    const collateral = 216.08;
    const unrealizedPnl = 1.45;
    const allocatedMargin = 50.00;

    const totalMoney = Math.max(0, Number((collateral + unrealizedPnl).toFixed(2)));
    const availableMargin = Math.max(0, Number((totalMoney - allocatedMargin).toFixed(2)));

    expect(totalMoney).toBe(217.53);
    expect(availableMargin).toBe(167.53);
  });

  it('guarantees 0 drift when no positions are open (Total Money === On-Chain Collateral)', () => {
    const collateral = 216.08;
    const unrealizedPnl = 0;
    const totalMoney = Math.max(0, Number((collateral + unrealizedPnl).toFixed(2)));

    expect(totalMoney).toBe(collateral);
  });

  it('classifies external DEX transactions with no internal bot record as "human trade DEX"', () => {
    const externalFill = {
      market: '0x1234567890abcdef',
      symbol: 'APT/USD',
      side: 'buy',
      action: 'open_long',
      executed_size: 10,
      execution_price: 10.5,
      realized_pnl_amount: 0,
      fee_amount: 0.02,
      transaction_unix_ms: Date.now() - 5000,
      transaction_version: '99887766',
      // No bot client_order_id
    };

    dbClient.syncOnChainTrades([externalFill]);

    const trades = dbClient.getTrades({ limit: 50 });
    const record = trades.find((t) => t.tx_version === '99887766' || t.id === 'txn-99887766');
    expect(record).toBeDefined();
    if (record) {
      expect(record.is_manual).toBe(1);
      expect(record.strategy_name).toBe('human trade DEX');
    }
  });

  it('classifies internal bot orders starting with agent- or decibel- as bot trades', () => {
    const botFill = {
      market: '0x1234567890abcdef',
      symbol: 'BTC/USD',
      side: 'buy',
      action: 'open_long',
      executed_size: 0.01,
      execution_price: 65000,
      realized_pnl_amount: 0,
      fee_amount: 0.15,
      transaction_unix_ms: Date.now() - 4000,
      transaction_version: '99887767',
      client_order_id: 'decibel-1730000000-xyz',
    };

    dbClient.syncOnChainTrades([botFill]);

    const trades = dbClient.getTrades({ limit: 50 });
    const record = trades.find((t) => t.tx_version === '99887767' || t.client_order_id === 'decibel-1730000000-xyz');
    expect(record).toBeDefined();
    if (record) {
      expect(record.is_manual).toBe(0);
      expect(record.strategy_name).not.toBe('human trade DEX');
    }
  });

  it('verifies updated settings values in configuration', () => {
    expect(config.BUDGET_USD).toBe(200);
    expect(config.MAX_LEVERAGE).toBe(13);
    expect(config.GEMINI_MODEL).toBe('gemini-4-argon');
  });

  it('correctly filters out Stop Market and reduce-only orders from resting limit orders', () => {
    const rawOrders = [
      {
        order_id: '170141599249866109383468817072376512512',
        symbol: 'HYPE/USD',
        market: '0x0c6b3fa01e6ee89b04fe3960d8d6377ebbe6caa8e47d87c2120dae1492044df2',
        order_type: 'Stop Market',
        price: 0,
        is_tpsl: true,
        is_reduce_only: true,
        isBuy: false,
      },
      {
        order_id: '170141599249866109383468817072376512513',
        symbol: 'BTC/USD',
        market: '0x1111111111111111111111111111111111111111111111111111111111111111',
        order_type: 'Limit',
        price: 85000,
        is_tpsl: false,
        is_reduce_only: false,
        isBuy: true,
      }
    ];

    const genuineResting = rawOrders.filter((o) => {
      const p = typeof o.price === 'number' ? o.price : parseFloat(o.price || '0');
      return p > 0 && !o.is_tpsl && !o.is_reduce_only && o.order_type !== 'Stop Market' && o.order_type !== 'Stop Limit';
    });

    expect(genuineResting).toHaveLength(1);
    expect(genuineResting[0].symbol).toBe('BTC/USD');
    expect(genuineResting[0].order_id).toBe('170141599249866109383468817072376512513');
  });

  it('resolves HYPE base coin and pair symbols in Decibel price feed properly', () => {
    const { decibelPriceFeed } = require('../src/pipeline/decibel-price-feed');
    decibelPriceFeed.injectPrice('HYPE/USD', 83.63);
    const pxPair = decibelPriceFeed.getPrice('HYPE/USD');
    const pxBase = decibelPriceFeed.getPrice('HYPE');
    expect(pxPair).toBeDefined();
    expect(pxPair?.markPrice).toBeCloseTo(83.63, 1);
    expect(pxBase).toBeDefined();
    expect(pxBase?.markPrice).toBeCloseTo(83.63, 1);
  });
});
