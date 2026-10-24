#!/usr/bin/env bash
set -euo pipefail

TARGET_HOST="jetson"
REMOTE_DIR="/home/measmony/trading-ai-stack/bots/alpha-client-v3"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Switching Client V3 from Mac Studio -> Jetson ==="

# 1. Stop container on Mac to flush SQLite WAL safely
echo "--> 1. Pausing alpha-client-v3 on Mac..."
docker stop alpha-client-v3 2>/dev/null || true

# 2. Sync database, trades, and settings from Mac to Jetson
echo "--> 2. Syncing updated trading database & settings to Jetson..."
rsync -avz --exclude '*.shm' --exclude '*.wal' \
  "$LOCAL_DIR/data/" "$TARGET_HOST:$REMOTE_DIR/data/"

# 3. Resume container on Jetson
echo "--> 3. Resuming alpha-client-v3 container on Jetson..."
ssh "$TARGET_HOST" "docker start alpha-client-v3"

echo ""
echo "✅ Client V3 is now running 24/7 on Jetson (http://measmony-desktop.local:5050)"
echo "⏸️  Mac instance is paused."
