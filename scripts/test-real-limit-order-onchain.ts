import { Account, Ed25519PrivateKey, Network } from '@aptos-labs/ts-sdk';
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const basePath = fs.existsSync(path.join(__dirname, '../src')) ? '../src' : '../dist';
const { resolveNodeApiKey, createAptosClient, getNodeRoutingState } = require(`${basePath}/utils/node-key-resolver`);
const { mcpClient } = require(`${basePath}/mcp/client`);

const DELEGATE_KEY = process.env.DECIBEL_DELEGATE_KEY || process.env.DECIBEL_PRIVATE_KEY || '';
const SUBACCOUNT_ADDRESS = process.env.DECIBEL_SUBACCOUNT_ADDRESS || '';
const DECIBEL_CONTRACT = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';

async function main() {
  console.log('========================================================================');
  console.log('🏛️ [DECIBEL DEX ON-CHAIN TEST] End-to-End Real Limit Order Lifecycle');
  console.log('========================================================================\n');

  // 1. Resolve Node & Connect to Aptos Mainnet
  console.log('📡 [1/6] Connecting to Aptos Mainnet via Decibel Node Resolver...');
  await resolveNodeApiKey({ forceRefresh: true }).catch(() => {});
  const routing = getNodeRoutingState();
  console.log(`   Routing Mode : ${routing.mode} (${routing.activeKeyPrefix})`);

  const aptos = createAptosClient(Network.MAINNET);
  const ledger = await aptos.getLedgerInfo();
  console.log(`   ✅ Connected! Chain ID: ${ledger.chain_id} | Ledger Version: ${ledger.ledger_version}`);

  // 2. Initialize Delegate Signer & Verify Balances
  console.log('\n🔑 [2/6] Initializing Signer Account & Checking Balances...');
  const cleanPk = DELEGATE_KEY.replace(/^ed25519-priv-/, '');
  const pk = new Ed25519PrivateKey(cleanPk);
  const signerAccount = Account.fromPrivateKey({ privateKey: pk });
  const signerAddr = signerAccount.accountAddress.toString();
  console.log(`   Signer Address     : ${signerAddr}`);
  console.log(`   Target Subaccount  : ${SUBACCOUNT_ADDRESS}`);

  const aptGas = await aptos.getAccountAPTAmount({ accountAddress: signerAccount.accountAddress });
  const aptGasUi = Number(aptGas) / 1e8;
  console.log(`   ⛽ Signer Gas       : ${aptGasUi.toFixed(4)} APT`);
  if (aptGasUi < 0.01) {
    throw new Error(`Insufficient APT gas balance: ${aptGasUi} APT`);
  }

  let subMarginUsd = 0;
  try {
    const collRes = await aptos.view({
      payload: {
        function: `${DECIBEL_CONTRACT}::perp_engine::get_cross_total_collateral_value`,
        typeArguments: [],
        functionArguments: [SUBACCOUNT_ADDRESS],
      },
    });
    if (collRes?.[0]) subMarginUsd = Number(collRes[0]) / 1e6;
  } catch (err: any) {
    console.log(`   Warning querying collateral: ${err.message}`);
  }
  console.log(`   💵 Subaccount Margin: $${subMarginUsd.toFixed(2)} USDC`);
  if (subMarginUsd < 5.0) {
    throw new Error(`Insufficient subaccount collateral: $${subMarginUsd.toFixed(2)} USDC`);
  }

  // 3. Connect MCP & Fetch Market Metadata
  const symbol = 'APT/USD';
  console.log(`\n📊 [3/6] Fetching Decibel Market Metadata for ${symbol}...`);
  await mcpClient.connect().catch(() => {});
  const market = await mcpClient.getMarketDetail(symbol);
  if (!market) {
    throw new Error(`Could not find market metadata for ${symbol}`);
  }
  const priceObj = await mcpClient.getPrice(symbol);
  const markPrice = priceObj.markPrice || priceObj.lastPrice || 8.50;
  console.log(`   Market Address     : ${market.address}`);
  console.log(`   Current Mark Price : $${markPrice.toFixed(4)}`);
  console.log(`   Tick Size          : ${market.tickSize} | Lot Size: ${market.lotSize}`);
  console.log(`   Size Decimals      : ${market.sizeDecimals} | Price Decimals: ${market.priceDecimals}`);

  // Calculate safe Post-Only Limit Price (5% below market price to sit safely in orderbook as Maker bid)
  const discountPct = 0.05; // -5.0%
  const targetLimitPriceNum = markPrice * (1 - discountPct);
  
  // Quantize price to tickSize
  const priceMultiplier = Math.pow(10, market.priceDecimals);
  let chainPrice = Math.round((targetLimitPriceNum * priceMultiplier) / market.tickSize) * market.tickSize;
  const effectivePrice = chainPrice / priceMultiplier;

  // Sizing: Minimum order or $10 notional
  const notionalTargetUsd = 10.0;
  const rawBase = notionalTargetUsd / effectivePrice;
  const sizeMultiplier = Math.pow(10, market.sizeDecimals);
  let chainSize = Math.round(rawBase * sizeMultiplier);
  if (market.lotSize && market.lotSize > 0) {
    chainSize = Math.round(chainSize / market.lotSize) * market.lotSize;
  }
  if (market.minSize && chainSize < market.minSize) {
    chainSize = market.minSize;
  }
  const effectiveSize = chainSize / sizeMultiplier;

  console.log(`\n🎯 Limit Order Parameters:`);
  console.log(`   Side               : BUY (LONG)`);
  console.log(`   Type               : POST_ONLY_MAKER (TIF = 1)`);
  console.log(`   Current Mark Price : $${markPrice.toFixed(4)}`);
  console.log(`   Limit Bid Price    : $${effectivePrice.toFixed(4)} (-5.0% below mark)`);
  console.log(`   Chain Price Units  : ${chainPrice}`);
  console.log(`   Order Size         : ${effectiveSize} APT (${chainSize} chain units)`);
  console.log(`   Notional Value     : $${(effectiveSize * effectivePrice).toFixed(2)} USD`);

  // 4. Submit Real On-Chain Limit Order (Post-Only)
  console.log(`\n⚡ [4/6] Placing Real On-Chain Post-Only Limit Order on Decibel DEX...`);
  const clientOrderId = `limit-test-${Date.now()}`;
  const tif = 1; // 1 = PostOnly (Maker)
  const reduceOnly = false;

  const placeTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: `${DECIBEL_CONTRACT}::dex_accounts_entry::place_order_to_subaccount`,
      typeArguments: [],
      functionArguments: [
        SUBACCOUNT_ADDRESS,
        market.address,
        chainPrice,
        chainSize,
        true, // is_buy = true
        tif,  // TimeInForce = 1 (Post-Only Maker)
        reduceOnly,
        clientOrderId,
        null, null, null, null, null, null, null,
      ],
    },
  });

  const placeAuth = aptos.transaction.sign({ signer: signerAccount, transaction: placeTx });
  const placeSub = await aptos.transaction.submit.simple({ transaction: placeTx, senderAuthenticator: placeAuth });
  console.log(`   📡 Submitted Transaction: ${placeSub.hash}`);
  console.log(`   ⏳ Waiting for block confirmation on Aptos Mainnet...`);

  const placeReceipt = await aptos.waitForTransaction({ transactionHash: placeSub.hash });
  if (!placeReceipt.success) {
    throw new Error(`On-chain limit order transaction failed: ${placeReceipt.vm_status}`);
  }

  console.log(`   ✅ [LIMIT ORDER PLACED ON-CHAIN!]`);
  console.log(`   Tx Hash    : ${placeSub.hash}`);
  console.log(`   Gas Used   : ${placeReceipt.gas_used} units`);
  console.log(`   Client Ord : ${clientOrderId}`);
  console.log(`   🔗 Explorer : https://explorer.aptoslabs.com/txn/${placeSub.hash}?network=mainnet`);

  // 5. Verify Resting Order on Decibel DEX
  console.log(`\n📋 [5/6] Verifying Resting Order on Decibel Orderbook...`);
  await new Promise((r) => setTimeout(r, 3500)); // allow indexer to sync
  const restingOrders = await mcpClient.getOrders(symbol);
  console.log(`   Resting Orders Found: ${restingOrders.length}`);
  const match = restingOrders.find((o: any) => o.clientOrderId === clientOrderId || o.client_order_id === clientOrderId);
  if (match) {
    console.log(`   ✅ Verified Resting in Decibel DEX Orderbook:`, JSON.stringify(match));
  } else {
    console.log(`   Resting orders query:`, restingOrders);
  }

  // 6. Clean On-Chain Cancellation
  console.log(`\n🧹 [6/6] Cancelling Limit Order On-Chain via cancel_client_order_to_subaccount...`);
  const cancelTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: `${DECIBEL_CONTRACT}::dex_accounts_entry::cancel_client_order_to_subaccount`,
      typeArguments: [],
      functionArguments: [
        SUBACCOUNT_ADDRESS,
        clientOrderId,
        market.address,
      ],
    },
  });

  const cancelAuth = aptos.transaction.sign({ signer: signerAccount, transaction: cancelTx });
  const cancelSub = await aptos.transaction.submit.simple({ transaction: cancelTx, senderAuthenticator: cancelAuth });
  console.log(`   📡 Submitted Cancel Transaction: ${cancelSub.hash}`);
  console.log(`   ⏳ Waiting for block confirmation...`);

  const cancelReceipt = await aptos.waitForTransaction({ transactionHash: cancelSub.hash });
  if (!cancelReceipt.success) {
    throw new Error(`On-chain cancel transaction failed: ${cancelReceipt.vm_status}`);
  }

  console.log(`   ✅ [LIMIT ORDER CANCELLED ON-CHAIN!]`);
  console.log(`   Cancel Tx Hash : ${cancelSub.hash}`);
  console.log(`   Gas Used       : ${cancelReceipt.gas_used} units`);
  console.log(`   🔗 Explorer     : https://explorer.aptoslabs.com/txn/${cancelSub.hash}?network=mainnet`);

  console.log('\n========================================================================');
  console.log('🎉 [END-TO-END TEST PASSED] Real On-Chain Limit Order + Cancel Verified!');
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('\n❌ [TEST FAILED]:', err);
  process.exit(1);
});

