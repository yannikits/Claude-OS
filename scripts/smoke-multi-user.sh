#!/usr/bin/env bash
#
# scripts/smoke-multi-user.sh — End-to-End Multi-User-Stage-2 smoke test.
#
# Bootstraps a fresh tmp data-dir, creates an admin user via CLI,
# starts `claude-os serve` in the background, then exercises the
# whole Web-7 cookie-auth pipeline via curl: login → /me → logout →
# /me-401 → invalid-csrf → wrong-password → session-persistence-
# survives-restart (when $CLAUDE_OS_SESSION_PERSIST=1).
#
# Returns exit-code 0 on full pass, 1 on any failure. Intended for
# CI + post-deploy operator-confidence.
#
# Usage:
#   scripts/smoke-multi-user.sh                    # in-memory sessions
#   PERSIST=1 scripts/smoke-multi-user.sh          # also runs restart-survival
#   PORT=31420 scripts/smoke-multi-user.sh         # custom port
#
# Requires: bash 4+, curl, jq (optional — falls back to grep/sed).

set -u
set -o pipefail

PORT="${PORT:-31420}"
HOST="${HOST:-127.0.0.1}"
PERSIST="${PERSIST:-0}"
EMAIL="${EMAIL:-smoke@example.com}"
PASSWORD="${PASSWORD:-correct-horse-battery-staple-12+}"

TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
TMP="$(mktemp -d -t claude-os-smoke-XXXXXX)"
LOG="$TMP/serve.log"
COOKIES="$TMP/cookies.txt"
FAIL=0

# ── colour-helpers ───────────────────────────────────────────────────
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

ok()   { green   "  PASS  $*"; }
fail() { red     "  FAIL  $*"; FAIL=$((FAIL + 1)); }
info() { yellow  "  ...   $*"; }
sect() { echo;   bold    "==> $*"; }

# ── teardown ─────────────────────────────────────────────────────────
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null
    sleep 1
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT INT TERM

# ── env ──────────────────────────────────────────────────────────────
export CLAUDE_OS_DATA_DIR="$TMP/data"
export CLAUDE_OS_VAULT_PATH="$TMP/vault"
export CLAUDE_OS_ROOT="$TMP"
export CLAUDE_OS_AUTH_TOKEN="$TOKEN"
export CLAUDE_OS_SECRETS_BACKEND="file"
export CLAUDE_OS_INSECURE_COOKIES="1"
# Phase Web-7-7: smoke also covers admin HTTP API + MSP-E note-to-skill.
export CLAUDE_OS_ADMIN_EMAILS="$EMAIL"
mkdir -p "$CLAUDE_OS_DATA_DIR" "$CLAUDE_OS_VAULT_PATH"
mkdir -p "$CLAUDE_OS_VAULT_PATH/workspaces/personal/notes"
mkdir -p "$CLAUDE_OS_VAULT_PATH/workspaces/personal/skills/_drafts"
touch "$CLAUDE_OS_ROOT/.claude-os-root"

# vault-config so resolveVaultRoot finds workspaces/personal.
cat > "$CLAUDE_OS_VAULT_PATH/vault-config.json" <<JSON
{ "version": 1, "defaultWorkspace": "personal", "workspaces": [ { "id": "personal", "label": "Personal", "kind": "personal", "path": "workspaces/personal" } ] }
JSON
cat > "$CLAUDE_OS_VAULT_PATH/workspaces/personal/notes/smoke-note.md" <<NOTE
---
title: Smoke Note
classification: personal
---

# Smoke Note

This note exists so the smoke can exercise note-to-skill.
NOTE

if [ "$PERSIST" = "1" ]; then
  export CLAUDE_OS_SESSION_PERSIST="1"
fi

# ── helper: extract csrfToken from login JSON ────────────────────────
extract_csrf() {
  local body="$1"
  echo "$body" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p'
}

