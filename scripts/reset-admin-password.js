#!/usr/bin/env node
/**
 * reset-admin-password.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Clears (or resets) the admin password stored in data/settings.json.
 *
 * Usage:
 *   LOCAL:   node scripts/reset-admin-password.js
 *   DOCKER:  docker exec alpha-client-v2 node scripts/reset-admin-password.js
 *
 * After running, restart the container / server, then set a new password
 * in Settings → Security.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');
const rl   = require('readline');

const SETTINGS_PATH = path.resolve(__dirname, '..', 'data', 'settings.json');

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

function saveSettings(data) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

const iface = rl.createInterface({ input: process.stdin, output: process.stdout });

console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║          ALPHA CLIENT v2 — ADMIN PASSWORD RESET             ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

const settings = loadSettings();
const currentPwd = settings?.security?.adminPassword;

if (!currentPwd || currentPwd.trim() === '') {
  console.log('ℹ️  No admin password is currently set. Nothing to reset.');
  iface.close();
  process.exit(0);
}

console.log('⚠️  This will clear the admin password and allow unrestricted access.');
console.log('    After resetting, set a new password in Settings → Security.');
console.log('');

iface.question('Type "RESET" to confirm: ', (answer) => {
  iface.close();
  if (answer.trim() !== 'RESET') {
    console.log('');
    console.log('❌ Reset cancelled (you did not type RESET exactly).');
    process.exit(0);
  }

  // Clear the password
  if (!settings.security) settings.security = {};
  settings.security.adminPassword = '';
  settings.updatedAt = Date.now();
  saveSettings(settings);

  console.log('');
  console.log('✅ Admin password has been cleared successfully.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart the trading agent (or the Docker container):');
  console.log('       docker restart alpha-client-v2');
  console.log('  2. Open the dashboard and go to Settings → Security');
  console.log('  3. Set a new Admin Master Password');
  console.log('');
});
