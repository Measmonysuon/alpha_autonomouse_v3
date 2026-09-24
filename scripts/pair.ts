/**
 * Sim Lab Pairing CLI Tool
 * 
 * Tests the SIMLAB_KEY provided in .env (or CLI argument), decodes the payload,
 * connects to Sim Lab, and displays the synchronized strategy directives.
 */

import { config } from '../src/config';
import { superchargeClient } from '../src/simlab/supercharge-client';
import { standaloneEngine } from '../src/engine/standalone-engine';

async function runPair(): Promise<void> {
  console.log('\n==================================================');
  console.log('  SIM LAB SUPERCHARGE PAIRING TEST');
  console.log('==================================================\n');

  const token = process.argv[2] || config.SIMLAB_KEY;

  if (!token) {
    console.error('❌ Error: No SIMLAB_KEY found in .env or passed as argument.');
    console.log('Usage: npm run pair [simlab_live_...]\n');
    process.exit(1);
  }

  console.log(`🔑 Testing Token: ${token.slice(0, 20)}...`);

  const decoded = superchargeClient.decodeToken(token);
  if (!decoded) {
    console.error('❌ Failed to decode token. Ensure it starts with "simlab_live_".\n');
    process.exit(1);
  }

  console.log(`✅ Token Decoded Successfully:`);
  console.log(`   - Server URL: ${decoded.s}`);
  console.log(`   - Key ID:     ${decoded.k}`);
  console.log(`   - Version:    ${decoded.v}`);
  console.log(`\n📡 Connecting to Sim Lab at ${decoded.s}...`);

  superchargeClient.configureToken(token);
  const success = await superchargeClient.connect();

  if (success) {
    const directives = standaloneEngine.getDirectives();
    console.log('\n🎉 PAIRING SUCCESSFUL! Live Directives Synchronized:');
    console.log(`   - Active Strategy:    ${directives.activeStrategy}`);
    console.log(`   - Score Floor:        ${directives.scoreFloor}`);
    console.log(`   - Wick Tolerance:     ${directives.bullTrapUpperWickPct}%`);
    console.log(`   - Banned Directions:  [${directives.bannedSides.join(', ')}]`);
    console.log(`   - Macro Regime:       ${directives.regime}`);
    console.log(`   - Directives Source:  ${directives.source}\n`);
    superchargeClient.stop();
    process.exit(0);
  } else {
    console.error('\n❌ Pairing failed. Check network, server URL, or token validity.\n');
    superchargeClient.stop();
    process.exit(1);
  }
}

runPair().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
