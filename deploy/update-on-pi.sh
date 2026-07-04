#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/jacuzzi-solar}"
APP_USER="${2:-pi}"
APP_GROUP="${3:-$APP_USER}"

if [[ $EUID -ne 0 ]]; then
  echo "Run dit script met sudo: sudo bash deploy/update-on-pi.sh [app_dir] [user] [group]"
  exit 1
fi

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "package.json niet gevonden in $APP_DIR"
  exit 1
fi

cd "$APP_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm niet gevonden. Installeer Node.js en npm eerst op de Raspberry Pi."
  exit 1
fi

if ! command -v gpiodetect >/dev/null 2>&1 || ! command -v gpioset >/dev/null 2>&1; then
  echo "gpiod-tools niet gevonden. Installeren..."
  apt-get update
  apt-get install -y gpiod
fi

echo "Native build-afhankelijkheden controleren..."
apt-get update
apt-get install -y build-essential python3 make g++ git

if [ -f "package-lock.json" ]; then
  echo "package-lock.json gevonden, clean install starten..."
  UV_THREADPOOL_SIZE=1 npm ci --omit=dev --no-audit --no-fund
else
  echo "Geen package-lock.json gevonden, reguliere installatie starten..."
  UV_THREADPOOL_SIZE=1 npm install --omit=dev --no-audit --no-fund
fi

npm rebuild sqlite3 --build-from-source

chown -R "$APP_USER":"$APP_GROUP" "$APP_DIR"

if [[ -f "$APP_DIR/deploy/install-systemd.sh" ]]; then
  bash "$APP_DIR/deploy/install-systemd.sh" "$APP_DIR" "$APP_USER" "$APP_GROUP"
else
  echo "install-systemd.sh niet gevonden in $APP_DIR/deploy"
  exit 1
fi

echo "Update klaar. Controleer status met: systemctl status jacuzzi-solar --no-pager"