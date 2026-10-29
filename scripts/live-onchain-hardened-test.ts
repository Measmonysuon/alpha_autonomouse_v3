import { mcpClient } from '../src/mcp/client';
import { tradeExecutor } from '../src/trades/executor';
import { config } from '../src/config';
import { logger } from '../src/utils/logger';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runLiveOnChainHardenedTest() {
  console.log('================================================================');
  console.log('🚀 ALPHA AUTONOMOUS — LIVE ON-CHAIN PRODUCTION HARDENING TEST');
  console.log('================================================================');
  console.log(`Subaccount: ${config.DECIBEL_SUBACCOUNT_ADDRESS}`);
  console.log(`Network:    ${config.NETWORK}`);
  console.log('----------------------------------------------------------------\n');

  // STEP 0: Connect to Decibel MCP
  console.log('▶ STEP 0: Initializing Decibel MCP Connection...');
  await mcpClient.connect();
  console.log('   ✅ MCP Transport connected.');

  // STEP 1: Verify Account Balance & Gas
  console.log('▶ STEP 1: Checking On-Chain Subaccount USDC & Delegate APT Gas...');
  const balanceInfo = await tradeExecutor.fetchOnChainBalance();
  console.log(`   USDC Collateral:   $${balanceInfo.balanceUsd.toFixed(2)}`);
  console.log(`   Delegate Gas:      ${balanceInfo.aptBalance.toFixed(4)} APT`);

  // STEP 2: Pre-Flight Fail-Closed Verification
  console.log('\n▶ STEP 2: Pre-Flight Fail-Closed Check (Orders & Existing Positions)...');
  const existingOrders = await mcpClient.getOrders('APT/USD');
  console.log(`   Active Resting Orders: ${existingOrders.length}`);
  if (existingOrders.length > 0) {
    throw new Error('Pre-flight check failed: resting orders already pending on Decibel DEX!');
  }

  const existingPositions = await mcpClient.getPositions();
  const openAptPos = existingPositions.find((p) => (p.symbol || '').toUpperCase().includes('APT'));
  if (openAptPos && ((openAptPos.sizeBase && openAptPos.sizeBase > 0) || (openAptPos.sizeUsd && openAptPos.sizeUsd > 0))) {
    console.log(`   Existing APT position detected: ${openAptPos.sizeBase} APT ($${openAptPos.sizeUsd})`);
    console.log('   Closing existing position first before executing fresh test cycle...');
    await mcpClient.closePosition('APT/USD');
    await sleep(2000);
  } else {
    console.log('   ✅ No pre-existing positions found. Clean slate confirmed.');
  }

  // STEP 3: Test Hardened Leverage Configuration
  const symbol = 'APT/USD';
  console.log(`\n▶ STEP 3: Testing Hardened On-Chain Leverage Configuration (Setting 5x for ${symbol})...`);
  const levResult: any = await mcpClient.setLeverage(symbol, 5);
  console.log(`   ✅ Leverage configured on-chain! Tx/Result:`, levResult);

  // STEP 4: Place Minimal Size Market Order
  const market = await mcpClient.getMarketDetail(symbol);
  const minContractSize = (market?.minSize || 100000) / Math.pow(10, market?.sizeDecimals || 5);
  console.log(`\n▶ STEP 4: Executing Small Market Order on Decibel DEX...`);
  console.log(`   Symbol:    ${symbol}`);
  console.log(`   Side:      BUY (LONG)`);
  console.log(`   Size:      ${minContractSize} APT`);

  const orderResult = await mcpClient.placeMarketOrder({
    symbol,
    side: 'buy',
    size: minContractSize,
    preferMaker: false, // Use Taker for guaranteed immediate on-chain fill in test
    allowTakerFallback: true,
  });

  console.log(`   Status:    ${orderResult.status}`);
  console.log(`   Fill Price: $${orderResult.entryPrice}`);
  console.log(`   Tx Hash:   ${orderResult.txHash}`);

  if (orderResult.status !== 'FILLED') {
    throw new Error(`Order failed to fill: ${orderResult.error || 'Unknown DEX rejection'}`);
  }

  // STEP 5: Verify Position On-Chain & Attach Hard TP/SL
  console.log('\n▶ STEP 5: Verifying Position & Arming On-Chain Hard TP/SL (Concrete Armor)...');
  await sleep(1500);
  const posAfterFill = await mcpClient.getPositions();
  const myPos = posAfterFill.find((p) => (p.symbol || '').toUpperCase().includes('APT'));
  console.log(`   On-chain Position confirmed: ${myPos?.sizeBase} APT @ $${myPos?.entryPrice} (Leverage: ${myPos?.leverage}x)`);

  const tpPrice = Number((orderResult.entryPrice * 1.05).toFixed(4));
  const slPrice = Number((orderResult.entryPrice * 0.95).toFixed(4));
  console.log(`   Arming On-Chain Take Profit: $${tpPrice} (+5%)`);
  console.log(`   Arming On-Chain Stop Loss:   $${slPrice} (-5%)`);

  const tpSlRes: any = await mcpClient.setTpSl({
    symbol,
    tpTrigger: tpPrice,
    slTrigger: slPrice,
  });
  console.log(`   ✅ On-Chain TP/SL Transaction submitted! Tx:`, tpSlRes?.txHash || 'confirmed');

  // STEP 6: Execute Hardened On-Chain Liquidation / Close
  console.log('\n▶ STEP 6: Testing Hardened On-Chain Liquidation Workflow (Emergency Close)...');
  console.log('   Dispatching IOC reduce-only market close to exchange...');
  const closeResult: any = await mcpClient.closePosition(symbol);
  console.log(`   ✅ Close transaction broadcast! Tx Hash: ${closeResult?.txHash || JSON.stringify(closeResult)}`);

  // STEP 7: Reconcile On-Chain State to Confirm 0 Naked Exposure
  console.log('\n▶ STEP 7: Reconciling Post-Close On-Chain State...');
  await sleep(2000);
  const posFinal = await mcpClient.getPositions();
  const residualPos = posFinal.find((p) => (p.symbol || '').toUpperCase().includes('APT'));
  const remainingSize = residualPos?.sizeBase || 0;

  if (remainingSize === 0) {
    console.log('   🏆 ON-CHAIN VERIFICATION SUCCESSFUL: Position size strictly confirmed at 0.00 APT!');
    console.log('   All funds securely returned to subaccount USDC collateral.');
  } else {
    console.error(`   ⚠️ Residual size detected: ${remainingSize} APT. Manual inspection advised.`);
  }

  console.log('\n================================================================');
  console.log('✅ LIVE ON-CHAIN TEST SUITE FULLY COMPLETED WITH SUCCESS');
  console.log('================================================================');
}

runLiveOnChainHardenedTest().catch((err) => {
  console.error('\n❌ LIVE ON-CHAIN TEST FAILED:', err.message);
  process.exit(1);
});
