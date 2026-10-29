import { createAptosClient } from '../src/utils/node-key-resolver';
import { Network } from '@aptos-labs/ts-sdk';

const DECIBEL_CONTRACT = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';

const MARKETS = [
  { symbol: 'BTC/USD', address: '0x5e0e16f34adfb4b316f8d532d68acbfa206826feaaa418d3938046bdc2044861' },
  { symbol: 'ETH/USD', address: '0x96c3c2e77041264d082d03365e9c346fbc6be9c9428a401be8e70dcb60dc60c6' },
  { symbol: 'SOL/USD', address: '0xdf3f9b3241aaf20c47e99eac29f3ff2f736e40644c856e0db612a22e62b847f3' },
  { symbol: 'SUI/USD', address: '0xe7da11926e61dbd227170d1271f73bfaf9f5aab7605fac1ae62541dd3810ae76' },
  { symbol: 'NEAR/USD', address: '0xc29172db08345aceadb2306320c3239a212d55fdb6c728109a0de62864c4a02f' },
  { symbol: 'APT/USD', address: '0xda8615922bac85a53811e845ce39110713be6d80366f4477d5427002ac0162e3' },
  { symbol: 'DOGE/USD', address: '0xd62d10d1ef0cbe2103b5bd479691ac38222a85140fcbe7c2dc66ed23bdef58ae' },
];

async function main() {
  console.log('Testing on-chain market_max_leverage view function on Aptos Mainnet...');
  const aptos = createAptosClient(Network.MAINNET);

  for (const m of MARKETS) {
    try {
      const res = await aptos.view({
        payload: {
          function: `${DECIBEL_CONTRACT}::perp_engine::market_max_leverage`,
          typeArguments: [],
          functionArguments: [m.address],
        },
      });
      console.log(`✅ ${m.symbol.padEnd(10)} (Market: ${m.address.slice(0, 10)}...): Max Leverage = ${res[0]}x`);
    } catch (err: any) {
      console.error(`❌ ${m.symbol}: ${err.message}`);
    }
  }
}

main().catch(console.error);

