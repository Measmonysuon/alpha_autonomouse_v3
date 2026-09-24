/**
 * Test Suite: missingOnChainCount Debounce & Local Position Removal Verification
 * 
 * Verifies:
 * 1. Cycle 1 / Strike 1 (< 3500ms): Position absence is debounced; position remains 'open'.
 * 2. Rapid repeat check (< 3500ms): Even if missed >= 2, if duration < 3500ms, position holds 'open'.
 * 3. Cycle 2+ & >= 3500ms: External absence is confirmed:
 *    - trade.status is marked closed (closed_tp, closed_sl, or closed_manual based on PnL)
 *    - trade.exitReason is strictly 'MANUAL_DEX_CLOSE'
 *    - trade is removed from getOpenTrades()
 *    - missingOnChainCount & missingFirstSeenAt are cleanly deleted
 * 4. On-chain positions (e.g. BTC/USD) and paper positions (e.g. DOGE/USD) remain unaffected.
 */

import { tradeExecutor, TradeRecord } from '../src/trades/executor';
import { mcpClient } from '../src/mcp/client';
import { config } from '../src/config';

async function runTest() {
  console.log('================================================================');
  console.log('🧪 RUNNING: Reconcile Debounce (2 cycles / 3500ms) & Removal Test');
  console.log('================================================================\n');

  // Override PAPER_TRADING so syncOnChainPositions executes real reconciliation logic
  const originalPaperTrading = config.PAPER_TRADING;
  (config as any).PAPER_TRADING = false;

  // Mock mcpClient
  const originalIsConnected = mcpClient.isConnected.bind(mcpClient);
  const originalGetPositions = mcpClient.getPositions.bind(mcpClient);
  mcpClient.isConnected = () => true;

  // Access private cache for controlled test harness
  const executorAny = tradeExecutor as any;
  const initialTrades = [...executorAny.tradesCache];

  try {
    const t0 = Date.now();
    const tradeTp: TradeRecord = {
      id: `test-tp-${Date.now()}`,
      symbol: 'APT/USD',
      side: 'buy',
      action: 'LONG',
      entryPrice: 10.0,
      takeProfit: 12.0,
      stopLoss: 9.0,
      sizeUsd: 100,
      sizeBase: 10,
      leverage: 3,
      allocatedUsd: 33.3,
      confidence: 90,
      status: 'open',
      isPaper: false,
      openedAt: t0 - 60000,
      pnlUsd: 2.50, // Profit -> should resolve to closed_tp
      strategyName: 'Test Long Strategy',
    };

    const tradeSl: TradeRecord = {
      id: `test-sl-${Date.now()}`,
      symbol: 'SOL/USD',
      side: 'sell',
      action: 'SHORT',
      entryPrice: 150.0,
      takeProfit: 140.0,
      stopLoss: 155.0,
      sizeUsd: 150,
      sizeBase: 1,
      leverage: 3,
      allocatedUsd: 50.0,
      confidence: 85,
      status: 'open',
      isPaper: false,
      openedAt: t0 - 60000,
      pnlUsd: -1.75, // Loss -> should resolve to closed_sl
      strategyName: 'Test Short Strategy',
    };

    const tradePersistent: TradeRecord = {
      id: `test-btc-${Date.now()}`,
      symbol: 'BTC/USD',
      side: 'buy',
      action: 'LONG',
      entryPrice: 65000,
      takeProfit: 70000,
      stopLoss: 62000,
      sizeUsd: 200,
      sizeBase: 0.003,
      leverage: 3,
      allocatedUsd: 66.6,
      confidence: 92,
      status: 'open',
      isPaper: false,
      openedAt: t0 - 60000,
      pnlUsd: 0.10,
      strategyName: 'Test BTC Position',
    };

    const tradePaper: TradeRecord = {
      id: `test-doge-${Date.now()}`,
      symbol: 'DOGE/USD',
      side: 'buy',
      action: 'LONG',
      entryPrice: 0.15,
      takeProfit: 0.20,
      stopLoss: 0.12,
      sizeUsd: 50,
      sizeBase: 333,
      leverage: 2,
      allocatedUsd: 25.0,
      confidence: 80,
      status: 'open',
      isPaper: true, // Paper trade -> should NOT be removed by on-chain sync
      openedAt: t0 - 60000,
      strategyName: 'Test Paper Position',
    };

    // Replace cache with test trades
    executorAny.tradesCache = [tradeTp, tradeSl, tradePersistent, tradePaper];
    executorAny.missingOnChainCount.clear();
    executorAny.missingFirstSeenAt.clear();

    // Mock on-chain DEX report: Only BTC/USD is reported on-chain; APT and SOL are absent
    mcpClient.getPositions = async () => [
      {
        symbol: 'BTC-USD',
        side: 'buy',
        action: 'LONG',
        entryPrice: 65000,
        takeProfit: 70000,
        stopLoss: 62000,
        sizeUsd: 200,
        sizeBase: 0.003,
        leverage: 3,
        allocatedUsd: 66.6,
      } as any,
    ];

    console.log('Initial setup:');
    console.log(`- Total test trades: ${executorAny.tradesCache.length}`);
    console.log(`- Open trades in cache: ${tradeExecutor.getOpenTrades().map(t => t.symbol).join(', ')}`);
    console.log(`- On-chain DEX positions: BTC-USD\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: First Cycle (missed = 1, duration = 0ms < 3500ms)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 1: Cycle 1 (First absence detection) ---');
    await tradeExecutor.syncOnChainPositions();

    const openAfterC1 = tradeExecutor.getOpenTrades();
    console.log(`Open trades count after Cycle 1: ${openAfterC1.length}`);
    console.log(`APT/USD status: ${tradeTp.status}, strike: ${executorAny.missingOnChainCount.get('APT/USD')}`);
    console.log(`SOL/USD status: ${tradeSl.status}, strike: ${executorAny.missingOnChainCount.get('SOL/USD')}`);

    if (tradeTp.status !== 'open' || tradeSl.status !== 'open') {
      throw new Error(`FAIL: Position closed on Cycle 1! Debounce violated.`);
    }
    if (executorAny.missingOnChainCount.get('APT/USD') !== 1 || executorAny.missingOnChainCount.get('SOL/USD') !== 1) {
      throw new Error(`FAIL: missingOnChainCount should be 1 after cycle 1.`);
    }
    if (!openAfterC1.some(t => t.symbol === 'APT/USD') || !openAfterC1.some(t => t.symbol === 'SOL/USD')) {
      throw new Error(`FAIL: Positions should remain in getOpenTrades() during cycle 1.`);
    }
    console.log('✅ TEST 1 PASSED: Positions held open on strike 1/2.\n');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: Rapid intermediate check (missed = 2, but duration < 3500ms)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 2: Rapid intermediate check (missed = 2, duration = 1000ms < 3500ms) ---');
    // Simulate check 1000ms later (both conditions must be true: missed >= 2 AND duration >= 3500ms)
    executorAny.missingFirstSeenAt.set('APT/USD', Date.now() - 1000);
    executorAny.missingFirstSeenAt.set('SOL/USD', Date.now() - 1000);

    await tradeExecutor.syncOnChainPositions();

    console.log(`APT/USD status: ${tradeTp.status}, strike: ${executorAny.missingOnChainCount.get('APT/USD')}`);
    console.log(`SOL/USD status: ${tradeSl.status}, strike: ${executorAny.missingOnChainCount.get('SOL/USD')}`);

    if (tradeTp.status !== 'open' || tradeSl.status !== 'open') {
      throw new Error(`FAIL: Position closed before 3500ms elapsed! Debounce timing violated.`);
    }
    if (executorAny.missingOnChainCount.get('APT/USD') !== 2 || executorAny.missingOnChainCount.get('SOL/USD') !== 2) {
      throw new Error(`FAIL: missingOnChainCount should be 2.`);
    }
    console.log('✅ TEST 2 PASSED: Positions held open when duration < 3500ms even with missed >= 2.\n');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: External absence confirmation (missed >= 2 AND duration >= 3500ms)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 3: External absence confirmation (missed >= 2 AND duration >= 3500ms) ---');
    // Simulate that positions have been missing for 3600ms
    executorAny.missingFirstSeenAt.set('APT/USD', Date.now() - 3600);
    executorAny.missingFirstSeenAt.set('SOL/USD', Date.now() - 3600);

    await tradeExecutor.syncOnChainPositions();

    console.log(`APT/USD status: ${tradeTp.status}, exitReason: ${tradeTp.exitReason}`);
    console.log(`SOL/USD status: ${tradeSl.status}, exitReason: ${tradeSl.exitReason}`);

    if ((tradeTp.status as string) !== 'closed_tp') {
      throw new Error(`FAIL: APT/USD with profit should be 'closed_tp', got: ${tradeTp.status}`);
    }
    if (tradeTp.exitReason !== 'MANUAL_DEX_CLOSE') {
      throw new Error(`FAIL: APT/USD exitReason should be 'MANUAL_DEX_CLOSE', got: ${tradeTp.exitReason}`);
    }

    if ((tradeSl.status as string) !== 'closed_sl') {
      throw new Error(`FAIL: SOL/USD with loss should be 'closed_sl', got: ${tradeSl.status}`);
    }
    if (tradeSl.exitReason !== 'MANUAL_DEX_CLOSE') {
      throw new Error(`FAIL: SOL/USD exitReason should be 'MANUAL_DEX_CLOSE', got: ${tradeSl.exitReason}`);
    }

    // Verify missingOnChainCount and missingFirstSeenAt were cleared
    if (executorAny.missingOnChainCount.has('APT/USD') || executorAny.missingOnChainCount.has('SOL/USD')) {
      throw new Error(`FAIL: missingOnChainCount should be deleted upon confirmation.`);
    }
    if (executorAny.missingFirstSeenAt.has('APT/USD') || executorAny.missingFirstSeenAt.has('SOL/USD')) {
      throw new Error(`FAIL: missingFirstSeenAt should be deleted upon confirmation.`);
    }

    console.log('✅ TEST 3 PASSED: Both absent positions confirmed closed with exitReason = MANUAL_DEX_CLOSE.\n');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: Local position removal from getOpenTrades()
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 4: Verification of local position removal ---');
    const finalOpen = tradeExecutor.getOpenTrades();
    const finalOpenSymbols = finalOpen.map(t => t.symbol);
    console.log(`Remaining open trades: ${finalOpenSymbols.join(', ')}`);

    if (finalOpenSymbols.includes('APT/USD')) {
      throw new Error(`FAIL: APT/USD should have been removed from getOpenTrades()!`);
    }
    if (finalOpenSymbols.includes('SOL/USD')) {
      throw new Error(`FAIL: SOL/USD should have been removed from getOpenTrades()!`);
    }
    if (!finalOpenSymbols.includes('BTC/USD')) {
      throw new Error(`FAIL: Active on-chain position BTC/USD was erroneously removed!`);
    }
    if (!finalOpenSymbols.includes('DOGE/USD')) {
      throw new Error(`FAIL: Paper trade DOGE/USD was erroneously removed!`);
    }

    console.log('✅ TEST 4 PASSED: Absent positions removed from active open trades; active & paper trades preserved.\n');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: Transient glitch recovery (re-appearance resets debounce counter)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 5: Transient glitch recovery ---');
    const glitchTrade: TradeRecord = {
      id: `test-glitch-${Date.now()}`,
      symbol: 'ETH/USD',
      side: 'buy',
      action: 'LONG',
      entryPrice: 2500,
      takeProfit: 2700,
      stopLoss: 2400,
      sizeUsd: 100,
      sizeBase: 0.04,
      leverage: 2,
      allocatedUsd: 50,
      confidence: 88,
      status: 'open',
      isPaper: false,
      openedAt: Date.now(),
      strategyName: 'Glitch Test',
    };
    executorAny.tradesCache.push(glitchTrade);

    // Cycle A: missing
    await tradeExecutor.syncOnChainPositions();
    if (executorAny.missingOnChainCount.get('ETH/USD') !== 1) {
      throw new Error(`FAIL: Glitch trade strike should be 1.`);
    }

    // Cycle B: on-chain reports ETH-USD is back!
    mcpClient.getPositions = async () => [
      { symbol: 'ETH-USD', sizeBase: 0.04, entryPrice: 2500 } as any,
    ];
    await tradeExecutor.syncOnChainPositions();
    if (executorAny.missingOnChainCount.get('ETH/USD') !== 0) {
      throw new Error(`FAIL: Re-appearance should reset missingOnChainCount to 0.`);
    }
    if (glitchTrade.status !== 'open') {
      throw new Error(`FAIL: Glitch trade should remain open after re-appearing.`);
    }
    console.log('✅ TEST 5 PASSED: Re-appearance resets strike counter to 0.\n');

    console.log('================================================================');
    console.log('🎉 ALL 5 RECONCILIATION & LOCAL POSITION REMOVAL TESTS PASSED!');
    console.log('================================================================');

  } finally {
    // Restore original state
    mcpClient.isConnected = originalIsConnected;
    mcpClient.getPositions = originalGetPositions;
    (config as any).PAPER_TRADING = originalPaperTrading;
    executorAny.tradesCache = initialTrades;
    executorAny.missingOnChainCount.clear();
    executorAny.missingFirstSeenAt.clear();
  }
}

runTest().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