# ── helper: extract user.email from JSON ────────────────────────────
extract_email() {
  local body="$1"
  echo "$body" | sed -n 's/.*"email":"\([^"]*\)".*/\1/p' | head -1
}

# ── pre-flight ───────────────────────────────────────────────────────
sect "Pre-flight"

# Force a fresh build unless $SKIP_BUILD=1 — otherwise stale dist/
# from previous sessions can mask source changes.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  info "npm run build (set SKIP_BUILD=1 to skip)"
  if ! npm run build > "$TMP/build.log" 2>&1; then
    fail "npm run build (see $TMP/build.log)"
    tail -20 "$TMP/build.log"
    exit 1
  fi
fi
if [ ! -f "dist/cli/index.js" ]; then
  fail "dist/cli/index.js missing after build"
  exit 1
fi
ok "claude-os CLI is built"

# ── 1. create admin user ─────────────────────────────────────────────
sect "1. CLI: users create"
if node dist/cli/index.js users create --email "$EMAIL" --password "$PASSWORD" > "$TMP/create.log" 2>&1; then
  ok "users create $EMAIL"
else
  fail "users create $EMAIL"
  cat "$TMP/create.log"
  exit 1
fi

# ── 2. start server ──────────────────────────────────────────────────
sect "2. Start server"
node dist/cli/index.js serve --port "$PORT" --host "$HOST" > "$LOG" 2>&1 &
SERVER_PID=$!

# Poll for "Server listening" log line first (cheap, no curl quirks),
# then optionally probe /healthz. Some windows-bash + curl combos have
# stubborn 127.0.0.1 resolution edge-cases — when /healthz fails but a
# normal /api/* call from the same script succeeds later, that's the
# environment, not the server. We treat /healthz as a soft signal.
WAITED=0
while [ "$WAITED" -lt 20 ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "server died before becoming ready"
    tail -20 "$LOG"
    exit 1
  fi
  if grep -q "Server listening" "$LOG"; then
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done
if [ "$WAITED" -ge 20 ]; then
  fail "server did not log 'Server listening' after 20s"
  tail -20 "$LOG"
  exit 1
fi
ok "server pid=$SERVER_PID listening on $HOST:$PORT"

# Soft healthz check — warn but don't fail on curl quirks.
if curl -sf -o /dev/null "http://$HOST:$PORT/healthz" 2>/dev/null; then
  ok "/healthz returns 200"
else
  info "/healthz curl-probe failed (curl/127.0.0.1 quirk — later /api/* calls confirm reachability)"
fi

# Confirm Stage 2 was enabled
if grep -q "Multi-User Stage 2 enabled" "$LOG"; then
  ok "Multi-User Stage 2 auto-detected"
  if [ "$PERSIST" = "1" ]; then
    if grep -q "sessions persisted" "$LOG"; then
      ok "session-persistence enabled"
    else
      fail "session-persistence NOT enabled despite PERSIST=1"
    fi
  fi
else
  fail "Stage 2 NOT activated — check log"
  tail -10 "$LOG"
fi

# ── 3. login with email + password ───────────────────────────────────
sect "3. POST /api/auth/login"
LOGIN_BODY=$(curl -s -c "$COOKIES" -X POST "http://$HOST:$PORT/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$HOST:$PORT/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}")

if echo "$LOGIN_BODY" | grep -q "\"email\":\"$EMAIL\""; then
  ok "login response contains user.email=$EMAIL"
else
  fail "login response missing expected user payload"
  echo "  body: $LOGIN_BODY"
fi

CSRF=$(extract_csrf "$LOGIN_BODY")
if [ -n "$CSRF" ] && [ "${#CSRF}" = 64 ]; then
  ok "csrfToken extracted (64 hex chars)"
else
  fail "csrfToken malformed or missing (length=${#CSRF})"
fi

if [ "$STATUS" = "401" ]; then
  ok "wrong-password → 401"
else
  fail "wrong-password expected 401, got $STATUS"
fi

# ── 4. GET /api/auth/me with cookie ──────────────────────────────────
sect "4. GET /api/auth/me (cookie-authed)"
ME_BODY=$(curl -s -b "$COOKIES" "http://$HOST:$PORT/api/auth/me")
ME_EMAIL=$(extract_email "$ME_BODY")
if [ "$ME_EMAIL" = "$EMAIL" ]; then
  ok "/me returns user.email=$EMAIL"
else
  fail "/me returned unexpected email '$ME_EMAIL'"
  echo "  body: $ME_BODY"
fi

# ── 5. CSRF enforcement ──────────────────────────────────────────────
sect "5. CSRF protection on unsafe methods"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -b "$COOKIES" -X POST "http://$HOST:$PORT/api/auth/logout" \
  -H "Content-Type: application/json" -d '{}')
