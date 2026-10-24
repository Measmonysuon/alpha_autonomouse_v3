#!/usr/bin/env bash
set -euo pipefail

TARGET_HOST="jetson"
REMOTE_DATA="/home/measmony/trading-ai-stack/bots/alpha-client-v3/data"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Switching Client V3 from Jetson -> Mac Studio ==="

# 1. Stop container on Jetson to flush SQLite WAL safely
echo "--> 1. Pausing alpha-client-v3 on Jetson..."
ssh "$TARGET_HOST" "docker stop alpha-client-v3 || true"

# 2. Sync database, trades, and settings from Jetson to Mac
echo "--> 2. Syncing updated trading database & settings from Jetson to Mac..."
rsync -avz --exclude '*.shm' --exclude '*.wal' \
  "$TARGET_HOST:$REMOTE_DATA/" "$LOCAL_DIR/data/"

# 3. Start local container on Mac
echo "--> 3. Starting alpha-client-v3 container on Mac Studio..."
cd "$LOCAL_DIR"
docker start alpha-client-v3 2>/dev/null || docker compose up -d

echo ""
echo "✅ Client V3 is now running on your Mac Studio (http://localhost:5050)"
echo "⏸️  Jetson instance is paused."
