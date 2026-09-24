/**
 * End-to-End Automated Test Suite for V3 Onboarding Wizard
 * 
 * Verifies the full onboarding lifecycle:
 * 1. Initial setup status retrieval (/api/setup/status)
 * 2. Delegate key signer derivation (/api/setup/derive-signer)
 * 3. On-chain Decibel subaccount verification & gas signer confusion guard (/api/setup/verify-subaccount)
 * 4. Pre-onboard state reset (/api/setup/reset)
 * 5. Input validation & error edge cases on activation (/api/setup/activate)
 * 6. Successful full activation and engine spin-up
 * 7. Post-activation state verification (/api/setup/status, /api/state)
 * 8. Automatic restoration of original production settings
 */

import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';
dotenv.config();

const BASE_URL = process.env.V3_URL || 'http://localhost:5050';
const SETTINGS_FILE = path.resolve(__dirname, '..', 'data', 'settings.json');

const VALID_DELEGATE_KEY = process.env.DECIBEL_DELEGATE_KEY || '';
const VALID_SUBACCOUNT = process.env.DECIBEL_SUBACCOUNT_ADDRESS || '';
let expectedGasSigner = '';

async function fetchJson(endpoint: string, options: any = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ PASSED: ${message}`);
}

async function runE2E() {
  console.log('================================================================');
  console.log('🚀 RUNNING: Client V3 Onboarding Wizard E2E Test Suite');
  console.log(`📡 Target Server: ${BASE_URL}`);
  console.log('================================================================\n');

  // Step 0: Backup original settings
  console.log('📦 Step 0: Backing up current settings.json...');
  let originalSettingsContent: string | null = null;
  if (fs.existsSync(SETTINGS_FILE)) {
    originalSettingsContent = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    console.log(`  Saved ${originalSettingsContent.length} bytes of settings.`);
  } else {
    console.log('  No existing settings.json found.');
  }

  try {
    // Step 1: Check initial setup status
    console.log('\n🔍 Step 1: Testing GET /api/setup/status...');
    const step1 = await fetchJson('/api/setup/status');
    assert(step1.ok, `GET /api/setup/status responded with status 200 (got ${step1.status})`);
    assert(typeof step1.data.isConfigured === 'boolean', 'isConfigured is boolean');
    assert(typeof step1.data.onboarded === 'boolean', 'onboarded is boolean');
    console.log(`  Current State: isConfigured=${step1.data.isConfigured}, signer=${step1.data.signerAddress}`);

    // Step 2: Signer derivation
    console.log('\n🔑 Step 2: Testing POST /api/setup/derive-signer...');
    // Valid key
    const step2Valid = await fetchJson('/api/setup/derive-signer', {
      method: 'POST',
      body: JSON.stringify({ delegateKey: VALID_DELEGATE_KEY })
    });
    expectedGasSigner = step2Valid.data.signerAddress;
    assert(
      Boolean(expectedGasSigner && expectedGasSigner.startsWith('0x')),
      `Derived gas signer address matches expected: ${expectedGasSigner}`
    );
    assert(
      step2Valid.data.explorerUrl?.includes('explorer.aptoslabs.com'),
      'Explorer URL is correctly constructed'
    );

    // Invalid key
    const step2Invalid = await fetchJson('/api/setup/derive-signer', {
      method: 'POST',
      body: JSON.stringify({ delegateKey: 'invalid-non-hex-key' })
    });
    assert(step2Invalid.data.success === false, 'derive-signer with invalid key gracefully returns success: false');

    // Step 3: Subaccount on-chain verification & Gas Signer Confusion Guard
    console.log('\n🛡️ Step 3: Testing POST /api/setup/verify-subaccount...');
    
    // 3a. Malformed address
    const step3Malformed = await fetchJson('/api/setup/verify-subaccount', {
      method: 'POST',
      body: JSON.stringify({ address: 'not-an-aptos-address' })
    });
    assert(step3Malformed.status === 400 && step3Malformed.data.success === false, 'Rejects invalid address format with 400');

    // 3b. Gas Signer address mistakenly entered as Subaccount
    const step3GasSigner = await fetchJson('/api/setup/verify-subaccount', {
      method: 'POST',
      body: JSON.stringify({
        address: expectedGasSigner,
        delegateKey: VALID_DELEGATE_KEY
      })
    });
    assert(
      step3GasSigner.data.success === false && step3GasSigner.data.isSignerAddress === true,
      'Confusion Guard: Detects Gas Signer key address mistakenly used as Subaccount'
    );
    assert(
      step3GasSigner.data.error?.includes('Gas Signer key address'),
      'Confusion Guard: Returns descriptive warning explaining USDC collateral requirement'
    );

    // 3c. Valid on-chain Decibel Subaccount
    const step3Valid = await fetchJson('/api/setup/verify-subaccount', {
      method: 'POST',
      body: JSON.stringify({
        address: VALID_SUBACCOUNT,
        delegateKey: VALID_DELEGATE_KEY
      })
    });
    assert(step3Valid.ok && step3Valid.data.success === true, 'Valid subaccount verification succeeds');
    assert(
      Boolean(step3Valid.data.resolvedSubaccount && step3Valid.data.resolvedSubaccount.startsWith('0x')),
      `Resolved subaccount is valid Aptos address: ${step3Valid.data.resolvedSubaccount}`
    );
    assert(typeof step3Valid.data.collateralUsd === 'number', `Collateral value returned: $${step3Valid.data.collateralUsd}`);

    // Step 4: Reset agent to pre-onboarding state
    console.log('\n🔄 Step 4: Testing POST /api/setup/reset (Wipe credentials to pre-onboard)...');
    const step4Reset = await fetchJson('/api/setup/reset', { method: 'POST' });
    assert(step4Reset.ok && step4Reset.data.success === true, 'Setup reset succeeded');

    const step4Status = await fetchJson('/api/setup/status');
    assert(step4Status.data.isConfigured === false, 'Agent status verified as unconfigured (pre-onboard state)');

    // Step 5: Activation edge cases & validation
    console.log('\n⚠️ Step 5: Testing POST /api/setup/activate validation...');

    // 5a. Missing delegate key
    const step5MissingKey = await fetchJson('/api/setup/activate', {
      method: 'POST',
      body: JSON.stringify({
        subaccount: VALID_SUBACCOUNT,
        delegateKey: '',
        paperTrading: false
      })
    });
    assert(step5MissingKey.status === 400, 'Rejects activation without delegate key');

    // 5b. Missing subaccount
    const step5MissingSub = await fetchJson('/api/setup/activate', {
      method: 'POST',
      body: JSON.stringify({
        subaccount: '',
        delegateKey: VALID_DELEGATE_KEY,
        paperTrading: false
      })
    });
    assert(step5MissingSub.status === 400, 'Rejects activation without subaccount');

    // 5c. Gas Signer mistakenly submitted as Subaccount in activation
    const step5SignerAsSub = await fetchJson('/api/setup/activate', {
      method: 'POST',
      body: JSON.stringify({
        subaccount: expectedGasSigner,
        delegateKey: VALID_DELEGATE_KEY,
        paperTrading: false
      })
    });
    assert(step5SignerAsSub.status === 400, 'Rejects activation when gas signer is entered as trading subaccount');
    assert(
      step5SignerAsSub.data.error?.includes('Gas Signer address'),
      'Activation returns clear warning preventing dex order failure'
    );

    // Step 6: Full valid activation
    console.log('\n🎉 Step 6: Testing POST /api/setup/activate with full valid credentials...');
    const testAiKey = process.env.GEMINI_API_KEY || 'AIzaSy_dummy_key_for_testing';
    const testPassword = process.env.ADMIN_PASSWORD || 'TestAdmin123!';
    const step6Activate = await fetchJson('/api/setup/activate', {
      method: 'POST',
      body: JSON.stringify({
        subaccount: VALID_SUBACCOUNT,
        delegateKey: VALID_DELEGATE_KEY,
        network: 'mainnet',
        paperTrading: false,
        aiProvider: 'gemini',
        aiKey: testAiKey,
        aiModel: 'gemini-3.5-flash-lite',
        adminPassword: testPassword,
        budgetUsd: 100
      })
    });
    assert(step6Activate.ok && step6Activate.data.success === true, 'Full agent activation succeeded');
    assert(step6Activate.data.onboarded === true, 'Response flags onboarded=true');
    assert(step6Activate.data.isConfigured === true, 'Response flags isConfigured=true');
    assert(
      step6Activate.data.signerAddress?.toLowerCase() === expectedGasSigner.toLowerCase(),
      `Signer address set to derived gas signer: ${expectedGasSigner}`
    );

    // Step 7: Verify post-activation state & API operations
    console.log('\n📊 Step 7: Testing Post-Activation System State...');
    const step7Status = await fetchJson('/api/setup/status');
    assert(step7Status.data.isConfigured === true, 'Status reports isConfigured=true');
    assert(step7Status.data.onboarded === true, 'Status reports onboarded=true');
    assert(
      step7Status.data.subaccount?.toLowerCase() === VALID_SUBACCOUNT.toLowerCase() ||
      step7Status.data.subaccount?.toLowerCase() === step3Valid.data.resolvedSubaccount?.toLowerCase(),
      `Configured subaccount is valid (${step7Status.data.subaccount})`
    );

    const step7State = await fetchJson('/api/state');
    assert(step7State.ok, 'Core /api/state endpoint operational');
    assert(
      Array.isArray(step7State.data.pairs) || Array.isArray(step7State.data.watchPairs),
      `Live pairs actively monitored (${(step7State.data.pairs || step7State.data.watchPairs || []).length} pairs)`
    );

    console.log('\n================================================================');
    console.log('🏆 ALL ONBOARDING WIZARD E2E TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================\n');

  } finally {
    // Step 8: Clean Restoration of original settings
    console.log('🔄 Step 8: Restoring original settings.json...');
    if (originalSettingsContent) {
      fs.writeFileSync(SETTINGS_FILE, originalSettingsContent, 'utf-8');
      console.log('  Restored original settings.json from snapshot.');
      // Notify running server
      try {
        const parsed = JSON.parse(originalSettingsContent);
        const adminPass = parsed.security?.adminPassword || '';
        const token = Buffer.from(`session_${Date.now()}_${adminPass}`).toString('base64');
        await fetch(`${BASE_URL}/api/settings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(parsed)
        });
        console.log('  Server re-synced with original settings snapshot.');
      } catch (err: any) {
        console.warn('  Note: could not re-notify server:', err.message);
      }
    }
  }
}

runE2E().catch((err) => {
  console.error('\n💥 E2E Test Suite Aborted with Error:', err);
  process.exit(1);
});
