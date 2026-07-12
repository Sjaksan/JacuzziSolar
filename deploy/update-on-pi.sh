#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/jacuzzi-solar}"
APP_USER="${2:-pi}"
APP_GROUP="${3:-$APP_USER}"
FORCE_NPM_INSTALL="${FORCE_NPM_INSTALL:-0}"
FORCE_SQLITE_REBUILD="${FORCE_SQLITE_REBUILD:-0}"
SKIP_NPM_INSTALL="${SKIP_NPM_INSTALL:-0}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-/var/cache/jacuzzi-solar-npm}"
MIN_FREE_KB="${MIN_FREE_KB:-262144}"

if [[ $# -gt 0 ]]; then
  APP_DIR="$1"
  shift
fi

if [[ $# -gt 0 ]]; then
  APP_USER="$1"
  shift
fi

if [[ $# -gt 0 ]]; then
  APP_GROUP="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force-npm-install)
      FORCE_NPM_INSTALL=1
      ;;
    --force-sqlite-rebuild)
      FORCE_SQLITE_REBUILD=1
      ;;
    --skip-npm-install)
      SKIP_NPM_INSTALL=1
      ;;
    --npm-cache-dir)
      if [[ $# -lt 2 ]]; then
        echo "Optie --npm-cache-dir vereist een pad."
        exit 1
      fi
      NPM_CACHE_DIR="$2"
      shift
      ;;
    --min-free-kb)
      if [[ $# -lt 2 ]]; then
        echo "Optie --min-free-kb vereist een numerieke waarde."
        exit 1
      fi
      MIN_FREE_KB="$2"
      shift
      ;;
    *)
      echo "Onbekende optie: $1"
      echo "Gebruik: sudo bash deploy/update-on-pi.sh [app_dir] [user] [group] [--force-npm-install] [--force-sqlite-rebuild] [--skip-npm-install] [--npm-cache-dir <pad>] [--min-free-kb <kb>]"
      exit 1
      ;;
  esac
  shift
done

if ! [[ "$MIN_FREE_KB" =~ ^[0-9]+$ ]]; then
  echo "MIN_FREE_KB moet een positief geheel getal zijn (KB)."
  exit 1
fi

STATE_DIR="$APP_DIR/.deploy-state"
LOCK_HASH_FILE="$STATE_DIR/package-lock.sha256"
PKG_HASH_FILE="$STATE_DIR/package.json.sha256"
APT_UPDATED=0

apt_install() {
  if [[ "$APT_UPDATED" -eq 0 ]]; then
    apt-get update
    APT_UPDATED=1
  fi
  apt-get install -y "$@"
}

ensure_command() {
  local command_name="$1"
  shift
  if ! command -v "$command_name" >/dev/null 2>&1; then
    apt_install "$@"
  fi
}

npm_supports_ci() {
  local npm_version npm_major npm_minor

  npm_version="$("$NPM_BIN" --version 2>/dev/null || echo 0.0.0)"
  npm_major="${npm_version%%.*}"
  npm_minor="${npm_version#*.}"
  npm_minor="${npm_minor%%.*}"

  if ! [[ "$npm_major" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  if ! [[ "$npm_minor" =~ ^[0-9]+$ ]]; then
    npm_minor=0
  fi

  # npm ci became available in npm 5.7+.
  if (( npm_major > 5 )); then
    return 0
  fi

  if (( npm_major == 5 && npm_minor >= 7 )); then
    return 0
  fi

  return 1
}

version_major() {
  local raw="$1"
  local normalized="${raw#v}"
  echo "${normalized%%.*}"
}

resolve_node_toolchain() {
  local user_node=""
  local user_npm=""
  local user_home=""
  local nvm_node=""
  local nvm_npm=""
  local node_dir=""

  user_home="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
  if [[ -z "$user_home" ]]; then
    user_home="/home/$APP_USER"
  fi

  user_node="$(sudo -iu "$APP_USER" bash -lc 'command -v node 2>/dev/null || true')"
  user_npm="$(sudo -iu "$APP_USER" bash -lc 'command -v npm 2>/dev/null || true')"

  if [[ -z "$user_node" || -z "$user_npm" ]]; then
    nvm_node="$(ls -1d "$user_home"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
    if [[ -n "$nvm_node" ]]; then
      nvm_npm="${nvm_node%/node}/npm"
      if [[ ! -x "$nvm_npm" ]]; then
        nvm_npm=""
      fi
    fi
  fi

  NODE_BIN="${user_node:-${nvm_node:-$(command -v node || true)}}"
  NPM_BIN="${user_npm:-${nvm_npm:-$(command -v npm || true)}}"

  if [[ -n "$NODE_BIN" ]]; then
    node_dir="$(dirname "$NODE_BIN")"
    if [[ -x "$node_dir/npm" ]]; then
      NPM_BIN="${NPM_BIN:-$node_dir/npm}"
    fi
    # Ensure npm shebang (`/usr/bin/env node`) resolves to the selected Node.
    export PATH="$node_dir:$PATH"
  fi

  if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
    echo "Node.js/npm niet gevonden. Installeer een moderne Node versie voor user $APP_USER (aanrader: nvm + Node 20)."
    exit 1
  fi

  NODE_VERSION_RAW="$("$NODE_BIN" --version 2>/dev/null || echo v0.0.0)"
  NPM_VERSION_RAW="$("$NPM_BIN" --version 2>/dev/null || echo 0.0.0)"

  NODE_MAJOR="$(version_major "$NODE_VERSION_RAW")"
  NPM_MAJOR="$(version_major "$NPM_VERSION_RAW")"

  if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]]; then
    NODE_MAJOR=0
  fi

  if ! [[ "$NPM_MAJOR" =~ ^[0-9]+$ ]]; then
    NPM_MAJOR=0
  fi

  if (( NODE_MAJOR < 18 || NPM_MAJOR < 8 )); then
    echo "Te oude Node/npm toolchain gevonden: node $NODE_VERSION_RAW, npm $NPM_VERSION_RAW"
    echo "Gebruik Node 20 + npm 8+ voor dit project (sqlite3 + lockfile v3)."
    echo "Tip: installeer Node met nvm voor user $APP_USER en voer deploy opnieuw uit."
    exit 1
  fi

  echo "Node toolchain: node $NODE_VERSION_RAW, npm $NPM_VERSION_RAW"
}

file_hash() {
  local file_path="$1"
  sha256sum "$file_path" | awk '{print $1}'
}

free_kb_for_path() {
  local target_path="$1"
  df -Pk "$target_path" | awk 'NR==2 {print $4}'
}

ensure_min_free_space() {
  local target_path="$1"
  local label="$2"
  local free_kb

  free_kb="$(free_kb_for_path "$target_path")"
  if [[ -z "$free_kb" ]]; then
    echo "Kon vrije ruimte niet bepalen voor $label ($target_path)."
    exit 1
  fi

  if (( free_kb < MIN_FREE_KB )); then
    local free_mb required_mb
    free_mb=$((free_kb / 1024))
    required_mb=$((MIN_FREE_KB / 1024))
    echo "Te weinig vrije ruimte op $label ($target_path): ${free_mb}MB vrij, minimaal ${required_mb}MB vereist."
    echo "Tip: ruim logs/npm-cache op of verhoog tijdelijke opslag voor npm cache."
    exit 1
  fi
}

if [[ $EUID -ne 0 ]]; then
  echo "Run dit script met sudo: sudo bash deploy/update-on-pi.sh [app_dir] [user] [group]"
  exit 1
fi

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "package.json niet gevonden in $APP_DIR"
  exit 1
fi

resolve_node_toolchain

cd "$APP_DIR"
mkdir -p "$STATE_DIR"
mkdir -p "$NPM_CACHE_DIR"

NPM_CACHE_ARGS=(--cache "$NPM_CACHE_DIR")
NPM_VERSION="$NPM_VERSION_RAW"
NPM_MAJOR="${NPM_VERSION%%.*}"

if ! [[ "$NPM_MAJOR" =~ ^[0-9]+$ ]]; then
  NPM_MAJOR=0
fi

if (( NPM_MAJOR >= 7 )); then
  NPM_PROD_FLAGS=(--omit=dev)
else
  NPM_PROD_FLAGS=(--only=production)
fi

if (( NPM_MAJOR >= 6 )); then
  NPM_EXTRA_FLAGS=(--no-audit --no-fund)
else
  NPM_EXTRA_FLAGS=()
fi

if ! command -v gpiodetect >/dev/null 2>&1 || ! command -v gpioset >/dev/null 2>&1; then
  echo "gpiod-tools niet gevonden. Installeren..."
  apt_install gpiod
fi

echo "Native build-afhankelijkheden controleren..."
ensure_command git build-essential python3 make g++ git
ensure_command make build-essential python3 make g++ git
ensure_command g++ build-essential python3 make g++ git
ensure_command python3 build-essential python3 make g++ git

deps_changed=0
if [[ "$SKIP_NPM_INSTALL" == "1" ]]; then
  if "$NODE_BIN" -e "require.resolve('sqlite3')" >/dev/null 2>&1; then
    echo "SKIP_NPM_INSTALL=1, npm install en sqlite3-check worden overgeslagen."
  else
    echo "SKIP_NPM_INSTALL=1 gevraagd, maar sqlite3 ontbreekt. Dependencies worden alsnog geinstalleerd."
    SKIP_NPM_INSTALL=0
    FORCE_NPM_INSTALL=1
  fi
elif [[ "$FORCE_NPM_INSTALL" == "1" ]]; then
  deps_changed=1
  echo "FORCE_NPM_INSTALL=1, dependencies worden opnieuw geinstalleerd."
elif [[ -f "package-lock.json" ]]; then
  current_lock_hash="$(file_hash package-lock.json)"
  previous_lock_hash="$(cat "$LOCK_HASH_FILE" 2>/dev/null || true)"
  if [[ ! -d "node_modules" || "$current_lock_hash" != "$previous_lock_hash" ]]; then
    deps_changed=1
  fi
else
  current_pkg_hash="$(file_hash package.json)"
  previous_pkg_hash="$(cat "$PKG_HASH_FILE" 2>/dev/null || true)"
  if [[ ! -d "node_modules" || "$current_pkg_hash" != "$previous_pkg_hash" ]]; then
    deps_changed=1
  fi
fi

if [[ "$deps_changed" == "1" ]]; then
  ensure_min_free_space "$APP_DIR" "app partitie"
  ensure_min_free_space "$NPM_CACHE_DIR" "npm cache partitie"

  if [[ -f "package-lock.json" ]]; then
    if npm_supports_ci; then
      echo "Dependencies gewijzigd, npm ci starten..."
      UV_THREADPOOL_SIZE=1 "$NPM_BIN" ci "${NPM_PROD_FLAGS[@]}" "${NPM_EXTRA_FLAGS[@]}" "${NPM_CACHE_ARGS[@]}"
    else
      echo "npm ci niet beschikbaar op npm ${NPM_VERSION}; val terug op npm install."
      UV_THREADPOOL_SIZE=1 "$NPM_BIN" install "${NPM_PROD_FLAGS[@]}" "${NPM_EXTRA_FLAGS[@]}" "${NPM_CACHE_ARGS[@]}"
    fi
    file_hash package-lock.json > "$LOCK_HASH_FILE"
    rm -f "$PKG_HASH_FILE"
  else
    echo "Dependencies gewijzigd, npm install starten..."
    UV_THREADPOOL_SIZE=1 "$NPM_BIN" install "${NPM_PROD_FLAGS[@]}" "${NPM_EXTRA_FLAGS[@]}" "${NPM_CACHE_ARGS[@]}"
    file_hash package.json > "$PKG_HASH_FILE"
    rm -f "$LOCK_HASH_FILE"
  fi
else
  if [[ "$SKIP_NPM_INSTALL" != "1" ]]; then
    echo "Dependencies ongewijzigd, npm install overgeslagen."
  fi
fi

if [[ "$SKIP_NPM_INSTALL" == "1" ]]; then
  echo "SKIP_NPM_INSTALL=1, sqlite3-check overgeslagen."
elif [[ "$FORCE_SQLITE_REBUILD" == "1" ]]; then
  ensure_min_free_space "$APP_DIR" "app partitie"
  echo "FORCE_SQLITE_REBUILD=1, sqlite3 wordt geforceerd opnieuw gebouwd..."
  "$NPM_BIN" rebuild sqlite3 --build-from-source "${NPM_CACHE_ARGS[@]}"
elif "$NODE_BIN" -e "
  const fs = require('fs');
  const path = require('path');
  const sqlite3Path = path.join(process.cwd(), 'node_modules', 'sqlite3');
  const bindingPath = path.join(sqlite3Path, 'lib', 'binding', 'node-v' + process.versions.modules + '-' + process.platform + '-' + process.arch, 'node_sqlite3.node');
  if (!fs.existsSync(bindingPath)) {
    console.error('missing');
    process.exit(1);
  }
  require('sqlite3');
  console.log('sqlite3 ok');
" >/dev/null 2>&1; then
  echo "sqlite3 native binding werkt al; rebuild overgeslagen."
else
  ensure_min_free_space "$APP_DIR" "app partitie"
  echo "sqlite3 native binding ontbreekt of is onbruikbaar; rebuild vanaf broncode..."
  "$NPM_BIN" rebuild sqlite3 --build-from-source "${NPM_CACHE_ARGS[@]}"
fi

if [[ "$deps_changed" == "1" ]]; then
  chown -R "$APP_USER":"$APP_GROUP" "$APP_DIR"
fi

if [[ -f "$APP_DIR/deploy/install-systemd.sh" ]]; then
  bash "$APP_DIR/deploy/install-systemd.sh" "$APP_DIR" "$APP_USER" "$APP_GROUP"
else
  echo "install-systemd.sh niet gevonden in $APP_DIR/deploy"
  exit 1
fi

echo "Update klaar. Controleer status met: systemctl status jacuzzi-solar --no-pager"