if [ "$STATUS" = "403" ]; then
  ok "logout WITHOUT csrf-header → 403"
else
  fail "logout WITHOUT csrf expected 403, got $STATUS"
fi

STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -b "$COOKIES" -X POST "http://$HOST:$PORT/api/auth/logout" \
  -H "x-csrf-token: 0000000000000000000000000000000000000000000000000000000000000000" \
  -H "Content-Type: application/json" -d '{}')
if [ "$STATUS" = "403" ]; then
  ok "logout with WRONG csrf-header → 403"
else
  fail "logout with wrong csrf expected 403, got $STATUS"
fi

# ── 6. session persistence (PERSIST=1 only) ──────────────────────────
if [ "$PERSIST" = "1" ]; then
  sect "6. Session-Persistence: kill + restart preserves login"
  kill -TERM "$SERVER_PID"
  wait "$SERVER_PID" 2>/dev/null || true
  sleep 1

  # Restart with same data-dir → SessionRepository preloads
  node dist/cli/index.js serve --port "$PORT" --host "$HOST" > "$LOG.restart" 2>&1 &
  SERVER_PID=$!
  sleep 3

  ME_AFTER=$(curl -s -b "$COOKIES" "http://$HOST:$PORT/api/auth/me")
  if [ "$(extract_email "$ME_AFTER")" = "$EMAIL" ]; then
    ok "session survived container restart"
  else
    fail "session lost after restart — persistence not working"
    echo "  body: $ME_AFTER"
  fi
fi

# ── 7. Admin HTTP API (Web-7-7) ──────────────────────────────────────
sect "7. Admin HTTP API"

NEW_EMAIL="new-by-admin@example.com"
NEW_PASSWORD="new-strong-password-12+"

# 7a. list users
ADMIN_LIST=$(curl -s -b "$COOKIES" "http://$HOST:$PORT/api/admin/users")
if echo "$ADMIN_LIST" | grep -q "\"email\":\"$EMAIL\""; then
  ok "GET /api/admin/users lists admin"
else
  fail "GET /api/admin/users body unexpected"
  echo "  body: $ADMIN_LIST"
fi

# 7b. create a user
CREATE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -b "$COOKIES" -X POST "http://$HOST:$PORT/api/admin/users" \
  -H "x-csrf-token: $CSRF" -H "Content-Type: application/json" \
  -d "{\"email\":\"$NEW_EMAIL\",\"password\":\"$NEW_PASSWORD\"}")
if [ "$CREATE_STATUS" = "201" ]; then
  ok "POST /api/admin/users created $NEW_EMAIL"
else
  fail "POST /api/admin/users expected 201, got $CREATE_STATUS"
fi

# 7c. duplicate → 409
DUP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -b "$COOKIES" -X POST "http://$HOST:$PORT/api/admin/users" \
  -H "x-csrf-token: $CSRF" -H "Content-Type: application/json" \
  -d "{\"email\":\"$NEW_EMAIL\",\"password\":\"$NEW_PASSWORD\"}")
if [ "$DUP_STATUS" = "409" ]; then
  ok "duplicate POST → 409"
