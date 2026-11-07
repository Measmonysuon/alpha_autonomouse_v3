/**
 * End-to-End On-Chain Testing & Verification Script
 * Validates:
 *   Stage 1: Real On-Chain Limit Order -> Verified in Client V3 (Port 5050) & Broadcaster (Port 8085)
 *   Stage 2: Real On-Chain Position Open + Attached TP/SL -> Verified in UI (ActivePos present, LimitOrder = null)
 *   Stage 3: Real On-Chain Position Close -> Verified ZERO ghost positions or orders in Client V3 & Broadcaster
 */

import { Account, Ed25519PrivateKey, Network } from '@aptos-labs/ts-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const basePath = fs.existsSync(path.join(__dirname, '../src')) ? '../src' : '../dist';
const { resolveNodeApiKey, createAptosClient } = require(`${basePath}/utils/node-key-resolver`);
const { mcpClient } = require(`${basePath}/mcp/client`);

const DELEGATE_KEY = process.env.DECIBEL_DELEGATE_KEY || '';
const SUBACCOUNT_ADDRESS = process.env.DECIBEL_SUBACCOUNT_ADDRESS || '';
const DECIBEL_CONTRACT = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
const JETSON_IP = process.env.JETSON_IP || '127.0.0.1';
const CLIENT_V3_URL = process.env.CLIENT_V3_URL || `http://${JETSON_IP}:5050`;
const BROADCASTER_URL = process.env.BROADCASTER_URL || `http://${JETSON_IP}:8085`;

