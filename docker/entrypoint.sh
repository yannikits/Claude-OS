#!/bin/sh
#
# claude-os container entrypoint.
#
# Pre-flight checks:
#  - $CLAUDE_OS_AUTH_TOKEN must be set (the server refuses to boot otherwise)
#  - /data structure exists (vault, config, anthropic-auth-dir)
#  - $ANTHROPIC_CONFIG_DIR points into the volume so `claude auth login`
#    survives container restarts
#
# Then exec the headless server. Signals from tini are propagated to node
# which triggers the graceful-shutdown path in src/server/index.ts.
set -e

if [ -z "${CLAUDE_OS_AUTH_TOKEN}" ]; then
  cat >&2 <<'EOM'
FATAL: $CLAUDE_OS_AUTH_TOKEN is not set.

Generate a token with:
  openssl rand -hex 32

Set it in your environment (docker-compose .env file or `docker run -e`)
before starting the container.
EOM
  exit 2
fi

# Volume-backed directories
DATA_DIR="${CLAUDE_OS_DATA_DIR:-/data/config}"
VAULT_DIR="${CLAUDE_OS_VAULT_PATH:-/data/vault}"
ANTHROPIC_DIR="${ANTHROPIC_CONFIG_DIR:-/data/anthropic}"

mkdir -p "${DATA_DIR}" "${VAULT_DIR}" "${ANTHROPIC_DIR}"

# resolveRoot() needs either $CLAUDE_OS_ROOT or a .claude-os-root marker
# file in some ancestor directory. We pin both to /data so the marker
# (and everything else) survives container restarts via the volume.
ROOT_DIR="${CLAUDE_OS_ROOT:-/data}"
mkdir -p "${ROOT_DIR}"
touch "${ROOT_DIR}/.claude-os-root"
export CLAUDE_OS_ROOT="${ROOT_DIR}"

# Export so the node process picks them up
export CLAUDE_OS_DATA_DIR="${DATA_DIR}"
export CLAUDE_OS_VAULT_PATH="${VAULT_DIR}"
export ANTHROPIC_CONFIG_DIR="${ANTHROPIC_DIR}"

# ── claude-CLI credentials persistence ──────────────────────────────
#
# The `claude` CLI hardcodes `~/.claude/.credentials.json` and ignores
# $ANTHROPIC_CONFIG_DIR for the credentials file itself. Symlink the
# expected path to the persistent volume so:
#   1. `claude auth login` writes through to the volume (survives restart)
#   2. The Settings page (which reads $ANTHROPIC_CONFIG_DIR/.credentials.json)
#      sees the credentials immediately after login
#
# Migrate step: if a previous container wrote .credentials.json into
# /root/.claude/ (non-symlinked), move it to the volume on first boot.
mkdir -p /root/.claude
if [ -f /root/.claude/.credentials.json ] && [ ! -L /root/.claude/.credentials.json ]; then
  if [ ! -e "${ANTHROPIC_DIR}/.credentials.json" ]; then
    echo "==> migrating existing /root/.claude/.credentials.json → ${ANTHROPIC_DIR}/"
    mv /root/.claude/.credentials.json "${ANTHROPIC_DIR}/.credentials.json"
  else
    # Volume already has credentials — root-side stale copy loses.
    rm /root/.claude/.credentials.json
  fi
fi
ln -sf "${ANTHROPIC_DIR}/.credentials.json" /root/.claude/.credentials.json

# Optional: log to stdout so docker logs captures everything
export CLAUDE_OS_LOG_LEVEL="${CLAUDE_OS_LOG_LEVEL:-info}"

echo "==> claude-os server starting"
echo "    root:      ${ROOT_DIR}"
echo "    vault:     ${VAULT_DIR}"
echo "    data:      ${DATA_DIR}"
echo "    anthropic: ${ANTHROPIC_DIR}"
echo "    static:    ${CLAUDE_OS_STATIC_DIR:-/app/gui/dist}"
echo "    port:      ${PORT:-3000}"
echo "    host:      ${HOST:-0.0.0.0}"

# Pre-flight: doctor --json catches mis-configured secrets backend,
# unmounted vault, and other server-env drift BEFORE the server tries
# to boot and crashes later with cryptic ENOENT/EACCES. The check
# fails-loud — container exits 1 instead of staying in a half-started
# state. Skipped if $CLAUDE_OS_SKIP_DOCTOR=1 (escape hatch for debugging).
if [ "${CLAUDE_OS_SKIP_DOCTOR:-0}" != "1" ]; then
  echo "==> running pre-flight doctor"
  if ! node /app/dist/cli/index.js doctor --json > /tmp/doctor-preflight.json 2>&1; then
    echo "FATAL: claude-os doctor pre-flight failed" >&2
    cat /tmp/doctor-preflight.json >&2
    echo "" >&2
    echo "Set CLAUDE_OS_SKIP_DOCTOR=1 to bypass (debugging only)." >&2
    exit 1
  fi
fi

exec node /app/dist/cli/index.js serve \
  --host "${HOST:-0.0.0.0}" \
  --port "${PORT:-3000}"