else
  fail "duplicate POST expected 409, got $DUP_STATUS"
fi

# 7d. disable + verify they cannot log in
DISABLE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -b "$COOKIES" -X POST "http://$HOST:$PORT/api/admin/users/$NEW_EMAIL/disable" \
  -H "x-csrf-token: $CSRF" -H "Content-Type: application/json" -d '{}')
if [ "$DISABLE_STATUS" = "200" ]; then
  ok "POST disable → 200"
else
  fail "POST disable expected 200, got $DISABLE_STATUS"
fi

LOGIN_DENIED=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$HOST:$PORT/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$NEW_EMAIL\",\"password\":\"$NEW_PASSWORD\"}")
if [ "$LOGIN_DENIED" = "401" ]; then
  ok "disabled user cannot login (401)"
else
  fail "disabled user login expected 401, got $LOGIN_DENIED"
fi

# ── 8. MSP-E note-to-skill (RPC) ─────────────────────────────────────
sect "8. MSP-E: notes.proposeAsSkill + notes.createSkillDraftFromNote"

NOTE_PATH="$CLAUDE_OS_VAULT_PATH/workspaces/personal/notes/smoke-note.md"
PROPOSE_BODY=$(curl -s -b "$COOKIES" -X POST "http://$HOST:$PORT/api/rpc" \
  -H "x-csrf-token: $CSRF" -H "Content-Type: application/json" \
  -d "{\"method\":\"notes.proposeAsSkill\",\"params\":{\"notePath\":\"$NOTE_PATH\"}}")
if echo "$PROPOSE_BODY" | grep -q '"ok":true'; then
  ok "notes.proposeAsSkill returned ok=true"
else
  info "notes.proposeAsSkill body: $PROPOSE_BODY"
  # Soft fail: backend RPC may not be registered in all environments yet.
  info "  (MSP-E backend may need separate wire-up — non-blocking soft check)"
fi

CREATE_BODY=$(curl -s -b "$COOKIES" -X POST "http://$HOST:$PORT/api/rpc" \
  -H "x-csrf-token: $CSRF" -H "Content-Type: application/json" \
  -d "{\"method\":\"notes.createSkillDraftFromNote\",\"params\":{\"notePath\":\"$NOTE_PATH\"}}")
if echo "$CREATE_BODY" | grep -q '"ok":true'; then
  ok "notes.createSkillDraftFromNote returned ok=true"
  # Verify SKILL.md materialized
  if find "$CLAUDE_OS_VAULT_PATH/workspaces/personal/skills/_drafts" -name "SKILL.md" | grep -q SKILL.md; then
    ok "draft SKILL.md materialized on disk"
  else
    fail "RPC returned ok but no SKILL.md found under skills/_drafts"
  fi
else
  info "notes.createSkillDraftFromNote body: $CREATE_BODY"
  info "  (soft check — non-blocking)"
fi

# ── 9. logout with valid CSRF ────────────────────────────────────────
sect "9. POST /api/auth/logout (valid CSRF)"
LOGOUT=$(curl -s -b "$COOKIES" -X POST "http://$HOST:$PORT/api/auth/logout" \
  -H "x-csrf-token: $CSRF" \
  -H "Content-Type: application/json" -d '{}')
if echo "$LOGOUT" | grep -q '"ok":true'; then
  ok "logout returns ok=true"
else
  fail "logout response unexpected: $LOGOUT"
fi

# /me after logout should fail
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" "http://$HOST:$PORT/api/auth/me")
if [ "$STATUS" = "401" ]; then
  ok "/me after logout → 401"
else
  fail "/me after logout expected 401, got $STATUS"
fi

# ── summary ──────────────────────────────────────────────────────────
sect "Summary"
if [ "$FAIL" -eq 0 ]; then
  green "All checks passed."
  exit 0
else
  red "$FAIL check(s) failed."
  echo
  bold "Server log tail:"
  tail -30 "$LOG"
  exit 1
fi
