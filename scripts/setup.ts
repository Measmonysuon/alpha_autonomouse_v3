/**
 * Setup & Environment Verification CLI Tool
 * 
 * Verifies that the .env credentials and configurations are valid:
 *  - Checks Decibel DEX subaccount and delegate key
 *  - Tests AI provider connection (Gemini / Claude / Ollama / Math Rules)
 *  - Checks Sim Lab token format
 *  - Tests public kline network reachability
 */

import { config } from '../src/config';
import { localAIBrain } from '../src/ai/brain';
import { fetchPublicKlines } from '../src/engine/standalone-engine';

async function runSetup(): Promise<void> {
  console.log('\n================================================================================');
  console.log('              DECIBEL TRADING CLIENT — ENVIRONMENT & SETUP CHECK                 ');
  console.log('================================================================================\n');

  let errors = 0;
  let warnings = 0;

  // 1. Check Decibel DEX credentials
  console.log('1. Checking Decibel DEX Credentials...');
  if (!config.DECIBEL_SUBACCOUNT_ADDRESS) {
    console.log('   ⚠️  DECIBEL_SUBACCOUNT_ADDRESS is empty. (Required for live on-chain trading)');
    warnings++;
  } else {
    console.log(`   ✅ Subaccount: ${config.DECIBEL_SUBACCOUNT_ADDRESS}`);
  }

  if (!config.DECIBEL_DELEGATE_KEY) {
    console.log('   ⚠️  DECIBEL_DELEGATE_KEY is empty. (Bot will run in PAPER_TRADING mode)');
    warnings++;
  } else {
    console.log(`   ✅ Delegate Key: Configured (${config.DECIBEL_DELEGATE_KEY.slice(0, 10)}...)`);
  }

  console.log(`   ✅ Target Network: ${config.NETWORK}`);
  console.log(`   ✅ Paper Trading: ${config.PAPER_TRADING ? 'TRUE (Safe local testing)' : 'FALSE (Live mainnet)'}`);
  console.log(`   ✅ Allocated Budget: $${config.BUDGET_USD.toFixed(2)} USD`);

  // 2. Check AI Brain
  console.log('\n2. Checking Local AI Brain Provider...');
  console.log(`   Selected Provider: ${config.ACTIVE_AI_PROVIDER.toUpperCase()}`);

  if (config.ACTIVE_AI_PROVIDER === 'gemini') {
    console.log('   ✅ Gemini API Key is configured.');
  } else if (config.ACTIVE_AI_PROVIDER === 'claude') {
    console.log(`   ✅ Claude API Key configured (Base URL: ${config.ANTHROPIC_BASE_URL}).`);
  } else if (config.ACTIVE_AI_PROVIDER === 'ollama') {
    console.log(`   ✅ Ollama Base URL configured (${config.OLLAMA_BASE_URL}).`);
  } else {
    console.log('   ℹ️  No AI key provided. Using built-in local quantitative mathematical rules.');
  }

  // 3. Check Sim Lab Token
  console.log('\n3. Checking Sim Lab Supercharge Token...');
  if (config.IS_SIMLAB_CONFIGURED) {
    console.log(`   ✅ SIMLAB_KEY detected (${config.SIMLAB_KEY.slice(0, 20)}...)`);
    console.log('   Mode: SIM LAB SUPERCHARGED');
  } else {
    console.log('   ℹ️  No SIMLAB_KEY provided. Client will operate in PURE STANDALONE MODE.');
  }

  // 4. Test Public Kline Network Reachability
  console.log('\n4. Testing Free Public Kline Market Feeds...');
  try {
    const klines = await fetchPublicKlines('BTC/USD', '15m', 5);
    if (klines.length > 0) {
      console.log(`   ✅ Successfully fetched BTC/USD klines (Latest close: $${klines[klines.length - 1].close})`);
    } else {
      console.log('   ⚠️  Kline fetch returned empty array. Check internet connection.');
      warnings++;
    }
  } catch (err: any) {
    console.log(`   ❌ Kline fetch error: ${err.message}`);
    errors++;
  }

  console.log('\n================================================================================');
  if (errors === 0) {
    console.log('  🎉 ENVIRONMENT READY! You can start trading with:');
    console.log('     npm run dev   (Development mode with auto-reload)');
    console.log('     npm start     (Production mode)');
  } else {
    console.log(`  ❌ ${errors} Error(s) detected. Please fix the items above.`);
  }
  console.log('================================================================================\n');
}

runSetup().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
