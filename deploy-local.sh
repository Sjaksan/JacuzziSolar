#!/usr/bin/env bash
set -euo pipefail

# One-command local deploy to Raspberry Pi.
# Defaults match your setup, but can be overridden via env vars or CLI args.
#
# Env overrides:
#   PI_HOST, PI_USER, REMOTE_DIR, APP_USER, APP_GROUP
#
# CLI usage:
#   ./deploy-local.sh [pi_host] [pi_user] [remote_dir] [app_user] [app_group]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PI_HOST="${1:-${PI_HOST:-192.168.1.151}}"
PI_USER="${2:-${PI_USER:-sjaksan}}"
REMOTE_DIR="${3:-${REMOTE_DIR:-/opt/jacuzzi-solar}}"
APP_USER="${4:-${APP_USER:-sjaksan}}"
APP_GROUP="${5:-${APP_GROUP:-$APP_USER}}"
FORCE_NPM_INSTALL="${FORCE_NPM_INSTALL:-0}"
FORCE_SQLITE_REBUILD="${FORCE_SQLITE_REBUILD:-0}"
SKIP_REMOTE_NPM_INSTALL="${SKIP_REMOTE_NPM_INSTALL:-0}"
REMOTE_NPM_CACHE_DIR="${REMOTE_NPM_CACHE_DIR:-}"
REMOTE_MIN_FREE_KB="${REMOTE_MIN_FREE_KB:-}"

REMOTE="${PI_USER}@${PI_HOST}"

if [[ "${EUID}" -eq 0 ]]; then
  echo "Error: run this script as your normal user, not with sudo."
  echo "Use: ./deploy-local.sh"
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "Error: rsync is not installed locally."
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "Error: ssh is not installed locally."
  exit 1
fi

if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "Error: ssh-keygen is not installed locally."
  exit 1
fi

if ! command -v ssh-keyscan >/dev/null 2>&1; then
  echo "Error: ssh-keyscan is not installed locally."
  exit 1
fi

SSH_OPTS=("-o" "ConnectTimeout=10")
if [[ "${SSH_BATCH_MODE:-0}" == "1" ]]; then
  SSH_OPTS+=("-o" "BatchMode=yes")
fi

diagnose_failure() {
  local phase="$1"
  local exit_code="$2"
  local output="$3"

  echo ""
  echo "Deploy diagnostics (${phase}, exit ${exit_code}):"

  if [[ "$output" == *"Permission denied (publickey,password)"* ]]; then
    echo "- SSH authenticatie faalt. Test: ssh ${REMOTE}"
    echo "- Zet je key op de Pi: ssh-copy-id ${REMOTE}"
    return
  fi

  if [[ "$output" == *"Host key verification failed"* ]]; then
    echo "- SSH host key mismatch. Reset known host entry: ssh-keygen -R ${PI_HOST}"
    return
  fi

  if [[ "$output" == *"REMOTE HOST IDENTIFICATION HAS CHANGED"* ]]; then
    echo "- SSH host key is gewijzigd. Verwijder oude key: ssh-keygen -R ${PI_HOST}"
    return
  fi

  if [[ "$output" == *"Connection timed out"* || "$output" == *"No route to host"* || "$output" == *"Connection refused"* ]]; then
    echo "- Netwerk/SSH poort probleem. Controleer Pi IP en SSH service."
    echo "- Test: ping -c 3 ${PI_HOST}"
    echo "- Test: ssh ${REMOTE}"
    return
  fi

  if [[ "$output" == *"Could not resolve hostname"* || "$output" == *"Name or service not known"* ]]; then
    echo "- Hostnaam/IP kan niet worden opgelost. Controleer PI_HOST=${PI_HOST}."
    return
  fi

  if [[ "$output" == *"sudo: a password is required"* ]]; then
    echo "- Sudo op de Pi vraagt een wachtwoord. Voeg NOPASSWD toe voor update script in sudoers."
    return
  fi

  if [[ "$output" == *"not allowed to execute"* || "$output" == *"is not in the sudoers file"* ]]; then
    echo "- Sudoers policy blokkeert dit commando. Controleer /etc/sudoers.d/jacuzzi-solar-deploy."
    return
  fi

  if [[ "$output" == *"Te oude Node/npm toolchain gevonden"* ]]; then
    echo "- Op de Pi wordt nog een oude Node/npm gebruikt voor deploy."
    echo "- Laad Node 20 voor user ${APP_USER} (nvm) en run deploy opnieuw."
    return
  fi

  if [[ "$output" == *"Node.js/npm niet gevonden"* ]]; then
    echo "- Node/npm werd niet gevonden in de sudo context op de Pi."
    echo "- Controleer dat nvm voor user ${APP_USER} correct is geinstalleerd en dat ~/.nvm/versions/node/.../bin bestaat."
    return
  fi

  if [[ "$output" == *"Permission denied"* && "$output" == *"rsync"* ]]; then
    echo "- Rsync permissieprobleem op remote pad ${REMOTE_DIR}."
    echo "- Fix op Pi: sudo mkdir -p ${REMOTE_DIR} && sudo chown -R ${APP_USER}:${APP_GROUP} ${REMOTE_DIR}"
    return
  fi

  echo "- Geen specifieke diagnosematch. Test handmatig:"
  echo "  ssh ${REMOTE}"
  echo "  rsync -avz --delete --exclude .git ./ ${REMOTE}:${REMOTE_DIR}/"
}

