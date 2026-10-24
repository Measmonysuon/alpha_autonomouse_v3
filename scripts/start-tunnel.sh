#!/usr/bin/env bash
set -euo pipefail

TARGET_HOST="jetson"

echo "Checking SSH tunnel to Jetson..."
if ! lsof -i :3000 >/dev/null 2>&1; then
  echo "Opening Dashboard tunnel (localhost:3000 -> Jetson:3000)..."
  ssh -f -N -L 3000:127.0.0.1:3000 "$TARGET_HOST"
fi

if ! lsof -i :11434 >/dev/null 2>&1; then
  echo "Opening Ollama tunnel (localhost:11434 -> Jetson:11434)..."
  ssh -f -N -L 11434:127.0.0.1:11434 "$TARGET_HOST"
fi

if ! lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Opening Sim Agentic Dashboard tunnel (localhost:4000 -> Jetson:4000)..."
  ssh -f -N -L 4000:127.0.0.1:4000 "$TARGET_HOST"
fi

if ! lsof -nP -iTCP:5050 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Client V3 (localhost:5050 -> Jetson:5050)..."
  ssh -f -N -L 5050:127.0.0.1:5050 "$TARGET_HOST"
fi

if ! lsof -nP -iTCP:8005 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Opening Kronos Foundation Engine tunnel (localhost:8005 -> Jetson:8005)..."
  ssh -f -N -L 8005:127.0.0.1:8005 "$TARGET_HOST"
fi

echo "Tunnels active:"
echo "- Live Dashboard:  http://localhost:3000"
echo "- Live Client V3:  http://localhost:5050"
echo "- Sim Dashboard:   http://localhost:4000"
echo "- Kronos Bridge:   http://localhost:8005/health"
echo "- Ollama AI:       http://localhost:11434"
