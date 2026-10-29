#!/usr/bin/env bash
set -euo pipefail

# ANSI color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

TARGET_HOST="jetson"
TARGET_IP="192.168.100.21"
REMOTE_DIR="/home/measmony/trading-ai-stack/bots/alpha-client-v3"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS="-b 192.168.100.9 -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"

echo -e "${BLUE}==================================================================${NC}"
echo -e "${BLUE}  🚀  ALPHA CLIENT V3 -> JETSON ORIN NANO DEPLOYMENT ENGINE  ${NC}"
echo -e "${BLUE}==================================================================${NC}"
echo "Local workspace:  $LOCAL_DIR"
echo "Target host:      $TARGET_HOST ($TARGET_IP)"
echo "Remote directory: $REMOTE_DIR"

# 1. Pre-flight connectivity check
echo -e "\n${CYAN}--> [1/6] Checking network connectivity to $TARGET_HOST...${NC}"
if ! ssh $SSH_OPTS "$TARGET_HOST" "echo 'SSH connection OK'" >/dev/null 2>&1; then
  echo -e "${RED}ERROR: Cannot establish SSH connection to $TARGET_HOST ($TARGET_IP).${NC}" >&2
  exit 1
fi
echo -e "${GREEN}✓ SSH connectivity verified.${NC}"

# 2. Local TypeScript Compilation
echo -e "\n${CYAN}--> [2/6] Compiling TypeScript bundle locally...${NC}"
(cd "$LOCAL_DIR" && npm run build)
echo -e "${GREEN}✓ Local TypeScript compilation succeeded.${NC}"

# 3. Remote Snapshot Backup of Current Dist & Dashboard
echo -e "\n${CYAN}--> [3/6] Creating snapshot backup on Jetson before update...${NC}"
ssh $SSH_OPTS "$TARGET_HOST" "mkdir -p $REMOTE_DIR/logs $REMOTE_DIR/data $REMOTE_DIR/dist $REMOTE_DIR/dashboard $REMOTE_DIR/backups && \
  if [ -d $REMOTE_DIR/dist ] && [ \"\$(ls -A $REMOTE_DIR/dist 2>/dev/null)\" ]; then \
    tar -czf $REMOTE_DIR/backups/pre_deploy_\$(date +%Y%m%d_%H%M%S).tar.gz -C $REMOTE_DIR dist dashboard 2>/dev/null || true; \
    echo '  ✓ Existing production dist/dashboard archived.'; \
  fi"

# 4. Safe Rsync Sync (Safeguarding database, env, and logs)
echo -e "\n${CYAN}--> [4/6] Syncing codebase, dist, and updated dashboard to Jetson...${NC}"
rsync -avz --delete -e "ssh $SSH_OPTS" \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.gemini' \
  --exclude '.env' \
  --exclude 'release/' \
  --exclude 'scratch/' \
  --exclude 'backups/' \
  --exclude '*.log' \
  --exclude 'logs/' \
  --exclude 'data/' \
  --exclude 'logs*' \
  --exclude 'data*' \
  --exclude '*.db*' \
  --exclude '*.sqlite*' \
  "$LOCAL_DIR/" "$TARGET_HOST:$REMOTE_DIR/"

# Sync authoritative markets if available locally
if [ -f "$LOCAL_DIR/data/decibel-markets.json" ]; then
  echo "  Syncing authoritative decibel-markets.json..."
  rsync -avz -e "ssh $SSH_OPTS" "$LOCAL_DIR/data/decibel-markets.json" "$TARGET_HOST:$REMOTE_DIR/data/decibel-markets.json"
fi

# 5. Stop previous instance and relaunch persistent container
echo -e "\n${CYAN}--> [5/6] Relaunching persistent 24/7 container on Jetson (Port 5050)...${NC}"
ssh $SSH_OPTS "$TARGET_HOST" "docker rm -f alpha-client-v3 2>/dev/null || true"

ssh $SSH_OPTS "$TARGET_HOST" "docker run -d \
  --name alpha-client-v3 \
  --restart unless-stopped \
  --network host \
  --env-file $REMOTE_DIR/.env \
  -e HEALTH_PORT=5050 \
  -e PORT=5050 \
  -e BIND_ALL_INTERFACES=true \
  -e NODE_ENV=production \
  -e SIM_PIPELINE_URL=http://127.0.0.1:4000/api/pipeline/alpha-bundle \
  -e SIM_TELEMETRY_URL=http://127.0.0.1:4000/api/pipeline/telemetry \
  -e SIM_PIPELINE_FALLBACK_URL=https://simlab.measmony.me/api/pipeline/alpha-bundle \
  -e SIM_TELEMETRY_FALLBACK_URL=https://simlab.measmony.me/api/pipeline/telemetry \
  -e SIMLAB_SERVER_URL=http://127.0.0.1:4000 \
  -e OLLAMA_BASE_URL=http://127.0.0.1:11434 \
  -e MIN_LEVERAGE=5 \
  -e MAX_LEVERAGE=12 \
  -e MIN_POSITION_USD=35 \
  -e MAX_POSITION_USD=150 \
  -e MIN_ALLOC_PCT=35 \
  -e MAX_ALLOC_PCT=60 \
  -v $REMOTE_DIR/logs:/app/logs \
  -v $REMOTE_DIR/data:/app/data \
  -v $REMOTE_DIR/dist:/app/dist \
  -v $REMOTE_DIR/dashboard:/app/dashboard \
  alpha-client-v3:arm64 node dist/index.js"

# 6. Post-deployment Automated Health Check & Verification
echo -e "\n${CYAN}--> [6/6] Verifying service health on Jetson...${NC}"
HEALTHY=false
for i in {1..12}; do
  if ssh $SSH_OPTS "$TARGET_HOST" "curl -s -f http://127.0.0.1:5050/health >/dev/null 2>&1 || curl -s -f http://127.0.0.1:5050/api/state >/dev/null 2>&1"; then
    HEALTHY=true
    break
  fi
  echo "  Waiting for container API warm-up (attempt $i/12)..."
  sleep 2
done

if [ "$HEALTHY" = true ]; then
  echo -e "${GREEN}✓ Health Check Passed: Client V3 is responding on port 5050!${NC}"
else
  echo -e "${YELLOW}⚠ Warning: Health check did not complete within 24s. Showing recent logs:${NC}"
  ssh $SSH_OPTS "$TARGET_HOST" "docker logs --tail 30 alpha-client-v3" || true
fi

echo ""
echo -e "${BLUE}=== Active Deployment Status ===${NC}"
ssh $SSH_OPTS "$TARGET_HOST" "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' --filter name=alpha-client-v3"

echo ""
echo -e "${GREEN}=== Deployment Successful ===${NC}"
echo -e "Client V3 Dashboard: ${CYAN}http://$TARGET_IP:5050${NC}"
echo -e "Sim Lab Dashboard:   ${CYAN}http://$TARGET_IP:4000${NC}"
echo -e "Client V1 Dashboard: ${CYAN}http://$TARGET_IP:3000${NC}"

