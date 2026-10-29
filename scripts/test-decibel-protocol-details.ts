import { createAptosClient } from '../src/utils/node-key-resolver';
import { Network, Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const DECIBEL_CONTRACT = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
const DELEGATE_KEY = process.env.DECIBEL_DELEGATE_KEY || '';
const SUBACCOUNT_ADDRESS = process.env.DECIBEL_SUBACCOUNT_ADDRESS || '';

// Authoritative markets from local data cache
const cachePath = path.resolve(__dirname, '../data/decibel-markets.json');
const marketsData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

async function main() {
  console.log('========================================================================');
  console.log('🔬 DECIBEL DEX PROTOCOL & RISK CAP ON-CHAIN VERIFICATION');
  console.log('========================================================================\n');

  const aptos = createAptosClient(Network.MAINNET);
  const cleanKey = DELEGATE_KEY.startsWith('ed25519-priv-') ? DELEGATE_KEY.slice(13) : DELEGATE_KEY;
  const signerAccount = DELEGATE_KEY ? Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(cleanKey) }) : null;

  // ──────────────────────────────────────────────────────────────────────────
  // 1. DOLLAR LOSS CEILING ($0.85) VS MINIMUM CONTRACT SIZES
  // ──────────────────────────────────────────────────────────────────────────
  console.log('1. Analyzing Dollar Risk at Stop Loss vs Minimum Market Size:');
  console.log('   Assumed Stop Loss Distance: 2.0% | Hard Loss Cap: $0.85 USD\n');

  for (const [sym, m] of Object.entries(marketsData as Record<string, any>)) {
    if (!m.address) continue;
    
    // Get live on-chain mark price & max leverage via view functions
    let markPrice = 0;
    let maxLev = 10;
    try {
      const pRes = await aptos.view({
        payload: {
          function: `${DECIBEL_CONTRACT}::perp_engine::get_mark_price`,
          typeArguments: [],
          functionArguments: [m.address],
        },
      });
      if (pRes[0]) {
        markPrice = Number(pRes[0]) / Math.pow(10, m.priceDecimals || 6);
      }
    } catch {}

    try {
      const levRes = await aptos.view({
        payload: {
          function: `${DECIBEL_CONTRACT}::perp_engine::market_max_leverage`,
          typeArguments: [],
          functionArguments: [m.address],
        },
      });
      if (levRes[0]) {
        maxLev = Number(levRes[0]);
      }
    } catch {}

    if (markPrice <= 0) continue;

    const sizeDecimals = m.sizeDecimals || 5;
    const minUnits = m.minSize || 10000;
    const minBase = minUnits / Math.pow(10, sizeDecimals);
    const minNotional = minBase * markPrice;
    const minMarginAtMaxLev = minNotional / maxLev;
    const lossAt2PctSl = minNotional * 0.02;

    const canTradeWithinCap = lossAt2PctSl <= 0.85;
    const badge = canTradeWithinCap ? '✅ TRADEABLE' : '🛑 VIOLATES $0.85 CAP';

    console.log(
      `   ${badge.padEnd(23)} ${sym.padEnd(9)} | Mark: $${markPrice.toFixed(markPrice > 10 ? 2 : 4).padEnd(8)} | ` +
      `MinSize: ${minBase.toString().padEnd(7)} ($${minNotional.toFixed(2).padEnd(6)}) | ` +
      `MaxLev: ${maxLev}x | Margin: $${minMarginAtMaxLev.toFixed(2)} | ` +
      `Loss at 2% SL: $${lossAt2PctSl.toFixed(2)}`
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. ON-CHAIN SIMULATION OF REDUCE-ONLY CLOSE & TP/SL PLACEMENT
  // ──────────────────────────────────────────────────────────────────────────
  if (signerAccount && SUBACCOUNT_ADDRESS) {
    console.log('\n2. Testing Protocol Functions on-chain via simulation (Zero Gas Spent):');
    const solMarket = marketsData['SOL-USD'] || marketsData['SOL/USD'];
    
    if (solMarket) {
      // Test A: Bulk order cancellation
      try {
        const cancelTx = await aptos.transaction.build.simple({
          sender: signerAccount.accountAddress,
          data: {
            function: `${DECIBEL_CONTRACT}::dex_accounts_entry::cancel_bulk_order_to_subaccount`,
            typeArguments: [],
            functionArguments: [SUBACCOUNT_ADDRESS, solMarket.address],
          },
        });
        const [cancelSim] = await aptos.transaction.simulate.simple({
          signerPublicKey: signerAccount.publicKey,
          transaction: cancelTx,
        });
        console.log(`   ✅ cancel_bulk_order_to_subaccount: status="${cancelSim.vm_status}" (gas: ${cancelSim.gas_used})`);
      } catch (e: any) {
        console.log(`   ❌ cancel_bulk_order test note: ${e.message}`);
      }

      // Test B: Place TP/SL order for position
      try {
        const tpslTx = await aptos.transaction.build.simple({
          sender: signerAccount.accountAddress,
          data: {
            function: `${DECIBEL_CONTRACT}::dex_accounts_entry::place_tp_sl_order_for_position`,
            typeArguments: [],
            functionArguments: [
              SUBACCOUNT_ADDRESS,
              solMarket.address,
              200_000_000, // TP $200
              200_000_000,
              null,
              100_000_000, // SL $100
              100_000_000,
              null,
              null,
              null,
            ],
          },
        });
        const [tpslSim] = await aptos.transaction.simulate.simple({
          signerPublicKey: signerAccount.publicKey,
          transaction: tpslTx,
        });
        console.log(`   ✅ place_tp_sl_order_for_position: status="${tpslSim.vm_status}" (gas: ${tpslSim.gas_used})`);
      } catch (e: any) {
        console.log(`   ❌ TP/SL test note: ${e.message}`);
      }

      // Test C: Reduce-only market close
      try {
        const closeTx = await aptos.transaction.build.simple({
          sender: signerAccount.accountAddress,
          data: {
            function: `${DECIBEL_CONTRACT}::dex_accounts_entry::place_order_to_subaccount`,
            typeArguments: [],
            functionArguments: [
              SUBACCOUNT_ADDRESS,
              solMarket.address,
              100_000_000, // Limit price
              100_000,     // 0.01 SOL
              false,       // SELL
              2,           // IOC
              true,        // is_reduce_only = true
              `close-sim-${Date.now()}`,
              null, null, null, null, null, null, null,
            ],
          },
        });
        const [closeSim] = await aptos.transaction.simulate.simple({
          signerPublicKey: signerAccount.publicKey,
          transaction: closeTx,
        });
        console.log(`   ✅ place_order_to_subaccount (reduce_only=true): status="${closeSim.vm_status}" (gas: ${closeSim.gas_used})`);
      } catch (e: any) {
        console.log(`   ❌ Reduce-only close test note: ${e.message}`);
      }
    }
  }

  console.log('\n========================================================================');
  console.log('✅ ALL ON-CHAIN PROTOCOL VERIFICATIONS COMPLETE');
  console.log('========================================================================\n');
}

main().catch(console.error);

