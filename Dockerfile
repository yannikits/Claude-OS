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
FROM node:22-alpine AS backend-builder
WORKDIR /app
# Install build-deps for native modules (proper-lockfile, sql.js may need them)
RUN apk add --no-cache python3 make g++ git
COPY package.json package-lock.json ./
COPY tsconfig.json biome.json ./
RUN npm ci --include=dev
COPY src/ ./src/
RUN npm run build

# ---------- Stage 2: frontend builder ----------
FROM node:22-alpine AS frontend-builder
WORKDIR /app/gui
COPY gui/package.json gui/package-lock.json ./
RUN npm ci
COPY gui/tsconfig.json gui/tsconfig.app.json gui/tsconfig.node.json gui/vite.config.ts ./
COPY gui/index.html ./
COPY gui/src/ ./src/
RUN npx vite build

# ---------- Stage 3: runtime ----------
FROM node:22-alpine AS runtime
RUN apk add --no-cache \
      tini \
      git \
      ca-certificates \
      wget \
      curl

# Install official Anthropic Claude Code CLI globally — this is the
# Linux equivalent of the bin/claude.exe used in the Windows/macOS
# Tauri build. claude-bridge resolves it via $PATH walk.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# Production-only dependencies. We need the same node_modules layout the
# compiled dist/ expects, but no devDeps (Biome, Vitest, etc.).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# Compiled backend + built frontend
COPY --from=backend-builder /app/dist ./dist
COPY --from=frontend-builder /app/gui/dist ./gui/dist
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Default env. CLAUDE_OS_AUTH_TOKEN must be supplied by the caller.
ENV NODE_ENV=production
ENV PORT=3000
ENV CLAUDE_OS_SECRETS_BACKEND=file
ENV CLAUDE_OS_STATIC_DIR=/app/gui/dist
ENV CLAUDE_OS_LOG_LEVEL=info

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

# Tini is PID 1 to reap zombies + forward signals to node properly.
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
