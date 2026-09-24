#!/usr/bin/env bash
# ==============================================================================
# Decibel Trading Agent - Jetson Rollback Engine
#
# Purpose: Restores a previous working snapshot on Jetson Orin Nano.
#
# Usage:
#   npm run rollback
#   ./scripts/rollback-jetson.sh [backup_tag]
# ==============================================================================

set -euo pipefail

TARGET_HOST="jetson"
TARGET_IP="192.168.100.21"
REMOTE_APP_DIR="/home/measmony/trading-ai-stack/bots/decibel-trading-agent"
REMOTE_BACKUP_BASE="/home/measmony/trading-ai-stack/bots/backups"

echo "=== Decibel Trading Agent -> Jetson Rollback System ==="

# Check SSH connection
if ! ssh -o ConnectTimeout=8 "$TARGET_HOST" "echo 'SSH_OK'" >/dev/null 2>&1; then
  echo "ERROR: Cannot reach Jetson at $TARGET_IP."
  exit 1
fi

SPECIFIED_TAG="${1:-}"

if [ -z "$SPECIFIED_TAG" ]; then
  echo "--> Available backups on Jetson ($REMOTE_BACKUP_BASE):"
  ssh "$TARGET_HOST" "ls -1dt $REMOTE_BACKUP_BASE/decibel-agent_* 2>/dev/null | xargs -n 1 basename || echo 'None found'"
  echo ""
  
  LATEST_BACKUP=$(ssh "$TARGET_HOST" "ls -1dt $REMOTE_BACKUP_BASE/decibel-agent_* 2>/dev/null | head -n 1 | xargs -n 1 basename || true")
  if [ -z "$LATEST_BACKUP" ]; then
    echo "No remote backups found on Jetson."
    exit 1
  fi

  echo "Defaulting to latest backup: $LATEST_BACKUP"
  RESTORE_DIR="$REMOTE_BACKUP_BASE/$LATEST_BACKUP"
  TAG_NAME="${LATEST_BACKUP#decibel-agent_}"
else
  RESTORE_DIR="$REMOTE_BACKUP_BASE/decibel-agent_$SPECIFIED_TAG"
  if ! ssh "$TARGET_HOST" "[ -d '$RESTORE_DIR' ]"; then
    # Try direct name
    RESTORE_DIR="$REMOTE_BACKUP_BASE/$SPECIFIED_TAG"
    if ! ssh "$TARGET_HOST" "[ -d '$RESTORE_DIR' ]"; then
      echo "ERROR: Backup directory not found: $RESTORE_DIR"
      exit 1
    fi
  fi
  TAG_NAME="$SPECIFIED_TAG"
fi

echo "--> Restoring from: $RESTORE_DIR"

# 1. Stop current container
echo "--> Stopping running container..."
ssh "$TARGET_HOST" "docker rm -f decibel-trading-agent 2>/dev/null || true"

# 2. Restore data, dist, dashboard, scripts, env
echo "--> Restoring backed-up files to $REMOTE_APP_DIR..."
ssh "$TARGET_HOST" "bash -c '
  set -e
  [ -d \"$RESTORE_DIR/dist\" ] && cp -rf \"$RESTORE_DIR/dist\" \"$REMOTE_APP_DIR/\"
  [ -d \"$RESTORE_DIR/dashboard\" ] && cp -rf \"$RESTORE_DIR/dashboard\" \"$REMOTE_APP_DIR/\"
  [ -d \"$RESTORE_DIR/scripts\" ] && cp -rf \"$RESTORE_DIR/scripts\" \"$REMOTE_APP_DIR/\"
  [ -d \"$RESTORE_DIR/data\" ] && cp -rf \"$RESTORE_DIR/data\" \"$REMOTE_APP_DIR/\"
  [ -f \"$RESTORE_DIR/.env\" ] && cp -f \"$RESTORE_DIR/.env\" \"$REMOTE_APP_DIR/.env\"
'"

# 3. Check if tagged docker image exists
IMAGE_TO_RUN="decibel-trading-agent:arm64"
HAS_BACKUP_IMG=$(ssh "$TARGET_HOST" "docker images -q decibel-trading-agent:backup_${TAG_NAME} 2>/dev/null || true")

if [ -n "$HAS_BACKUP_IMG" ]; then
  IMAGE_TO_RUN="decibel-trading-agent:backup_${TAG_NAME}"
  echo "--> Using preserved Docker image: $IMAGE_TO_RUN"
else
  echo "--> Using base Docker image: $IMAGE_TO_RUN"
fi

# 4. Relaunch container
echo "--> Relaunching restored container..."
ssh "$TARGET_HOST" "docker run -d \
  --name decibel-trading-agent \
  --restart unless-stopped \
  --network host \
  --env-file $REMOTE_APP_DIR/.env \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e OLLAMA_BASE_URL=http://127.0.0.1:11434 \
  -v $REMOTE_APP_DIR/logs:/app/logs \
  -v $REMOTE_APP_DIR/data:/app/data \
  -v $REMOTE_APP_DIR/dist:/app/dist \
  -v $REMOTE_APP_DIR/dashboard:/app/dashboard \
  $IMAGE_TO_RUN"

sleep 4
ssh "$TARGET_HOST" "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep decibel-trading-agent"

echo ""
echo "=== Rollback to $TAG_NAME Completed Successfully ==="
echo "Dashboard running at: http://$TARGET_IP:3000"
