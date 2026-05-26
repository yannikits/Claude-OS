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

# Export so the node process picks them up
export CLAUDE_OS_DATA_DIR="${DATA_DIR}"
export CLAUDE_OS_VAULT_PATH="${VAULT_DIR}"
export ANTHROPIC_CONFIG_DIR="${ANTHROPIC_DIR}"

# Optional: log to stdout so docker logs captures everything
export CLAUDE_OS_LOG_LEVEL="${CLAUDE_OS_LOG_LEVEL:-info}"

echo "==> claude-os server starting"
echo "    vault:     ${VAULT_DIR}"
echo "    data:      ${DATA_DIR}"
echo "    anthropic: ${ANTHROPIC_DIR}"
echo "    static:    ${CLAUDE_OS_STATIC_DIR:-/app/gui/dist}"
echo "    port:      ${PORT:-3000}"
echo "    host:      ${HOST:-0.0.0.0}"

exec node /app/dist/cli/index.js serve \
  --host "${HOST:-0.0.0.0}" \
  --port "${PORT:-3000}"
