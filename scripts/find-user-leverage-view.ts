import { createAptosClient } from '../src/utils/node-key-resolver';
import { Network } from '@aptos-labs/ts-sdk';

const DECIBEL_CONTRACT = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';
const SUBACCOUNT_ADDRESS = '0xcc2a2641d3246ace078fb1792c4ae203cbf3587235bdb2257acc2fb2f8275b19';
const SOL_MARKET = '0xdf3f9b3241aaf20c47e99eac29f3ff2f736e40644c856e0db612a22e62b847f3';

async function main() {
  const aptos = createAptosClient(Network.MAINNET);
  const modules = await aptos.getAccountModules({ accountAddress: DECIBEL_CONTRACT });
  
  for (const mod of modules) {
    for (const f of mod.abi?.exposed_functions || []) {
      if (f.name.includes('setting') || f.name.includes('leverage') || f.name.includes('config')) {
        console.log(`${mod.abi?.name}::${f.name} (view: ${f.is_view}) params:`, f.params);
      }
    }
  }
}

main().catch(console.error);

