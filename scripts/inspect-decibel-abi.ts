import { createAptosClient } from '../src/utils/node-key-resolver';
import { Network } from '@aptos-labs/ts-sdk';

const DECIBEL_CONTRACT = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';

async function main() {
  console.log('Connecting to Aptos Mainnet...');
  const aptos = createAptosClient(Network.MAINNET);
  
  console.log('Inspecting modules under', DECIBEL_CONTRACT);
  try {
    const modules = await aptos.getAccountModules({ accountAddress: DECIBEL_CONTRACT });
    console.log(`Found ${modules.length} modules.`);
    
    for (const mod of modules) {
      const name = mod.abi?.name;
      if (name?.includes('account') || name?.includes('market') || name?.includes('user') || name?.includes('perp') || name?.includes('setting')) {
        console.log(`\n=== Module: ${name} ===`);
        const funcs = mod.abi?.exposed_functions || [];
        for (const f of funcs) {
          if (f.name.includes('leverage') || f.name.includes('setting') || f.name.includes('market') || f.name.includes('user') || f.is_view) {
            const params = f.params.map((p: any) => typeof p === 'string' ? p : JSON.stringify(p)).join(', ');
            const returns = (f.return || []).join(', ');
            console.log(`  ${f.is_view ? '[VIEW] ' : ''}${f.is_entry ? '[ENTRY] ' : ''}${f.name}(${params}) -> (${returns})`);
          }
        }
      }
    }
  } catch (err: any) {
    console.error('Error querying modules:', err.message);
  }
}

main().catch(console.error);

