import { Account, Ed25519PrivateKey, Network } from '@aptos-labs/ts-sdk';
import { createAptosClient } from '../src/utils/node-key-resolver';
import * as dotenv from 'dotenv';
dotenv.config();

const DECIBEL_CONTRACT = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
const DELEGATE_KEY = process.env.DECIBEL_DELEGATE_KEY || '';
const SUBACCOUNT_ADDRESS = process.env.DECIBEL_SUBACCOUNT_ADDRESS || '';

// SUI/USD market: max leverage is 5x
const SUI_MARKET = '0xe7da11926e61dbd227170d1271f73bfaf9f5aab7605fac1ae62541dd3810ae76';
// SOL/USD market: max leverage is 20x
const SOL_MARKET = '0xdf3f9b3241aaf20c47e99eac29f3ff2f736e40644c856e0db612a22e62b847f3';

async function testSimulate(aptos: any, signerAccount: any, marketName: string, marketAddress: string, leverage: number) {
  console.log(`\n🧪 Testing simulation: ${marketName} @ ${leverage}x leverage...`);
  try {
    const rawTx = await aptos.transaction.build.simple({
      sender: signerAccount.accountAddress,
      data: {
        function: `${DECIBEL_CONTRACT}::dex_accounts_entry::configure_user_settings_for_market`,
        typeArguments: [],
        functionArguments: [SUBACCOUNT_ADDRESS, marketAddress, true, leverage],
      },
    });

    const [simResult] = await aptos.transaction.simulate.simple({
      signerPublicKey: signerAccount.publicKey,
      transaction: rawTx,
    });

    console.log(`   Simulated status: success=${simResult.success}, vm_status="${simResult.vm_status}"`);
    if (!simResult.success) {
      console.log(`   ❌ Abort details:`, simResult.vm_status);
    } else {
      console.log(`   ✅ Success! Gas estimate: ${simResult.gas_used}`);
    }
    return simResult;
  } catch (err: any) {
    console.log(`   ❌ Build/Simulation threw error:`, err.message);
    return { success: false, error: err.message };
  }
}

async function main() {
  if (!DELEGATE_KEY || !SUBACCOUNT_ADDRESS) {
    console.error('Missing DECIBEL_DELEGATE_KEY or DECIBEL_SUBACCOUNT_ADDRESS in .env');
    return;
  }

  const cleanKey = DELEGATE_KEY.startsWith('ed25519-priv-') ? DELEGATE_KEY.slice(13) : DELEGATE_KEY;
  const signerAccount = Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(cleanKey),
  });

  const aptos = createAptosClient(Network.MAINNET);
  console.log('Subaccount:', SUBACCOUNT_ADDRESS);
  console.log('Signer:', signerAccount.accountAddress.toString());

  // Test 1: SUI/USD with 5x (Allowed, max is 5x)
  await testSimulate(aptos, signerAccount, 'SUI/USD', SUI_MARKET, 5);

  // Test 2: SUI/USD with 10x (Exceeds max of 5x)
  await testSimulate(aptos, signerAccount, 'SUI/USD', SUI_MARKET, 10);

  // Test 3: SOL/USD with 10x (Allowed, max is 20x)
  await testSimulate(aptos, signerAccount, 'SOL/USD', SOL_MARKET, 10);

  // Test 4: SOL/USD with 25x (Exceeds max of 20x)
  await testSimulate(aptos, signerAccount, 'SOL/USD', SOL_MARKET, 25);
}

main().catch(console.error);

