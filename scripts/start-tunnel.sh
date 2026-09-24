#!/usr/bin/env bash
set -euo pipefail

TARGET_HOST="jetson"

echo "Checking SSH tunnel to Jetson..."
if ! lsof -i :3000 >/dev/null 2>&1; then
  echo "Opening Dashboard tunnel (localhost:3000 -> Jetson:3000)..."
  ssh -f -N -L 3000:localhost:3000 "$TARGET_HOST"
fi

if ! lsof -i :11434 >/dev/null 2>&1; then
  echo "Opening Ollama tunnel (localhost:11434 -> Jetson:11434)..."
  ssh -f -N -L 11434:localhost:11434 "$TARGET_HOST"
fi

echo "Tunnels active:"
echo "- Dashboard: http://localhost:3000"
echo "- Ollama AI: http://localhost:11434"
