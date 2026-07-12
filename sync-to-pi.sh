#!/usr/bin/env bash
set -euo pipefail

# Sync only: copy the current workspace to the Raspberry Pi without running any remote update step.
# Defaults match the existing deploy flow, but can be overridden with env vars or CLI args.
#
# Env overrides:
#   PI_HOST, PI_USER, REMOTE_DIR
#
# CLI usage:
#   ./sync-to-pi.sh [pi_host] [pi_user] [remote_dir]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PI_HOST="${1:-${PI_HOST:-192.168.1.151}}"
PI_USER="${2:-${PI_USER:-sjaksan}}"
REMOTE_DIR="${3:-${REMOTE_DIR:-/opt/jacuzzi-solar}}"
REMOTE="${PI_USER}@${PI_HOST}"

if ! command -v rsync >/dev/null 2>&1; then
  echo "Error: rsync is not installed locally."
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "Error: ssh is not installed locally."
  exit 1
fi

echo "Testing SSH connection to ${REMOTE}..."
ssh -o ConnectTimeout=10 "${REMOTE}" "true" >/dev/null

echo "Syncing project files to ${REMOTE_DIR}..."
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.deploy-state' \
  --exclude '.DS_Store' \
  --exclude 'history.db' \
  --exclude '*.log' \
  "${SCRIPT_DIR}/" "${REMOTE}:${REMOTE_DIR}/"

echo "Sync completed successfully."
