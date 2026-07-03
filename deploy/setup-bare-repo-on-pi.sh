#!/usr/bin/env bash
set -euo pipefail

# Usage: sudo bash setup-bare-repo-on-pi.sh [BARE_DIR] [TARGET_DIR] [APP_USER]
BARE_DIR="${1:-$HOME/git/jacuzzi-solar.git}"
TARGET_DIR="${2:-/opt/jacuzzi-solar}"
APP_USER="${3:-$SUDO_USER:-$USER}"

if [[ -d "$BARE_DIR" ]]; then
  echo "Bare repo already exists: $BARE_DIR"
  exit 1
fi

mkdir -p "$(dirname "$BARE_DIR")"
mkdir -p "$BARE_DIR"
cd "$BARE_DIR"
git init --bare

cat > hooks/post-receive <<EOF
#!/usr/bin/env bash
TARGET="$TARGET_DIR"
GIT_DIR="$(pwd)"
mkdir -p "$TARGET"
git --work-tree="$TARGET" --git-dir="$GIT_DIR" checkout -f
chown -R "$APP_USER":"$APP_USER" "$TARGET"

# Install deps and restart service if present (best-effort)
if command -v npm >/dev/null 2>&1; then
  cd "$TARGET" || exit 0
  npm ci --omit=dev --no-audit --no-fund || true
  if [[ -f "$TARGET/deploy/install-systemd.sh" ]]; then
    sudo bash "$TARGET/deploy/install-systemd.sh" "$TARGET" "$APP_USER" "$APP_USER" || true
  fi
fi
EOF

chmod +x hooks/post-receive

echo "Bare repo created: $BARE_DIR"
echo "Post-receive hook will checkout to: $TARGET_DIR and run npm ci/restart if available." 
echo "Next: add remote locally: git remote add pi ssh://$APP_USER@<RPI_HOST>$BARE_DIR" 