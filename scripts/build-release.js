/**
 * Release Packager Script for Alpha Autonomous Client v2
 * 
 * Automatically builds and bundles:
 *  1. macOS Release Bundle (with 1-click start-macos.command launcher)
 *  2. Windows Release Bundle (with 1-click start-windows.bat launcher)
 *  3. Docker Production Release (with 1-click docker-compose.yml)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');

console.log('================================================================================');
console.log('🚀 ALPHA CLIENT V3 — RELEASE BUILD & PACKAGING ENGINE');
console.log('================================================================================\n');

// 1. Compile TypeScript
console.log('📦 Step 1: Compiling TypeScript codebase to dist/...');
try {
  execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });
  console.log('✅ Compilation successful.\n');
} catch (err) {
  console.error('❌ Compilation failed:', err.message);
  process.exit(1);
}

// 2. Prepare Release Directories
console.log('📂 Step 2: Preparing release directories...');
fs.mkdirSync(RELEASE_DIR, { recursive: true });

const MAC_DIR = path.join(RELEASE_DIR, 'alpha-client-v3-macos');
const WIN_DIR = path.join(RELEASE_DIR, 'alpha-client-v3-windows');
const DOCKER_DIR = path.join(RELEASE_DIR, 'alpha-client-v3-docker');

[MAC_DIR, WIN_DIR, DOCKER_DIR].forEach((dir) => {
  if (fs.existsSync(dir)) {
    try {
      execSync(`rm -rf "${dir}"`, { stdio: 'ignore' });
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  fs.mkdirSync(dir, { recursive: true });
});

// Helper: Copy directory recursively
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Core assets to include in every package
const coreItems = [
  'dist',
  'dashboard',
  'ecosystem.config.js',
  'package.json',
  '.env.example',
  'README.md',
];

// Clean template data directory (pre-onboard state)
function createCleanDataDir(targetDir) {
  const dataDir = path.join(targetDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify(
      {
        credentials: { decibelDelegateKey: '', decibelSubaccount: '', network: 'mainnet' },
        decibelSubaccount: '',
        decibelPrivateKey: '',
        decibelNetwork: 'mainnet',
        ai: { provider: 'gemini', geminiApiKey: '', ollamaBaseUrl: 'http://localhost:11434' },
        budgetUsd: 30,
        trading: { budgetUsd: 30, paperTrading: false },
        isConfigured: false,
        onboarded: false,
        updatedAt: 0,
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dataDir, 'trades.json'),
    JSON.stringify({ trades: [], shadowTrades: [], lastUpdated: 0 }, null, 2),
    'utf8'
  );
}

// ── 3. Build macOS Package ───────────────────────────────────────────────────
console.log('🍎 Step 3: Packaging macOS Standalone Bundle...');
coreItems.forEach((item) => {
  const src = path.join(ROOT_DIR, item);
  const dest = path.join(MAC_DIR, item);
  if (fs.statSync(src).isDirectory()) copyDir(src, dest);
  else fs.copyFileSync(src, dest);
});
createCleanDataDir(MAC_DIR);

// macOS 1-click launcher
const macLauncher = `#!/bin/bash
cd "$(dirname "$0")"

echo "================================================================================"
echo "  DECIBEL DEX AUTONOMOUS TRADING AGENT (MAC CLIENT V3)"
echo "================================================================================"

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed! Please install Node.js 20+ from https://nodejs.org"
    read -p "Press Enter to exit..."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "📦 First time launch: Installing dependencies..."
    npm install --omit=dev
fi

echo "🚀 Launching Alpha Autonomous Client on port 5050..."
export HEALTH_PORT=5050
export PORT=5050
(sleep 2 && open "http://localhost:5050") &
node dist/index.js
`;
fs.writeFileSync(path.join(MAC_DIR, 'start-macos.command'), macLauncher, 'utf8');
fs.chmodSync(path.join(MAC_DIR, 'start-macos.command'), '755');

// ── 4. Build Windows Package ─────────────────────────────────────────────────
console.log('🪟 Step 4: Packaging Windows Standalone Bundle...');
coreItems.forEach((item) => {
  const src = path.join(ROOT_DIR, item);
  const dest = path.join(WIN_DIR, item);
  if (fs.statSync(src).isDirectory()) copyDir(src, dest);
  else fs.copyFileSync(src, dest);
});
createCleanDataDir(WIN_DIR);

// Windows 1-click launcher
const winLauncher = `@echo off
cd /d "%~dp0"
title Decibel DEX Autonomous Trading Agent v3

echo ================================================================================
echo   DECIBEL DEX AUTONOMOUS TRADING AGENT (WINDOWS CLIENT V3)
echo ================================================================================

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed! Please install Node.js 20+ from https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] First time launch: Installing dependencies...
    call npm install --omit=dev
)

echo [INFO] Launching Alpha Autonomous Client on port 5050...
set HEALTH_PORT=5050
set PORT=5050
start "" "http://localhost:5050"
node dist/index.js
pause
`;
fs.writeFileSync(path.join(WIN_DIR, 'start-windows.bat'), winLauncher, 'utf8');

// ── 5. Build Docker Package ──────────────────────────────────────────────────
console.log('🐳 Step 5: Packaging Docker Production Bundle...');
coreItems.forEach((item) => {
  const src = path.join(ROOT_DIR, item);
  const dest = path.join(DOCKER_DIR, item);
  if (fs.statSync(src).isDirectory()) copyDir(src, dest);
  else fs.copyFileSync(src, dest);
});
fs.copyFileSync(path.join(ROOT_DIR, 'Dockerfile'), path.join(DOCKER_DIR, 'Dockerfile'));
fs.copyFileSync(path.join(ROOT_DIR, 'docker-compose.yml'), path.join(DOCKER_DIR, 'docker-compose.yml'));
createCleanDataDir(DOCKER_DIR);

// ── 6. Create Compressed Archives ────────────────────────────────────────────
console.log('🗜️ Step 6: Creating release zip archives...');
try {
  execSync(`zip -r -q "alpha-client-v3-macos.zip" "alpha-client-v3-macos"`, { cwd: RELEASE_DIR });
  execSync(`zip -r -q "alpha-client-v3-windows.zip" "alpha-client-v3-windows"`, { cwd: RELEASE_DIR });
  execSync(`zip -r -q "alpha-client-v3-docker.zip" "alpha-client-v3-docker"`, { cwd: RELEASE_DIR });
  console.log('✅ Created: release/alpha-client-v3-macos.zip');
  console.log('✅ Created: release/alpha-client-v3-windows.zip');
  console.log('✅ Created: release/alpha-client-v3-docker.zip');
} catch (err) {
  console.warn('⚠️ Zip utility not available, uncompressed release directories are ready.');
}

console.log('\n================================================================================');
console.log('🎉 ALL RELEASE PACKAGES BUILT SUCCESSFULLY IN: release/');
console.log('================================================================================\n');
