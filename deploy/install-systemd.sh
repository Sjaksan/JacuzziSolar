#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_USER="${2:-pi}"
APP_GROUP="${3:-$APP_USER}"
ENV_DIR="/etc/jacuzzi-solar"
ENV_FILE="$ENV_DIR/jacuzzi-solar.env"
SERVICE_FILE="/etc/systemd/system/jacuzzi-solar.service"
NODE_BIN="$(command -v node || true)"

if [[ $EUID -ne 0 ]]; then
  echo "Run dit script met sudo: sudo bash deploy/install-systemd.sh [app_dir] [user] [group]"
  exit 1
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js niet gevonden in PATH. Installeer node eerst op de Raspberry Pi."
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
