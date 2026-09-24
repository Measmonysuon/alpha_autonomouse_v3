#!/usr/bin/env bash
set -euo pipefail

TARGET_HOST="jetson"
TARGET_IP="192.168.100.21"
REMOTE_DIR="/home/measmony/trading-ai-stack/bots/decibel-trading-agent"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Decibel Trading Agent -> Jetson Orin Nano Deployment ==="
echo "Local workspace:  $LOCAL_DIR"
echo "Target host:      $TARGET_HOST ($TARGET_IP)"
echo "Remote directory: $REMOTE_DIR"

# 1. Check network connectivity
echo "--> Checking network connectivity to $TARGET_IP..."
if ! ping -c 2 "$TARGET_IP" >/dev/null 2>&1; then
  echo "ERROR: Target node $TARGET_IP is not responding to ping."
  exit 1
fi

# 2. Check SSH authentication
echo "--> Verifying SSH access to $TARGET_HOST..."
if ! ssh -o ConnectTimeout=15 "$TARGET_HOST" "echo 'SSH connection OK'" >/dev/null 2>&1; then
  echo "ERROR: Cannot establish SSH connection to $TARGET_HOST."
  exit 1
fi

# 3. Ensure remote target directory exists
echo "--> Preparing remote directories..."
ssh "$TARGET_HOST" "mkdir -p $REMOTE_DIR/logs $REMOTE_DIR/data"

# 4. Automatic Pre-Deployment Backup of current version (Local + Jetson production state)
echo "--> [SAFETY FIRST] Creating backup of current version before deployment..."
bash "$LOCAL_DIR/scripts/backup-version.sh" "pre_deploy"

# 5. Build local TypeScript bundle before deployment
echo "--> Compiling TypeScript locally..."
npm run build

# 6. Sync source code and dist to Jetson (safeguarding database and logs)
echo "--> Syncing codebase and dist to Jetson..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.gemini' \
  --exclude '*.log' \
  --exclude 'logs/' \
  --exclude 'data/' \
  --exclude 'logs*' \
  --exclude 'data*' \
  --exclude '*.db*' \
  --exclude '*.sqlite*' \
  "$LOCAL_DIR/" "$TARGET_HOST:$REMOTE_DIR/"

# 6. Ensure GUI Bridge container is running
echo "--> Ensuring Jetson GUI Bridge container is running..."
ssh "$TARGET_HOST" "chmod +x $REMOTE_DIR/scripts/jetson-gui-bridge.sh && docker rm -f jetson-gui-bridge 2>/dev/null || true; docker run -d \
  --name jetson-gui-bridge \
  --restart unless-stopped \
  --pid host \
  -v /:/host \
  -v /run/systemd/system:/run/systemd/system \
  -v /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket \
  -v $REMOTE_DIR/data:/data \
  -v $REMOTE_DIR/scripts/jetson-gui-bridge.sh:/entrypoint.sh \
  ubuntu:22.04 /entrypoint.sh"

# 7. Stop previous instance if running
echo "--> Stopping previous instance if running..."
ssh "$TARGET_HOST" "docker rm -f decibel-trading-agent 2>/dev/null || true"

# 8. Launch service with --network host and restart: unless-stopped
echo "--> Launching persistent 24/7 container on Jetson..."
ssh "$TARGET_HOST" "docker run -d \
  --name decibel-trading-agent \
  --restart unless-stopped \
  --network host \
  --env-file $REMOTE_DIR/.env \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e OLLAMA_BASE_URL=http://127.0.0.1:11434 \
  -v $REMOTE_DIR/logs:/app/logs \
  -v $REMOTE_DIR/data:/app/data \
  -v $REMOTE_DIR/dist:/app/dist \
  -v $REMOTE_DIR/dashboard:/app/dashboard \
  decibel-trading-agent:arm64"

# 9. Verify container status and health
echo "--> Checking container status on Jetson..."
sleep 4
ssh "$TARGET_HOST" "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

echo ""
echo "=== Deployment Successful ==="
echo "Trading Agent Dashboard: http://$TARGET_IP:3000"
echo "Ollama API (host):       http://$TARGET_IP:11434"
