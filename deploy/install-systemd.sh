#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_USER="${2:-pi}"
APP_GROUP="${3:-$APP_USER}"
ENV_DIR="/etc/jacuzzi-solar"
ENV_FILE="$ENV_DIR/jacuzzi-solar.env"
SERVICE_FILE="/etc/systemd/system/jacuzzi-solar.service"
NODE_BIN=""

if [[ $EUID -ne 0 ]]; then
  echo "Run dit script met sudo: sudo bash deploy/install-systemd.sh [app_dir] [user] [group]"
  exit 1
fi

resolve_node_bin() {
  local user_node=""
  local user_home=""
  local nvm_node=""

  user_node="$(sudo -iu "$APP_USER" bash -lc 'command -v node 2>/dev/null || true')"
  if [[ -n "$user_node" ]]; then
    echo "$user_node"
    return
  fi

  user_home="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
  if [[ -z "$user_home" ]]; then
    user_home="/home/$APP_USER"
  fi

  nvm_node="$(ls -1d "$user_home"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "$nvm_node" ]]; then
    echo "$nvm_node"
    return
  fi

  command -v node || true
}

NODE_BIN="$(resolve_node_bin)"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js niet gevonden voor user $APP_USER. Installeer node eerst op de Raspberry Pi (bijv. nvm + Node 20)."
  exit 1
fi

if [[ ! -f "$APP_DIR/index.js" ]]; then
  echo "index.js niet gevonden in $APP_DIR"
  exit 1
fi

mkdir -p "$ENV_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0644 "$APP_DIR/deploy/jacuzzi-solar.env.example" "$ENV_FILE"
  echo "Environment file aangemaakt op $ENV_FILE"
else
  echo "Environment file bestaat al: $ENV_FILE"
fi

cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=Jacuzzi Solar Optimizer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR $ENV_DIR

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable jacuzzi-solar.service
systemctl restart jacuzzi-solar.service

echo ""
echo "Service actief. Controleer status met:"
echo "  systemctl status jacuzzi-solar --no-pager"
echo "Logs volgen met:"
echo "  journalctl -u jacuzzi-solar -f"
