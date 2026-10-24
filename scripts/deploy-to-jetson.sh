#!/usr/bin/env bash
set -euo pipefail

TARGET_HOST="jetson"
TARGET_IP="192.168.100.21"
REMOTE_DIR="/home/measmony/trading-ai-stack/bots/alpha-client-v3"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Decibel Trading Agent V3 -> Jetson Orin Nano Deployment ==="
echo "Local workspace:  $LOCAL_DIR"
echo "Target host:      $TARGET_HOST ($TARGET_IP)"
echo "Remote directory: $REMOTE_DIR"

# 1. Check network connectivity
echo "--> Checking network connectivity to $TARGET_HOST..."
if ! ssh -o ConnectTimeout=20 "$TARGET_HOST" "echo 'SSH connection OK'" >/dev/null 2>&1; then
  echo "ERROR: Cannot establish SSH connection to $TARGET_HOST."
  exit 1
fi

# 2. Ensure remote target directory exists
echo "--> Preparing remote directories..."
ssh "$TARGET_HOST" "mkdir -p $REMOTE_DIR/logs $REMOTE_DIR/data $REMOTE_DIR/dist $REMOTE_DIR/dashboard"

# 3. Build local TypeScript bundle before deployment
echo "--> Compiling TypeScript locally..."
(cd "$LOCAL_DIR" && npm run build)

# 4. Sync source code, dist, and dashboard to Jetson (safeguarding database and logs)
echo "--> Syncing codebase and dist to Jetson..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.gemini' \
  --exclude 'release/' \
  --exclude 'scratch/' \
  --exclude '*.log' \
  --exclude 'logs/' \
  --exclude 'data/' \
  --exclude 'logs*' \
  --exclude 'data*' \
  --exclude '*.db*' \
  --exclude '*.sqlite*' \
  "$LOCAL_DIR/" "$TARGET_HOST:$REMOTE_DIR/"

echo "--> Syncing authoritative decibel-markets.json..."
rsync -avz "$LOCAL_DIR/data/decibel-markets.json" "$TARGET_HOST:$REMOTE_DIR/data/decibel-markets.json"

# 5. Stop previous instance if running
echo "--> Stopping previous instance if running..."
ssh "$TARGET_HOST" "docker rm -f alpha-client-v3 2>/dev/null || true"

# 6. Launch service with --network host and restart: unless-stopped
echo "--> Launching persistent 24/7 container on Jetson (Port 5050)..."
ssh "$TARGET_HOST" "docker run -d \
  --name alpha-client-v3 \
  --restart unless-stopped \
  --network host \
  --env-file $REMOTE_DIR/.env \
  -e HEALTH_PORT=5050 \
  -e PORT=5050 \
  -e NODE_ENV=production \
  -e SIM_PIPELINE_URL=http://127.0.0.1:4000/api/pipeline/alpha-bundle \
  -e SIM_TELEMETRY_URL=http://127.0.0.1:4000/api/pipeline/telemetry \
  -e SIM_PIPELINE_FALLBACK_URL=https://simlab.measmony.me/api/pipeline/alpha-bundle \
  -e SIM_TELEMETRY_FALLBACK_URL=https://simlab.measmony.me/api/pipeline/telemetry \
  -e SIMLAB_SERVER_URL=http://127.0.0.1:4000 \
  -e OLLAMA_BASE_URL=http://127.0.0.1:11434 \
  -v $REMOTE_DIR/logs:/app/logs \
  -v $REMOTE_DIR/data:/app/data \
  -v $REMOTE_DIR/dist:/app/dist \
  -v $REMOTE_DIR/dashboard:/app/dashboard \
  alpha-client-v3:arm64 node dist/index.js"

# 7. Verify container status and health
echo "--> Checking container status on Jetson..."
sleep 5
ssh "$TARGET_HOST" "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' --filter name=alpha-client-v3"

echo ""
echo "=== Deployment Successful ==="
echo "Client V3 Dashboard: http://$TARGET_IP:5050"
echo "Sim Lab Dashboard:   http://$TARGET_IP:4000"
echo "Client V1 Dashboard: http://$TARGET_IP:3000"
echo "Ollama API (host):       http://$TARGET_IP:11434"