run_checked() {
  local phase="$1"
  shift

  local output
  local exit_code

  set +e
  output="$($@ 2>&1)"
  exit_code=$?
  set -e

  if [[ -n "$output" ]]; then
    echo "$output"
  fi

  if [[ "$exit_code" -ne 0 ]]; then
    diagnose_failure "$phase" "$exit_code" "$output"
    exit "$exit_code"
  fi
}

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if ! ssh-keygen -F "$PI_HOST" >/dev/null 2>&1; then
  echo "[0/3] Adding SSH host key for ${PI_HOST}..."
  ssh-keyscan -H "$PI_HOST" >> "$HOME/.ssh/known_hosts" 2>/dev/null
fi

echo "[1/3] Testing SSH connection to ${REMOTE}..."
run_checked "ssh-test" ssh "${SSH_OPTS[@]}" "${REMOTE}" "true"

echo "[2/3] Syncing project files to ${REMOTE_DIR}..."
run_checked "rsync" rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.deploy-state' \
  --exclude '.DS_Store' \
  --exclude 'history.db' \
  --exclude '*.log' \
  "${SCRIPT_DIR}/" "${REMOTE}:${REMOTE_DIR}/"

echo "[3/3] Running remote update script and restarting service..."
remote_cmd=(sudo bash "${REMOTE_DIR}/deploy/update-on-pi.sh" "${REMOTE_DIR}" "${APP_USER}" "${APP_GROUP}")

if [[ "$FORCE_NPM_INSTALL" == "1" ]]; then
  remote_cmd+=(--force-npm-install)
fi

if [[ "$FORCE_SQLITE_REBUILD" == "1" ]]; then
  remote_cmd+=(--force-sqlite-rebuild)
fi

if [[ "$SKIP_REMOTE_NPM_INSTALL" == "1" ]]; then
  remote_cmd+=(--skip-npm-install)
fi

if [[ -n "$REMOTE_NPM_CACHE_DIR" ]]; then
  remote_cmd+=(--npm-cache-dir "$REMOTE_NPM_CACHE_DIR")
fi

if [[ -n "$REMOTE_MIN_FREE_KB" ]]; then
  remote_cmd+=(--min-free-kb "$REMOTE_MIN_FREE_KB")
fi

run_checked "remote-update" ssh "${SSH_OPTS[@]}" "${REMOTE}" "$(printf '%q ' "${remote_cmd[@]}")"

echo "Deploy completed successfully."
