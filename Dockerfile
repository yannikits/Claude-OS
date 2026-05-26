# claude-os — Server-Variant Docker image
#
# Builds a headless HTTP-server (Fastify) that exposes the same RPC methods
# as the Tauri sidecar. Frontend is the Vite-built React bundle served
# from /app/gui/dist. Linux `claude` CLI is installed globally via npm.
#
# Implements ADR-0032 phase Web-4.
#
# Build:
#   docker build -t claude-os:local .
# Run:
#   docker run -d \
#     -e CLAUDE_OS_AUTH_TOKEN="$(openssl rand -hex 32)" \
#     -e CLAUDE_OS_SECRETS_PASSPHRASE="$(openssl rand -hex 32)" \
#     -p 127.0.0.1:3000:3000 \
#     -v claude-os-data:/data \
#     --name claude-os claude-os:local

# ---------- Stage 1: backend builder ----------
# Why debian-slim (not alpine):
#  - node-pty has no prebuilt binary for musl libc (alpine) AND none for
#    glibc-linux-x64 in version 1.1.0, so npm always rebuilds it from
#    source. node-gyp needs python3 + build-essential.
#  - Building on alpine would produce a musl-linked .node binary that
#    cannot be copied to the glibc-based runtime stage.
# Both reasons → backend-builder runs on debian-slim too, native modules
# get built ONCE here against glibc, runtime reuses them directly.
FROM node:22-slim AS backend-builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      git \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY tsconfig.json biome.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY src/ ./src/
RUN npm run build
# Prune devDeps in place so the resulting node_modules tree is production-
# clean while keeping the native binaries we just built (e.g. node-pty).
# Runtime stage will copy this directory as-is — no second `npm install`.
RUN npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---------- Stage 2: frontend builder ----------
FROM node:22-alpine AS frontend-builder
WORKDIR /app/gui
COPY gui/package.json gui/package-lock.json ./
RUN npm ci
# Build inputs only — tsbuildinfo, vitest.config, README are devtime artifacts
# and not needed for `vite build`. We skip `tsc -b` (gui/package.json's full
# build script) because runtime only needs the bundled JS; type-checking
# runs in CI / pre-commit, not in the image build.
COPY gui/tsconfig.json gui/vite.config.ts gui/index.html ./
COPY gui/src/ ./src/
RUN npx vite build

# ---------- Stage 3: runtime ----------
# debian-slim matches backend-builder so the prebuilt native modules
# (node-pty .node binaries) load without a re-build at startup.
FROM node:22-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      git \
      ca-certificates \
      wget \
      curl \
 && rm -rf /var/lib/apt/lists/*

# Install official Anthropic Claude Code CLI globally — this is the
# Linux equivalent of the bin/claude.exe used in the Windows/macOS
# Tauri build. claude-bridge resolves it via $PATH walk.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# Compiled backend + production node_modules (already pruned in builder).
# No `npm install` at runtime — no compile chain, no python needed.
COPY package.json package-lock.json ./
COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist ./dist
COPY --from=frontend-builder /app/gui/dist ./gui/dist
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Default env. CLAUDE_OS_AUTH_TOKEN must be supplied by the caller.
ENV NODE_ENV=production
ENV PORT=3000
# Headless container has no OS keyring (no D-Bus / Secret Service);
# force the encrypted-file backend. Master passphrase comes from
# $CLAUDE_OS_SECRETS_PASSPHRASE supplied by the operator.
ENV CLAUDE_OS_SECRETS_BACKEND=encrypted-file
ENV CLAUDE_OS_STATIC_DIR=/app/gui/dist
ENV CLAUDE_OS_LOG_LEVEL=info

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

# Tini is PID 1 to reap zombies + forward signals to node properly.
# Debian path: /usr/bin/tini (alpine had /sbin/tini).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