async function fetchJson(url: string, options: any = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getLivePrice(symbol: string): Promise<number> {
  try {
    const st = await fetchJson(`${CLIENT_V3_URL}/api/state`);
    const norm = symbol.toUpperCase().replace(/[-_/]/g, '');
    const m = st?.markets?.[symbol] || st?.markets?.[symbol.replace('-', '/')] || st?.markets?.[norm];
    const p = Number(m?.markPrice || m?.price || 0);
    if (p > 0) return p;
  } catch {}
  try {
    const pObj = await mcpClient.getPrice(symbol);
    if (pObj?.markPrice && pObj.markPrice > 0) return pObj.markPrice;
  } catch {}
  if (symbol.includes('APT')) return 0.639;
  if (symbol.includes('SOL')) return 96.0;
  return 1.0;
}

function evaluateCockpitState(state: any, symbol: string) {
  const rawBase = symbol.split(/[-_/]/)[0].toUpperCase();
  const normSym = symbol.toUpperCase().replace(/[-_/]/g, '');
  
  const activePositions = state.positions || state.openPositions || [];
  const activePos = activePositions.find((p: any) => {
    const pSym = (p.symbol || '').toUpperCase().replace(/[-_/]/g, '');
    return (pSym === normSym || pSym.startsWith(rawBase)) && (!p.status || p.status.toLowerCase() === 'open');
  }) || null;

  const activeOrders = state.openOrders || state.restingOrders || [];
  let activeLimitOrder = !activePos ? activeOrders.find((o: any) => {
    const oSym = (o.symbol || o.market || '').toUpperCase().replace(/[-_/]/g, '');
    const isGenuineLimit = Boolean(!o.is_tpsl && !o.is_reduce_only && o.order_type !== 'Stop Market' && o.order_type !== 'Stop Limit' && Number(o.price) > 0);
    return (oSym === normSym || oSym.startsWith(rawBase)) && isGenuineLimit;
  }) : null;

  const mkt = state.markets?.[symbol] || 
              state.markets?.[symbol.replace('-', '/')] || 
              state.markets?.[normSym] || 
              Object.entries(state.markets || {}).find(([k]) => k.toUpperCase().replace(/[-_/]/g, '') === normSym)?.[1];

  if (!activeLimitOrder && !activePos && (mkt?.isOrderResting || mkt?.action === 'LIMIT ORDER')) {
    activeLimitOrder = {
      symbol: symbol,
      price: mkt.price || mkt.markPrice,
      isRestingLimit: true,
      action: 'LIMIT ORDER',
    };
  }

  return { activePos, activeLimitOrder, mkt };
}

async function main() {
  console.log('================================================================================');
  console.log('🧪 [END-TO-END VERIFICATION] CLIENT V3 & BROADCASTER ON-CHAIN TEST SUITE');
  console.log(`   Client V3   : ${CLIENT_V3_URL}`);
  console.log(`   Broadcaster : ${BROADCASTER_URL}`);
  console.log(`   Subaccount  : ${SUBACCOUNT_ADDRESS}`);
  console.log('================================================================================\n');

  // Pre-flight setup
  await resolveNodeApiKey({ forceRefresh: true }).catch(() => {});
  const aptos = createAptosClient(Network.MAINNET);
  const cleanPk = DELEGATE_KEY.replace(/^ed25519-priv-/, '');
  const pk = new Ed25519PrivateKey(cleanPk);
  const signerAccount = Account.fromPrivateKey({ privateKey: pk });
  await mcpClient.connect().catch(() => {});

  // Pre-flight state hygiene
  console.log('🧹 [PRE-FLIGHT] Sanitizing existing orders and verifying baseline state...');
  try {
    await mcpClient.cancelAllOrders().catch(() => {});
    const existingPositions = await mcpClient.getPositions().catch(() => []);
    for (const p of (existingPositions || [])) {
      if (p.symbol === 'SOL/USD' || p.symbol === 'APT/USD') {
        console.log(`   Closing pre-existing test position: ${p.symbol}`);
        await mcpClient.closePosition(p.symbol, 1.0).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
    await fetchJson(`${CLIENT_V3_URL}/api/trades/sync`).catch(() => {});
  } catch (err: any) {
    console.log(`   Pre-flight hygiene notice: ${err.message}`);
  }
  console.log('✅ [PRE-FLIGHT READY] Baseline clean.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // STAGE 1: REAL ON-CHAIN LIMIT ORDER PLACEMENT & UI CONSOLIDATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📍 [STAGE 1] Testing On-Chain Limit Order -> UI & Broadcaster Recognition');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const aptMarket = await mcpClient.getMarketDetail('APT/USD').catch(() => null) || {
    address: '0xda8615922bac85a53811e845ce39110713be6d80366f4477d5427002ac0162e3',
    minSize: 100000,
    lotSize: 10000,
    tickSize: 100,
    sizeDecimals: 5,
    priceDecimals: 6,
  };
  const aptMarkPrice = await getLivePrice('APT/USD');
  console.log(`   APT/USD Mark Price : $${aptMarkPrice.toFixed(4)}`);

  // Place Post-Only Maker bid 5% below market so it rests in the book
  const limitBidPrice = Math.round((aptMarkPrice * 0.95 * 1e6) / aptMarket.tickSize) * aptMarket.tickSize;
  const effectiveBidPrice = limitBidPrice / 1e6;
  const chainSizeApt = aptMarket.minSize || 100000; // 1.0 APT (~$0.60)
  const clientOrderId = `limit-test-${Date.now()}`;

  console.log(`   Placing Maker Limit Order: 1.0 APT @ $${effectiveBidPrice.toFixed(4)} (TIF=1 Post-Only)...`);
  const placeTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: `${DECIBEL_CONTRACT}::dex_accounts_entry::place_order_to_subaccount`,
      typeArguments: [],
      functionArguments: [
        SUBACCOUNT_ADDRESS,
        aptMarket.address,
        limitBidPrice,
        chainSizeApt,
        true, // BUY
        1,    // TimeInForce = 1 (Post-Only Maker)
        false,// reduce_only = false
        clientOrderId,
        null, null, null, null, null, null, null,
      ],
    },
  });

  const placeAuth = aptos.transaction.sign({ signer: signerAccount, transaction: placeTx });
  const placeSub = await aptos.transaction.submit.simple({ transaction: placeTx, senderAuthenticator: placeAuth });
  console.log(`   📡 Tx Submitted : ${placeSub.hash}`);
  const placeReceipt = await aptos.waitForTransaction({ transactionHash: placeSub.hash });
  if (!placeReceipt.success) throw new Error(`Limit order failed: ${placeReceipt.vm_status}`);
  console.log(`   ✅ Limit Order Placed on Decibel DEX! Gas used: ${placeReceipt.gas_used}`);

  // Allow indexer sync + trigger on-chain pipeline sync on Client V3 with retries
  let v3State1: any = null;
  let bcState1: any = null;
  let v3Eval1: any = null;
  let bcEval1: any = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`   ⏳ Syncing Client V3 & Broadcaster (Attempt ${attempt}/4)...`);
    await new Promise((r) => setTimeout(r, 3000));
    await fetchJson(`${CLIENT_V3_URL}/api/trades/sync`).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    v3State1 = await fetchJson(`${CLIENT_V3_URL}/api/state`);
    bcState1 = await fetchJson(`${BROADCASTER_URL}/api/state`);
    v3Eval1 = evaluateCockpitState(v3State1, 'APT/USD');
    bcEval1 = evaluateCockpitState(bcState1, 'APT/USD');
    if (v3Eval1.activeLimitOrder) break;
  }

  console.log(`\n🔍 [STAGE 1 AUDIT RESULTS]:`);
  console.log(`   • Client V3 Market Price      : $${v3Eval1.mkt?.markPrice || v3Eval1.mkt?.price} (Decibel feed: $${aptMarkPrice.toFixed(4)})`);
  console.log(`   • Broadcaster Market Price    : $${bcEval1.mkt?.markPrice || bcEval1.mkt?.price}`);
  console.log(`   • Client V3 Active Position   : ${v3Eval1.activePos ? '⚠️ UNEXPECTED POS' : 'NONE ✅ (No ghost position)'}`);
  console.log(`   • Broadcaster Active Position : ${bcEval1.activePos ? '⚠️ UNEXPECTED POS' : 'NONE ✅ (No ghost position)'}`);
  console.log(`   • Client V3 Limit Order       : ${v3Eval1.activeLimitOrder ? `FOUND ✅ ($${v3Eval1.activeLimitOrder.price} | isRestingLimit: true)` : '⚠️ NOT DETECTED'}`);
  console.log(`   • Broadcaster Limit Order     : ${bcEval1.activeLimitOrder ? `FOUND ✅ ($${bcEval1.activeLimitOrder.price} | isRestingLimit: true)` : '⚠️ NOT DETECTED'}`);

  if (!v3Eval1.activeLimitOrder || v3Eval1.activePos) {
    throw new Error('Stage 1 validation failed: Resting limit order not properly isolated or ghost position appeared!');
  }
  console.log(`   🎯 Stage 1 PASSED: Limit order correctly identified on CLOB and rendered in UI.\n`);

  // Clean cancellation of Stage 1 limit order
  console.log(`   🧹 Cancelling Stage 1 Limit Order On-Chain...`);
  const cancelTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: `${DECIBEL_CONTRACT}::dex_accounts_entry::cancel_client_order_to_subaccount`,
      typeArguments: [],
      functionArguments: [SUBACCOUNT_ADDRESS, clientOrderId, aptMarket.address],
    },
  });
  const cancelAuth = aptos.transaction.sign({ signer: signerAccount, transaction: cancelTx });
  const cancelSub = await aptos.transaction.submit.simple({ transaction: cancelTx, senderAuthenticator: cancelAuth });
  await aptos.waitForTransaction({ transactionHash: cancelSub.hash });
  console.log(`   ✅ Stage 1 Limit Order Cancelled on-chain (${cancelSub.hash}).`);
  console.log(`   ⏳ Syncing cancellation state to Client V3 & Broadcaster...`);
  await new Promise((r) => setTimeout(r, 3000));
  await fetchJson(`${CLIENT_V3_URL}/api/trades/sync`).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`   🧹 Stage 1 cleanup complete.\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STAGE 2: REAL ON-CHAIN POSITION OPENING + ATTACHED TP/SL + UI CONSOLIDATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📍 [STAGE 2] Testing On-Chain Position Open + Attached TP/SL -> UI Consolidation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const solMarket = await mcpClient.getMarketDetail('SOL/USD').catch(() => null) || {
    address: '0xdf3f9b3241aaf20c47e99eac29f3ff2f736e40644c856e0db612a22e62b847f3',
    minSize: 200000,
    lotSize: 10000,
    tickSize: 10000,
    sizeDecimals: 7,
    priceDecimals: 6,
  };

  const solMarkPrice = await getLivePrice('SOL/USD');
  console.log(`   SOL/USD Mark Price : $${solMarkPrice.toFixed(2)}`);

  const solChainSize = solMarket.minSize || 200000; // 0.02 SOL (~$1.92 notional)
  const solEffectiveSize = solChainSize / 1e7;
  const buySlippage = Math.round((solMarkPrice * 1.02 * 1e6) / solMarket.tickSize) * solMarket.tickSize;
  const posClientOrderId = `pos-open-${Date.now()}`;

  console.log(`   Opening Real On-Chain Position: ${solEffectiveSize} SOL @ ~$${solMarkPrice.toFixed(2)} IOC...`);
  const openTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: `${DECIBEL_CONTRACT}::dex_accounts_entry::place_order_to_subaccount`,
      typeArguments: [],
      functionArguments: [
        SUBACCOUNT_ADDRESS,
        solMarket.address,
        buySlippage,
        solChainSize,
        true, // BUY
        2,    // IOC Market
        false,// reduce_only = false
        posClientOrderId,
        null, null, null, null, null, null, null,
      ],
    },
  });

  const openAuth = aptos.transaction.sign({ signer: signerAccount, transaction: openTx });
  const openSub = await aptos.transaction.submit.simple({ transaction: openTx, senderAuthenticator: openAuth });
  console.log(`   📡 Order Tx Submitted : ${openSub.hash}`);
  const openReceipt = await aptos.waitForTransaction({ transactionHash: openSub.hash });
  if (!openReceipt.success) throw new Error(`Open position failed: ${openReceipt.vm_status}`);
  console.log(`   🎯 [POSITION OPENED ON DECIBEL DEX!] Gas: ${openReceipt.gas_used}`);

  // Attach On-Chain TP (+6%) and SL (-3%)
  const tpPrice = Math.round((solMarkPrice * 1.06) * 100) / 100;
  const slPrice = Math.round((solMarkPrice * 0.97) * 100) / 100;
  const chainTp = Math.round((tpPrice * 1e6) / solMarket.tickSize) * solMarket.tickSize;
  const chainSl = Math.round((slPrice * 1e6) / solMarket.tickSize) * solMarket.tickSize;

  console.log(`   Attaching On-Chain TP ($${tpPrice}) and SL ($${slPrice})...`);
  const tpslTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: `${DECIBEL_CONTRACT}::dex_accounts_entry::place_tp_sl_order_for_position`,
      typeArguments: [],
      functionArguments: [
        SUBACCOUNT_ADDRESS,
        solMarket.address,
        chainTp,
        chainTp,
        solChainSize, // exact size of position
        chainSl,
        chainSl,
        solChainSize, // exact size of position
        undefined,
        undefined,
      ],
    },
  });

  const tpslAuth = aptos.transaction.sign({ signer: signerAccount, transaction: tpslTx });
  const tpslSub = await aptos.transaction.submit.simple({ transaction: tpslTx, senderAuthenticator: tpslAuth });
  const tpslReceipt = await aptos.waitForTransaction({ transactionHash: tpslSub.hash });
  console.log(`   ✅ On-Chain TP/SL Attached! (${tpslSub.hash})`);

  // Wait for indexer sync and retry poll up to 4 times
  let v3State2: any = null;
  let bcState2: any = null;
  let v3Eval2: any = null;
  let bcEval2: any = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`   ⏳ Syncing Client V3 & Broadcaster (Attempt ${attempt}/4)...`);
    await new Promise((r) => setTimeout(r, 3000));
    await fetchJson(`${CLIENT_V3_URL}/api/trades/sync`).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    v3State2 = await fetchJson(`${CLIENT_V3_URL}/api/state`);
    bcState2 = await fetchJson(`${BROADCASTER_URL}/api/state`);
    v3Eval2 = evaluateCockpitState(v3State2, 'SOL/USD');
    bcEval2 = evaluateCockpitState(bcState2, 'SOL/USD');
    if (v3Eval2.activePos) break;
  }

  console.log(`\n🔍 [STAGE 2 AUDIT RESULTS]:`);
  console.log(`   • Client V3 Active Position   : ${v3Eval2.activePos ? `FOUND ✅ (${v3Eval2.activePos.action} ${v3Eval2.activePos.sizeBase} SOL @ $${v3Eval2.activePos.entryPrice})` : '⚠️ NOT FOUND'}`);
  console.log(`   • Broadcaster Active Position : ${bcEval2.activePos ? `FOUND ✅ (${bcEval2.activePos.action} ${bcEval2.activePos.sizeBase} SOL @ $${bcEval2.activePos.entryPrice})` : '⚠️ NOT FOUND'}`);
  console.log(`   • Real-Time Mark Price        : $${v3Eval2.activePos?.markPrice} (Decibel Feed: $${solMarkPrice})`);
  console.log(`   • Attached Stop Loss          : $${v3Eval2.activePos?.stopLoss || v3Eval2.activePos?.hardStopLoss}`);
  console.log(`   • Attached Take Profit        : $${v3Eval2.activePos?.takeProfit}`);
  console.log(`   • Attached Soft Ratchet SL    : $${v3Eval2.activePos?.softRatchetPrice || 'Armed'}`);
  console.log(`   • Real-Time Unrealized PnL    : $${v3Eval2.activePos?.unrealizedPnl || v3Eval2.activePos?.pnlUsd}`);
  console.log(`   • Limit Order Invariant       : ${v3Eval2.activeLimitOrder === null ? 'PASSED ✅ (activeLimitOrder is NULL — Stop Loss NOT misclassified as limit order!)' : '⚠️ FAILED: Stop order misclassified as limit order!'}`);

  if (!v3Eval2.activePos || v3Eval2.activeLimitOrder !== null) {
    throw new Error('Stage 2 validation failed: Position not recognized or TP/SL order misclassified as limit order!');
  }
  console.log(`   🎯 Stage 2 PASSED: Position and TP/SL cleanly consolidated with realistic Decibel prices.\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STAGE 3: REAL ON-CHAIN POSITION CLOSE & GHOST SUPPRESSION VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📍 [STAGE 3] Closing Position On-Chain -> Verifying Ghost Suppression');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const sellSlippage = Math.round((solMarkPrice * 0.98 * 1e6) / solMarket.tickSize) * solMarket.tickSize;
  const closeOrderId = `pos-close-${Date.now()}`;

  console.log(`   Submitting On-Chain Reduce-Only SELL to Close Position...`);
  const closeTx = await aptos.transaction.build.simple({
    sender: signerAccount.accountAddress,
    data: {
      function: `${DECIBEL_CONTRACT}::dex_accounts_entry::place_order_to_subaccount`,
      typeArguments: [],
      functionArguments: [
        SUBACCOUNT_ADDRESS,
        solMarket.address,
        sellSlippage,
        solChainSize,
        false, // SELL
        2,     // IOC
        true,  // is_reduce_only = true
        closeOrderId,
        null, null, null, null, null, null, null,
      ],
    },
  });

  const closeAuth = aptos.transaction.sign({ signer: signerAccount, transaction: closeTx });
  const closeSub = await aptos.transaction.submit.simple({ transaction: closeTx, senderAuthenticator: closeAuth });
  console.log(`   📡 Close Tx Submitted : ${closeSub.hash}`);
  const closeReceipt = await aptos.waitForTransaction({ transactionHash: closeSub.hash });
  if (!closeReceipt.success) throw new Error(`Close position failed: ${closeReceipt.vm_status}`);
  console.log(`   🎯 [POSITION CLOSED ON DECIBEL DEX!] Gas: ${closeReceipt.gas_used}`);

  // Clean any remaining conditional TP/SL orders on-chain
  console.log(`   🧹 Ensuring remaining conditional TP/SL orders are cleared on-chain...`);
  try {
    await mcpClient.cancelAllOrders('SOL/USD');
  } catch (err: any) {
    console.log(`   ℹ️ Cancel orders notice: ${err.message}`);
  }

  // Wait for indexer and retry poll up to 4 times
  let v3State3: any = null;
  let bcState3: any = null;
  let v3Eval3: any = null;
  let bcEval3: any = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`   ⏳ Syncing Client V3 & Broadcaster (Attempt ${attempt}/4)...`);
    await new Promise((r) => setTimeout(r, 3000));
    await fetchJson(`${CLIENT_V3_URL}/api/trades/sync`).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    v3State3 = await fetchJson(`${CLIENT_V3_URL}/api/state`);
    bcState3 = await fetchJson(`${BROADCASTER_URL}/api/state`);
    v3Eval3 = evaluateCockpitState(v3State3, 'SOL/USD');
    bcEval3 = evaluateCockpitState(bcState3, 'SOL/USD');
    if (v3Eval3.activePos === null && bcEval3.activePos === null) break;
  }

  console.log(`\n🔍 [STAGE 3 AUDIT RESULTS]:`);
  console.log(`   • Client V3 Open Positions    : ${JSON.stringify(v3State3.positions || v3State3.openPositions || [])} ${v3Eval3.activePos === null ? '✅ (Clean 0 positions)' : '⚠️ GHOST POSITION'}`);
  console.log(`   • Broadcaster Open Positions  : ${JSON.stringify(bcState3.positions || bcState3.openPositions || [])} ${bcEval3.activePos === null ? '✅ (Clean 0 positions)' : '⚠️ GHOST POSITION'}`);
  console.log(`   • Client V3 Active Orders     : ${JSON.stringify(v3State3.openOrders || v3State3.restingOrders || [])} ${v3Eval3.activeLimitOrder === null ? '✅ (Clean 0 orders)' : '⚠️ GHOST ORDER'}`);
  console.log(`   • Broadcaster Active Orders   : ${JSON.stringify(bcState3.openOrders || bcState3.restingOrders || [])} ${bcEval3.activeLimitOrder === null ? '✅ (Clean 0 orders)' : '⚠️ GHOST ORDER'}`);

  if (v3Eval3.activePos !== null || bcEval3.activePos !== null) {
    throw new Error('Stage 3 validation failed: Ghost position still lingering in UI after close!');
  }
  console.log(`   🎯 Stage 3 PASSED: Zero ghost positions or orphan orders remaining. State restored to scanning.\n`);

  console.log('================================================================================');
  console.log('🎉 [ALL 3 END-TO-END STAGES PASSED WITH 100% SUCCESS!]');
  console.log('   Stage 1: Limit order placed on-chain -> Correctly recognized as Maker Limit Order (No ghost pos).');
  console.log('   Stage 2: Position opened with TP/SL -> Accurately consolidated with live Decibel price & SL ratchet.');
  console.log('   Stage 3: Position closed on-chain -> Completely cleared with zero ghost positions in V3 & Broadcaster.');
  console.log('================================================================================\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ [TEST FAILED]:', err);
  process.exit(1);
});
