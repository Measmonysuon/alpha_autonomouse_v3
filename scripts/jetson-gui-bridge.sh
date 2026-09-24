#!/bin/bash
# Jetson Orin Nano GUI Bridge Controller
# Runs inside lightweight bridge container with host systemd access
# Monitors /data/gui_cmd and reports live status to /data/gui_status.json

echo "[jetson-gui-bridge] Starting Jetson GUI Controller daemon..."

while true; do
  STATUS=$(chroot /host systemctl is-active gdm3 2>/dev/null | head -n 1 | tr -d '\r\n' || echo "inactive")
  TARGET=$(chroot /host systemctl get-default 2>/dev/null | head -n 1 | tr -d '\r\n' || echo "unknown")
  [ -z "$STATUS" ] && STATUS="inactive"
  
  if [ "$STATUS" = "active" ]; then
    IS_ACTIVE="true"
  else
    IS_ACTIVE="false"
  fi

  cat <<EOF > /data/gui_status.tmp
{
  "active": $IS_ACTIVE,
  "status": "$STATUS",
  "target": "$TARGET",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  mv /data/gui_status.tmp /data/gui_status.json

  if [ -f /data/gui_cmd ]; then
    CMD=$(cat /data/gui_cmd | tr -d ' \n\r')
    rm -f /data/gui_cmd
    echo "[jetson-gui-bridge] Received command: $CMD"

    if [ "$CMD" = "start" ] || [ "$CMD" = "enable" ] || [ "$CMD" = "on" ]; then
      echo "[jetson-gui-bridge] Enabling GUI (graphical.target + gdm3)..."
      chroot /host systemctl set-default graphical.target 2>/dev/null
      chroot /host systemctl isolate graphical.target 2>/dev/null
      chroot /host systemctl start gdm3 2>/dev/null
    elif [ "$CMD" = "stop" ] || [ "$CMD" = "disable" ] || [ "$CMD" = "off" ]; then
      echo "[jetson-gui-bridge] Disabling GUI (multi-user.target + gdm3)..."
      chroot /host systemctl set-default multi-user.target 2>/dev/null
      chroot /host systemctl isolate multi-user.target 2>/dev/null
      chroot /host systemctl stop gdm3 2>/dev/null
    fi

    sleep 1
    STATUS=$(chroot /host systemctl is-active gdm3 2>/dev/null | head -n 1 | tr -d '\r\n' || echo "inactive")
    TARGET=$(chroot /host systemctl get-default 2>/dev/null | head -n 1 | tr -d '\r\n' || echo "unknown")
    [ -z "$STATUS" ] && STATUS="inactive"
    if [ "$STATUS" = "active" ]; then
      IS_ACTIVE="true"
    else
      IS_ACTIVE="false"
    fi
    cat <<EOF > /data/gui_status.tmp
{
  "active": $IS_ACTIVE,
  "status": "$STATUS",
  "target": "$TARGET",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    mv /data/gui_status.tmp /data/gui_status.json
  fi

  sleep 1.5
done
