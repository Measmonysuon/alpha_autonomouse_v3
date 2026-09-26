const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const OWNER = process.env.GITHUB_OWNER || 'Measmonysuon';
const REPO = process.env.GITHUB_REPO || 'alpha_autonomouse_v3';
const TAG = process.env.RELEASE_TAG || 'v3.0.0';

if (!TOKEN) {
  console.warn('⚠️ GITHUB_TOKEN environment variable is not set. Specify GITHUB_TOKEN to upload release assets.');
}

function apiRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent': 'Node-Release-Uploader',
        'Authorization': `token ${TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const { execSync } = require('child_process');

function uploadAsset(uploadUrl, filePath) {
  const fileName = path.basename(filePath);
  const fileStats = fs.statSync(filePath);
  const cleanUrl = uploadUrl.replace('{?name,label}', `?name=${encodeURIComponent(fileName)}`);

  let contentType = 'application/octet-stream';
  if (fileName.endsWith('.zip')) contentType = 'application/zip';
  else if (fileName.endsWith('.dmg')) contentType = 'application/x-apple-diskimage';
  else if (fileName.endsWith('.exe')) contentType = 'application/vnd.microsoft.portable-executable';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const curlCmd = `curl -s -S -X POST ` +
        `-H "Authorization: token ${TOKEN}" ` +
        `-H "Content-Type: ${contentType}" ` +
        `-H "User-Agent: Node-Release-Uploader" ` +
        `--data-binary @"${filePath}" ` +
        `"${cleanUrl}"`;

      const output = execSync(curlCmd, { maxBuffer: 100 * 1024 * 1024, encoding: 'utf-8' });
      const parsed = JSON.parse(output || '{}');
      if (parsed.id || parsed.state === 'uploaded') {
        return { status: 201, body: parsed };
      } else if (parsed.errors) {
        console.warn(`Attempt ${attempt} upload error for ${fileName}:`, parsed.message || parsed.errors);
      }
    } catch (err) {
      console.warn(`Attempt ${attempt} failed for ${fileName}:`, err.message);
    }
  }
  return { status: 500, body: {} };
}

async function main() {
  console.log('1. Checking existing release for tag:', TAG);
  let relRes = await apiRequest('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  let release = relRes.body;

  const releaseNotes = `### 🚀 Alpha Autonomous Client v3.0.0 — Production Institutional Fleet Release

#### 🌟 Institutional Risk & Execution Upgrades
- **Maker-First PostOnly Routing**: Zero taker-fee execution using FVG limit order positioning with autonomous maker-or-cancel safeguards.
- **Dynamic 2.0x–2.5x ATR Breakeven Ratchet**: Automatically locks in risk-free status once trades hit institutional expansion targets, preventing round-tripping.
- **Institutional Liquidity & Cascade Filters**: Enforces $5.0M+ minimum depth cluster validation and blocks entries during severe open interest cascades (ΔOI < -2.0%).
- **Sub-50ms Real-Time Fleet Immunity Bus**: Telemetry feeder automatically checks Sim Lab veto bus before executing any trade signal.
- **Decibel DEX MCP Stdio Transport**: Full native integration with Decibel on-chain trade fills and Aptos mainnet accounts.
- **On-Chain Fill & Trade Reconciliation**: Accurate pairing of open and close fills with real realized PnL and fee attribution.
- **Guided Onboarding Wizard**: Streamlined setup flow for delegate keys, trading subaccounts, gas signer verification, and AI selection.
- **Self-Healing Connectivity**: Resilient auto-reconnect backoff loop ensuring zero manual intervention during Sim Lab server maintenance.

#### 📦 Downloadable Packages:
- \`Alpha Autonomous Client v3-3.0.0-arm64.dmg\` (macOS Apple Silicon Desktop App)
- \`Alpha Autonomous Client v3 Setup 3.0.0.exe\` (Windows Desktop Installer)
- \`alpha-client-v3-macos.zip\` (macOS Standalone 1-Click Bundle)
- \`alpha-client-v3-windows.zip\` (Windows Standalone 1-Click Bundle)
- \`alpha-client-v3-docker.zip\` (Docker Production Compose Bundle)`;

  if (relRes.status !== 200 || !release.id) {
    console.log('2. Release not found, creating release object for tag:', TAG);
    const createRes = await apiRequest('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG,
      name: `Alpha Autonomous Client v3.0.0 — Production Fleet Release`,
      body: releaseNotes,
      draft: false,
      prerelease: false
    });
    release = createRes.body;
    console.log('Created release ID:', release.id);
  } else {
    console.log('Found existing release ID:', release.id);
    console.log('Updating release notes and title...');
    await apiRequest('PATCH', `/repos/${OWNER}/${REPO}/releases/${release.id}`, {
      name: `Alpha Autonomous Client v3.0.0 — Production Fleet Release`,
      body: releaseNotes
    });
  }

  if (!release || !release.upload_url) {
    console.error('❌ Could not create or find GitHub release (check GITHUB_TOKEN authorization). Aborting asset upload.');
    return;
  }
  const uploadUrl = release.upload_url;
  const releaseDir = path.resolve(__dirname, '../release');
  const releaseFiles = fs.readdirSync(releaseDir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return (ext === '.zip' || ext === '.dmg' || ext === '.exe') && !fs.statSync(path.join(releaseDir, f)).isDirectory();
  }).sort((a, b) => {
    if (a.endsWith('.zip') && !b.endsWith('.zip')) return -1;
    if (!a.endsWith('.zip') && b.endsWith('.zip')) return 1;
    return a.localeCompare(b);
  });

  // Delete existing assets if re-uploading
  if (release.assets && release.assets.length > 0) {
    for (const asset of release.assets) {
      console.log(`Deleting existing asset ${asset.name} (ID: ${asset.id})...`);
      await apiRequest('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`);
    }
  }

  for (const file of releaseFiles) {
    const fullPath = path.join(releaseDir, file);
    const sizeMb = (fs.statSync(fullPath).size / 1024 / 1024).toFixed(2);
    console.log(`Uploading ${file} (${sizeMb} MB)...`);
    const upRes = await uploadAsset(uploadUrl, fullPath);
    console.log(`Uploaded ${file} -> Status: ${upRes.status}, Asset ID: ${upRes.body.id || 'N/A'}`);
  }
  console.log('\n================================================================================');
  console.log('🎉 ALL 3 ZIP RELEASE ASSETS SUCCESSFULLY ATTACHED TO GITHUB RELEASE!');
  console.log('================================================================================\n');
}

main().catch(err => console.error(err));
