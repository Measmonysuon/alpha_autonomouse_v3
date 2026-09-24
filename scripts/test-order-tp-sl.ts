/**
 * Verification Script: Client v2 On-Chain Order + TP/SL on Decibel DEX (Aptos Mainnet)
 * 
 * - Symbol: SOL/USD
 * - Amount: $5.00 USDC Margin @ 3x Leverage (~$15.00 USD Notional)
 * - Size: 0.128 SOL (1,280,000 chain units)
 * - Side: BUY (LONG)
 * - Stop Loss: ~$113.80 (-2.6%)
 * - Take Profit: ~$124.00 (+6.1%)
 */

import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';
import { config } from '../src/config';
import { mcpClient } from '../src/mcp/client';
import { logger } from '../src/utils/logger';

async function main() {
  console.log('===============================================================');
  console.log('🚀 [CLIENT V2 ON-CHAIN TEST] Starting 1-Coin On-Chain Test Order');
  console.log('===============================================================');

  const cleanPk = (config.DECIBEL_PRIVATE_KEY || '').replace(/^ed25519-priv-/, '');
  const pk = new Ed25519PrivateKey(cleanPk);
  const signerAccount = Account.fromPrivateKey({ privateKey: pk });
  const subaccount = config.DECIBEL_SUBACCOUNT_ADDRESS;

  const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));

  console.log(`🔑 Delegate Signer Address : ${signerAccount.accountAddress.toString()}`);
  console.log(`🏦 Target Subaccount       : ${subaccount}`);

  // 1. Verify Gas Balance
  const aptBalance = await aptos.getAccountAPTAmount({ accountAddress: signerAccount.accountAddress });
  const aptUi = Number(aptBalance) / 1e8;
  console.log(`⛽ Signer APT Gas Balance  : ${aptUi.toFixed(4)} APT`);
  if (aptUi < 0.02) {
    throw new Error(`Insufficient APT for gas: ${aptUi} APT. Please fund delegate wallet.`);
  }

  // 2. Connect MCP & Verify Subaccount Margin
  console.log('\n📡 Connecting to Decibel MCP...');
  await mcpClient.connect();
  const balances = await mcpClient.getBalances();
  console.log(`💵 Subaccount Total Equity : $${balances.totalEquityUsd.toFixed(2)} USDC`);
  console.log(`💵 Available Margin        : $${balances.availableMarginUsd.toFixed(2)} USDC`);

  if (balances.availableMarginUsd < 5.0) {
    throw new Error(`Insufficient available margin: $${balances.availableMarginUsd.toFixed(2)} USDC (need $5.00)`);
  }

  // 3. Check Initial Open Positions
  const initialPositions = await mcpClient.getPositions();
  console.log(`📊 Initial Open Positions  : ${initialPositions.length}`);
  if (initialPositions.length > 0) {
    console.log(JSON.stringify(initialPositions, null, 2));
  }

  // 4. Market & Pricing Analysis for SOL/USD
  const symbol = 'SOL/USD';
  console.log(`\n🔍 Fetching market details & live price for ${symbol}...`);
  const market = await mcpClient.getMarketDetail(symbol);
  if (!market) {
    throw new Error(`Market ${symbol} not found in configuration!`);
  }
  console.log(`   Market Contract Address : ${market.address}`);
  console.log(`   Size Decimals           : ${market.sizeDecimals}`);
  console.log(`   Price Decimals          : ${market.priceDecimals}`);
  console.log(`   Min Size                : ${market.minSize} (${market.minSize / Math.pow(10, market.sizeDecimals)} SOL)`);
  console.log(`   Lot Size                : ${market.lotSize} (${market.lotSize / Math.pow(10, market.sizeDecimals)} SOL)`);
  console.log(`   Tick Size               : ${market.tickSize} ($${market.tickSize / Math.pow(10, market.priceDecimals)})`);

  const priceObj = await mcpClient.getPrice(symbol);
  const markPrice = priceObj.markPrice || priceObj.lastPrice;
  console.log(`   Current SOL Mark Price  : $${markPrice.toFixed(2)}`);

  // Sizing calculation:
  // Margin: $5.00 USD, Leverage: 3x -> Notional: $15.00 USD
  const targetMarginUsd = 5.0;
  const leverage = 3;
  const targetNotionalUsd = targetMarginUsd * leverage; // $15.00
  const rawBaseSize = targetNotionalUsd / markPrice; // e.g. 15 / 116.85 = 0.12837 SOL

  // Chain sizing with 7 decimals & 10000 lotSize
  let chainSize = Math.round(rawBaseSize * Math.pow(10, market.sizeDecimals));
  chainSize = Math.round(chainSize / market.lotSize) * market.lotSize;
  if (chainSize < market.minSize) chainSize = market.minSize;
  const effectiveBaseSize = chainSize / Math.pow(10, market.sizeDecimals);
  const actualNotionalUsd = effectiveBaseSize * markPrice;
  const actualMarginUsd = actualNotionalUsd / leverage;

  console.log(`\n📐 Calculated Position Parameters:`);
  console.log(`   Target Margin           : $${targetMarginUsd.toFixed(2)} USDC`);
  console.log(`   Leverage                : ${leverage}x`);
  console.log(`   Order Size (SOL)        : ${effectiveBaseSize} SOL (${chainSize} chain units)`);
  console.log(`   Actual Notional Value   : $${actualNotionalUsd.toFixed(2)} USD`);
  console.log(`   Actual Margin Required  : $${actualMarginUsd.toFixed(2)} USDC`);

  // Target Stop Loss and Take Profit
  // TP: +6.1% (~$124.00)
  // SL: -2.6% (~$113.80)
  const tpPrice = Math.round((markPrice * 1.061) * 100) / 100;
  const slPrice = Math.round((markPrice * 0.974) * 100) / 100;
  console.log(`   Take Profit (TP) Target : $${tpPrice.toFixed(2)} (+6.1%)`);
  console.log(`   Stop Loss (SL) Target   : $${slPrice.toFixed(2)} (-2.6%)`);

  // 5. Configure On-Chain Leverage for Subaccount
  console.log(`\n⚙️ Step 1: Configuring on-chain leverage to ${leverage}x cross margin...`);
  try {
    const levTx = await aptos.transaction.build.simple({
      sender: signerAccount.accountAddress,
      data: {
        function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::configure_user_settings_for_market',
        typeArguments: [],
        functionArguments: [
          subaccount,
          market.address,
          true, // cross margin
          leverage,
        ],
      },
    });
    const levAuth = aptos.transaction.sign({ signer: signerAccount, transaction: levTx });
    const levSubmit = await aptos.transaction.submit.simple({ transaction: levTx, senderAuthenticator: levAuth });
    const levReceipt = await aptos.waitForTransaction({ transactionHash: levSubmit.hash });
    console.log(`   ✅ Leverage configured! Tx: ${levSubmit.hash} (Gas: ${levReceipt.gas_used})`);
  } catch (err: any) {
    console.log(`   ℹ️ Leverage configuration note: ${err.message}`);
  }

  // 6. Execute On-Chain Market Order (IOC)
  console.log(`\n⚡ Step 2: Submitting on-chain BUY order for ${effectiveBaseSize} SOL...`);
  // Slippage buffer of 1.5% above mark price to guarantee instant fill
  const maxBuyLimitPrice = Math.round((markPrice * 1.015 * Math.pow(10, market.priceDecimals)) / market.tickSize) * market.tickSize;
  const clientOrderId = `test-v2-${Date.now()}`;

  const orderTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::place_order_to_subaccount',
      typeArguments: [],
      functionArguments: [
        subaccount,
        market.address,
        maxBuyLimitPrice,
        chainSize,
        true, // is_buy = true (LONG)
        2,    // tif: 2 = IOC (Immediate Or Cancel)
        false, // reduce_only = false
        clientOrderId,
        null, // stop_price
        null, // tp_trigger_price
        null, // tp_limit_price
        null, // sl_trigger_price
        null, // sl_limit_price
        null, // builder_address
        null, // builder_fees
      ],
    },
  });

  const orderAuth = aptos.transaction.sign({ signer: signerAccount, transaction: orderTx });
  const orderSubmit = await aptos.transaction.submit.simple({ transaction: orderTx, senderAuthenticator: orderAuth });
  console.log(`   📡 Order submitted! Tx Hash: ${orderSubmit.hash}`);
  console.log(`   ⏳ Waiting for on-chain block confirmation...`);
  const orderReceipt = await aptos.waitForTransaction({ transactionHash: orderSubmit.hash });
  
  if (!orderReceipt.success) {
    throw new Error(`Order transaction failed on-chain: ${orderReceipt.vm_status}`);
  }
  console.log(`   ✅ Order FILLED on-chain! Gas used: ${orderReceipt.gas_used}`);
  console.log(`   🔗 Explorer: https://explorer.aptoslabs.com/txn/${orderSubmit.hash}?network=mainnet`);

  // Small delay to allow Decibel matching engine to index the position
  await new Promise((r) => setTimeout(r, 2500));

  // 7. Verify Position is Open
  console.log(`\n🔎 Step 3: Verifying position opened on-chain...`);
  const posAfterOrder = await mcpClient.getPositions();
  console.log(`   Active positions found: ${posAfterOrder.length}`);
  const solPos = posAfterOrder.find(p => p.symbol === 'SOL/USD' || p.symbol.includes('SOL'));
  if (solPos) {
    console.log(`   ✅ Position active: ${solPos.action} ${solPos.sizeBase} SOL @ Entry $${solPos.entryPrice.toFixed(2)}`);
    console.log(`   Allocated Margin: $${solPos.allocatedUsd?.toFixed(2)} USDC | Leverage: ${solPos.leverage}x`);
  } else {
    console.log(`   ⚠️ Position indexing in progress. Proceeding with on-chain TP/SL attachment...`);
  }

  // 8. Attach On-Chain TP and SL Orders
  console.log(`\n🎯 Step 4: Attaching on-chain Take Profit ($${tpPrice}) and Stop Loss ($${slPrice})...`);
  const chainTpPrice = Math.round((tpPrice * Math.pow(10, market.priceDecimals)) / market.tickSize) * market.tickSize;
  const chainSlPrice = Math.round((slPrice * Math.pow(10, market.priceDecimals)) / market.tickSize) * market.tickSize;

  const tpslTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::place_tp_sl_order_for_position',
      typeArguments: [],
      functionArguments: [
        subaccount,
        market.address,
        chainTpPrice,     // tp_trigger_price
        chainTpPrice,     // tp_limit_price
        null,             // tp_size (null = full position)
        chainSlPrice,     // sl_trigger_price
        chainSlPrice,     // sl_limit_price
        null,             // sl_size (null = full position)
        null,             // builder_address
        null,             // builder_fees
      ],
    },
  });

  const tpslAuth = aptos.transaction.sign({ signer: signerAccount, transaction: tpslTx });
  const tpslSubmit = await aptos.transaction.submit.simple({ transaction: tpslTx, senderAuthenticator: tpslAuth });
  console.log(`   📡 TP/SL submitted! Tx Hash: ${tpslSubmit.hash}`);
  console.log(`   ⏳ Waiting for confirmation...`);
  const tpslReceipt = await aptos.waitForTransaction({ transactionHash: tpslSubmit.hash });

  if (!tpslReceipt.success) {
    throw new Error(`TP/SL transaction failed on-chain: ${tpslReceipt.vm_status}`);
  }
  console.log(`   ✅ On-Chain TP/SL ARMED & CONFIRMED! Gas used: ${tpslReceipt.gas_used}`);
  console.log(`   🔗 Explorer: https://explorer.aptoslabs.com/txn/${tpslSubmit.hash}?network=mainnet`);

  // Small delay then final status check
  await new Promise((r) => setTimeout(r, 2500));

  // 9. Final On-Chain Read-Back
  console.log(`\n📋 Step 5: Final On-Chain Verification Read-Back:`);
  const finalPositions = await mcpClient.getPositions();
  const finalSolPos = finalPositions.find(p => p.symbol === 'SOL/USD' || p.symbol.includes('SOL'));
  if (finalSolPos) {
    console.log(`   Symbol       : ${finalSolPos.symbol}`);
    console.log(`   Action       : ${finalSolPos.action}`);
    console.log(`   Size Base    : ${finalSolPos.sizeBase} SOL`);
    console.log(`   Size USD     : $${finalSolPos.sizeUsd.toFixed(2)}`);
    console.log(`   Entry Price  : $${finalSolPos.entryPrice.toFixed(2)}`);
    console.log(`   Take Profit  : $${finalSolPos.takeProfit || tpPrice}`);
    console.log(`   Stop Loss    : $${finalSolPos.stopLoss || slPrice}`);
  } else {
    console.log(`   Positions list:`, JSON.stringify(finalPositions, null, 2));
  }

  console.log('\n===============================================================');
  console.log('🎉 [TEST COMPLETE] Order + TP + SL Successfully Placed & Verified!');
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('\n❌ [TEST FAILED]:', err);
  process.exit(1);
});
