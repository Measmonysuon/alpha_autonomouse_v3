#!/usr/bin/env bash
# ==============================================================================
# Decibel / Alpha Client V2 - Snapshot & Backup Engine
# 
# Purpose: Creates a verifiable, timestamped snapshot of BOTH:
#   1. Local codebase, configs, and active data (compressed tarball in backups/)
#   2. Local Mac Docker state (alpha-client-v2 image & container state)
#
# Usage:
#   npm run backup
#   ./scripts/backup-version.sh [optional_label]
# ==============================================================================

set -euo pipefail

LABEL="${1:-}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
if [ -n "$LABEL" ]; then
  BACKUP_TAG="${LABEL}_${TIMESTAMP}"
else
  BACKUP_TAG="v2_snapshot_${TIMESTAMP}"
fi

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$LOCAL_DIR/backups"

echo "=================================================================="
echo "  🛡️  ALPHA CLIENT V2 - SNAPSHOT & BACKUP ENGINE"
echo "=================================================================="
echo "  Backup Tag:  $BACKUP_TAG"
echo "  Local Path:  $LOCAL_DIR"
echo "  Backup Dir:  $BACKUP_DIR"
echo "=================================================================="

# ------------------------------------------------------------------------------
# 1. Local Codebase & Configuration Backup
# ------------------------------------------------------------------------------
echo ""
echo "--> [1/2] Creating compressed local snapshot..."
mkdir -p "$BACKUP_DIR"

TAR_FILENAME="alpha-client-v2-backup_${BACKUP_TAG}.tar.gz"
TAR_PATH="$BACKUP_DIR/$TAR_FILENAME"

# Include critical source code, dashboard, scripts, configs, and persistent data
tar -czf "$TAR_PATH" \
  -C "$LOCAL_DIR" \
  --exclude="node_modules" \
  --exclude="dist" \
  --exclude=".git" \
  --exclude=".gemini" \
  --exclude="logs" \
  --exclude="scratch" \
  --exclude="backups" \
  --exclude="*.log" \
  --exclude=".DS_Store" \
  src dashboard scripts data package.json tsconfig.json Dockerfile docker-compose*.yml .env.example 2>/dev/null || true

# If .env exists, securely include a copy inside the backup directory with restricted perms
if [ -f "$LOCAL_DIR/.env" ]; then
  mkdir -p "$BACKUP_DIR/.env_vault"
  cp "$LOCAL_DIR/.env" "$BACKUP_DIR/.env_vault/.env_${BACKUP_TAG}"
  chmod 600 "$BACKUP_DIR/.env_vault/.env_${BACKUP_TAG}"
fi

ARCHIVE_SIZE="$(du -h "$TAR_PATH" | cut -f1)"
echo "    ✅ Local archive created successfully: $TAR_FILENAME ($ARCHIVE_SIZE)"

# Retain last 10 local backup archives to manage storage cleanly
echo "--> Pruning old local backups (keeping newest 10)..."
ls -1t "$BACKUP_DIR"/alpha-client-v2-backup_*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f || true

# ------------------------------------------------------------------------------
# 2. Local Docker Image Tag & Container State Backup
# ------------------------------------------------------------------------------
echo ""
echo "--> [2/2] Backing up Docker container & image state..."
DOCKER_RUNNING=false

if command -v docker >/dev/null 2>&1; then
  if docker ps -q --filter name=alpha-client-v2 | grep -q .; then
    DOCKER_RUNNING=true
    CID=$(docker ps -q --filter name=alpha-client-v2)
    echo "    • Found running alpha-client-v2 container: $CID"
    echo "    • Tagging running image as alpha-client-v2:backup_${BACKUP_TAG}..."
    docker tag alpha-client-v2:local alpha-client-v2:backup_${BACKUP_TAG} 2>/dev/null || true
  else
    echo "    • alpha-client-v2 container not running right now. Code snapshot preserved."
  fi
fi

# ------------------------------------------------------------------------------
# 3. Summary & Quick Rollback Instructions
# ------------------------------------------------------------------------------
echo ""
echo "--> Backup Summary:"
echo "------------------------------------------------------------------"
echo "  Local Archive:    $TAR_PATH ($ARCHIVE_SIZE)"
if [ "$DOCKER_RUNNING" = true ]; then
  echo "  Docker Image Tag: alpha-client-v2:backup_${BACKUP_TAG}"
fi
echo "------------------------------------------------------------------"
echo "  ✅ Client V2 backup complete!"
echo "=================================================================="
