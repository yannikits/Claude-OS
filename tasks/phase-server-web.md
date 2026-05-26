# Phase Web — Server-Deployment mit Web-UI

**Ziel:** Claude-OS lässt sich auf einem Linux-Server (Yannik's Homelab: **Proxmox-Virtualisierungshost** → LXC oder VM, OPNsense-Firewall, nginx proxy manager, **Cloudflare-DNS**) in Docker deployen und ist per Browser über das Internet erreichbar. Single-User MVP mit Bearer-Token-Auth, Multi-User-fähig vorbereitet via vorhandener `tenant`-Domain.

**Infrastruktur-Kontext (Yannik's Setup):**
- Virtualisierung: **Proxmox** — claude-os läuft in LXC-Container oder VM (Empfehlung: VM mit Debian-12 + Docker, weil Docker-in-LXC einige Mount/Cgroup-Quirks hat; LXC nur falls Ressourcen-knapp)
- Backup: **Proxmox-Snapshots + Vault-Volume-Backup** (kombiniert: Proxmox-Snapshot der ganzen VM + zusätzlicher rsync-Pull des Vault-Volumes auf ein separates Storage)
- DNS: **Cloudflare** — bietet drei Architektur-Optionen:
  - **A) Klassisch:** A-Record auf DDNS-IP → OPNsense forwarded :443 zu nginx proxy manager → Let's Encrypt TLS am proxy manager. Cloudflare nur als DNS (orange-cloud off / DNS-only)
  - **B) Cloudflare-proxied:** A-Record proxied (orange-cloud on), TLS-Termination an Cloudflare-Edge, Origin-Cert von Cloudflare am nginx proxy manager. Bonus: DDoS-Schutz, kein offener :443 nach außen sichtbar
  - **C) Cloudflare Tunnel:** zero-trust, **gar kein** Port-Forwarding nötig, `cloudflared`-Container im selben Docker-Compose-Stack baut Outbound-Tunnel zu Cloudflare. Empfehlung wenn Außenzugriff sparsam ist und maximale Sicherheit gewünscht
- Domain-Auth optional: **Cloudflare Access** kann als zweite Auth-Schicht vor unseren Bearer-Token gehängt werden (Phase Web-6+ Hinweis, nicht MVP-Pflicht)

**Quelle:** User-Request 2026-05-26 — "Soweit voranbringen, dass ich es auf einem Server wie OpenClaw oder Hermes installieren und per Weboberfläche aufrufen kann."

**Plan-Datum:** 2026-05-26
**Branch:** `feature/phase-web-server-deployment` (off main)
**Status (2026-05-26 abends):** Web-1 + Web-2 + Web-3 + Web-4 + Web-5 Stage 1 + Web-6 **shipped**. **Full feature-parity zur Tauri-Variante erreicht.** Drag-and-Drop läuft jetzt auch im Browser via multipart-upload zu `/api/inbox/upload`. Multi-User via Token-Liste in `.env` (ADR-0033). Web-5 Stage 2 (Login-UI + User-Registrierung) bleibt als eigene Phase offen.

## Shipped Commits

- `c1940ba` Web-1 (backend HTTP-adapter + Fastify + auth + SSE)
- `b730031` Web-2 (frontend transport abstraction + login + AuthGate)
- `341216f` Web-4 + Web-6 (Dockerfile + compose + entrypoint + docs/server-deployment.md)
- … `d02c7ad` `9cda412` `622d1c8` `41cc8a0` `e3daa1a` `a41c7f0` `ff7b7ea` (Dockerfile + entrypoint + headless-fixes von realem Deploy)
- Web-3 (PTY/Chat über WebSocket — pty.* RPCs routen im HTTP-transport über `/api/pty/ws`)

---

## Architektur in 60 Sekunden

```
Browser (HTTPS)
   ↓
nginx proxy manager (TLS, DDNS-Hostname)
   ↓
Docker-Container "claude-os"
   ├── Node-Prozess "serve" (HTTP/SSE auf :3000)
   │     ├── /api/rpc  → bestehender RpcDispatcher + methods.ts
   │     ├── /api/events (SSE) → bestehende emitNotification-Pipe
   │     └── /*  → Static Vite-Build (GUI im "web mode")
   ├── bin/claude (Linux-CLI) — spawn-target von claude-bridge
   └── /data (Volume) — Vault, .claude-os/, .claude-credentials/
```

**Wiederverwendung (kein Neuschreiben):**
- `RpcDispatcher` aus `src/sidecar/rpc.ts` — nur neuer Adapter rundherum
- `registerMethods()` aus `src/sidecar/methods.ts` — komplett unverändert
- `EncryptedFileStore` aus `src/domains/secrets/` — schon vorhanden, wird via env erzwungen
- `tenant`-Domain — single-user-Token resolved zu Default-Tenant; multi-user später ein Drop-in
- Bestehende React-Pages — RPC-Layer wird abstrahiert, Pages selbst unverändert

**Neu zu bauen:**
- HTTP/SSE-Transport-Adapter (`src/server/`)
- Auth-Middleware (Bearer-Token-Vergleich, konstant-zeitlich)
- Frontend-RPC-Abstraktion mit Build-Switch Tauri vs. HTTP
- Vite-Web-Build-Variante (Tauri-Imports lazy / behind Feature-Flag)
- Dockerfile + docker-compose.yml
- `claude-os serve` CLI-Command
- Setup-Doku (deutsch)

---

## Phasen

### Phase Web-1 — Server-Transport-Adapter (Backend)

**Ziel:** Bestehende RPC-Methoden über HTTP statt stdio erreichbar machen.

- [x] `src/server/types.ts` — typed config (port, host, authToken, corsOrigin, dataDir)
- [x] `src/server/auth.ts` — Bearer-Token-Middleware, konstant-zeitlicher Vergleich via `crypto.timingSafeEqual`, ungesetztes Token = Service-Refuse-Boot (nicht "offen")
- [x] `src/server/rpc-http.ts` — `POST /api/rpc` Handler, delegiert an `RpcDispatcher`, mappt RPC-Errors auf HTTP-Status (400 invalid-params, 404 method-not-found, 500 internal)
- [x] `src/server/events-sse.ts` — `GET /api/events` SSE-Stream, replaces `emitNotification` für connected Clients (in-memory subscriber-set, heartbeat alle 30s)
- [x] `src/server/static.ts` — Static-File-Serve mit SPA-Fallback (Vite-Build aus `gui/dist/`), korrekte MIME + immutable-Cache für hashed assets
- [x] `src/server/index.ts` — `startServer(config)` Composer, Express oder Fastify (Vorschlag: **Fastify** — kleiner, async-native, schneller; `pino` ist schon im Repo)
- [x] `src/cli/commands/serve.ts` — Commander-Subcommand `claude-os serve [--port 3000] [--host 0.0.0.0]`, liest Auth-Token aus `$CLAUDE_OS_AUTH_TOKEN` (Pflicht)
- [x] Wire-up in `src/cli/index.ts`
- [x] Vitest: server-side roundtrip-Test (start → POST rpc → result; SSE event-flow; auth-reject ohne/mit falschem Token)
- [x] Smoke-Test: `claude-os serve` lokal starten, `curl -H "Authorization: Bearer …" -d '{"method":"ping"}' /api/rpc` → `{pong: true}`

**DoD Web-1:** `curl` gegen alle bestehenden `read-only` RPCs (ping, catalog.list, vault.status, agent.list, workspace.list, notes.list, retrieval.search, auth.status) funktioniert; falsches/fehlendes Token → 401; SSE liefert mindestens Heartbeats.

---

### Phase Web-2 — Frontend RPC-Abstraktion (Web-Build)

**Ziel:** Bestehender React-Code läuft unverändert sowohl in Tauri als auch im Browser.

- [x] `gui/src/lib/rpc-transport.ts` — Interface `RpcTransport { call(method, params); subscribe(eventName, handler) }`
- [x] `gui/src/lib/rpc-tauri.ts` — bestehende `invoke()` / `listen()`-Logik, eingepackt
- [x] `gui/src/lib/rpc-http.ts` — `fetch` gegen `/api/rpc`, `EventSource` gegen `/api/events`, Auth-Token aus `sessionStorage` (Login-Page erfasst, in-memory)
- [x] `gui/src/lib/rpc.ts` — entscheidet zur Runtime: `window.__TAURI_INTERNALS__` → Tauri, sonst → HTTP. Alle bestehenden `rpcCall`/`onX`-Helper bleiben byte-identisch
- [x] `gui/src/pages/login.tsx` — minimal: Token-Input, `POST /api/auth/verify`, bei OK → sessionStorage + redirect, bei FAIL → Error
- [x] `src/server/auth.ts` — neuer Endpunkt `POST /api/auth/verify` (gleiche Token-Check, returnt `{ok: true}`)
- [x] `gui/src/App.tsx` — `AuthGate`-Wrapper: kein Token → `<LoginPage/>`, sonst Router wie bisher (Tauri umgeht das via Flag)
- [x] `gui/vite.config.ts` — Build-Variante: `TAURI_BUILD=1` lässt aktuelle Bundle, ungesetzt produziert "web mode" (gleicher Output, beide Transports compiled-in)
- [x] Vitest gui-side: Transport-Detection-Logik

**Out-of-scope hier (Phase Web-3 / -4):**
- Drag-Drop in Web (Browser-File-API statt Tauri-DragDrop) — Stub-Komponente "im Web noch nicht unterstützt"
- PTY/Chat-Streaming via WebSocket (Phase Web-3 — eigene WS-Endpunkte, xterm.js braucht WS nicht SSE)
- `setSecretNative` (Tauri-only Dialog) — Web-Fallback ist die bestehende Inline-Form

**DoD Web-2:** `npm run build` im gui/ erzeugt Web-Bundle; lokal `claude-os serve` + Browser zu `localhost:3000` → Login → Dashboard zeigt alle Cards (sidecar ping, catalog count, vault status, agent count). Tauri-Build funktioniert weiterhin.

---

### Phase Web-3 — Chat / PTY über WebSocket

**Ziel:** Interaktive Claude-Sessions im Browser.

- [x] `src/server/ws-pty.ts` — `WS /api/pty/ws` upgrade-Handler, bridged stdin/stdout zu `PtyChatSessions`
- [x] Auth via Query-Param-Token (Browser-EventSource/WebSocket können keine custom-headers)
- [x] `gui/src/lib/rpc-http.ts` — WebSocket-Variante; pty.* RPCs + pty.data/exit Subscriptions transparent über WS gerouted
- [x] xterm.js arbeitet 1:1 — terminal-Frontend bleibt unverändert (transparent transport-switch)

**DoD Web-3:** ChatPage im Browser sendet Tastatureingaben an `claude` und sieht Output in Echtzeit. Resize funktioniert.

---

### Phase Web-4 — Docker + Distribution

**Ziel:** Yannik baut auf seinem Server `docker compose up -d` und es läuft.

- [x] `Dockerfile` — multi-stage:
  - Stage 1: `node:22-alpine` mit `npm ci && npm run build`
  - Stage 2: gui-build (`npm ci && npm run build` in `gui/`, ohne Tauri-Bits)
  - Stage 3: Runtime `node:22-alpine` mit nur `dist/`, `gui/dist/`, `node_modules` (prod-only), Linux-`claude`-CLI als Layer
- [x] `docker/install-claude-cli.sh` — Download offizielles Linux-claude-Binary (Hash-pinned), exit 1 bei Mismatch
- [x] `docker-compose.example.yml` — single-service, port 3000, Volumes für Vault + Config + Anthropic-Auth-Dir
- [x] `.dockerignore` — minimal, `node_modules`, `dist`, `tests`, `tasks`, `gui/src-tauri/target`
- [x] `docker/entrypoint.sh` — pre-flight (env-check, vault-mount-check, doctor-run), dann `claude-os serve`
- [x] CI: `.github/workflows/docker.yml` baut `linux/amd64` + `linux/arm64` Image und pushed ghcr.io tag bei Release

**DoD Web-4:** `docker compose up -d` auf einem leeren Linux-Host bringt einen erreichbaren Service hoch (lokal getestet via `localhost:3000`).

---

### Phase Web-5 — First-Time-Auth + Tenant-Vorbereitung

**Ziel:** Claude-CLI-Login im Container, Workspace-Persistenz, Tenant-Resolver bereit für Multi-User.

- [ ] `docs/server-deployment.md` — Setup-Schritt: `docker exec -it claude-os claude auth login` → DeviceCode-Flow im Browser → Auth-File persistiert in Volume
- [x] `src/server/auth.ts` — Token-Validation triggert TenantContext-Resolver mit Single-User-Default; Tenant-ID ist Token-Hash (so steht der Multi-User-Switch später bei: Token-Tabelle statt Single-Token)
- [ ] `src/domains/tenant/` Wrapper-Methode `resolveTenantFromToken(token): TenantContext` — als public-Interface dokumentieren
- [ ] Doctor-Check `serverEnvOk`: prüft `CLAUDE_OS_AUTH_TOKEN` gesetzt, `CLAUDE_OS_SECRETS_BACKEND=file`, `CLAUDE_OS_VAULT_PATH` erreichbar; runs in entrypoint.sh

**DoD Web-5:** Yannik macht `claude auth login` einmalig, danach überleben Container-Restarts die Auth. Tenant-Resolver gibt für gegebenen Token konsistent denselben Workspace zurück.

---

### Phase Web-6 — Setup-Doku (deutsch, user-facing)

**Ziel:** Yannik (oder ein anderer Self-Host-Nutzer) kommt in 30 Minuten zum laufenden System.

- [x] `docs/server-deployment.md` mit Sektionen:
  - **Voraussetzungen** (Linux-Host, Docker, optional nginx proxy manager) — Proxmox-Hinweis: VM mit Debian 12 + Docker bevorzugt, LXC als Alt
  - **VM/LXC-Setup auf Proxmox** (kurz: Template, CPU/RAM-Empfehlung, Storage)
  - **1.** `docker-compose.yml` anpassen (Volumes, Token generieren via `openssl rand -hex 32`)
  - **2.** Container starten, `docker exec` Auth-Login (`claude auth login` DeviceCode-Flow)
  - **3a.** Klassisch (Cloudflare DNS-only + nginx proxy manager + Let's Encrypt)
  - **3b.** Cloudflare-proxied (orange-cloud + Origin-Cert am nginx proxy manager)
  - **3c.** Cloudflare Tunnel (zero-trust, `cloudflared` als Sidecar-Container, **keine** Port-Forwards auf OPNsense)
  - **4.** Cloudflare-DNS: A-Record / Proxy-Toggle / TTL / DDNS-Update via `cloudflare-ddns` falls dynamische IP
  - **5.** Verify: Browser → Login → Dashboard
  - **6.** Backup-Strategie: **Proxmox-Snapshot der VM** (regelmäßig) + zusätzlich **rsync-Pull des Vault-Volumes** auf separates Storage (defense-in-depth: Snapshot kann auch korrupten Zustand einfrieren)
  - **7.** Troubleshooting (logs, doctor, common errors)
  - **8.** Optionaler Hardening-Pfad: Cloudflare Access als zweite Auth-Schicht (nur wenn man später Family/Team-Zugriff zulassen will)
- [x] Update `README.md`: neuer Abschnitt "Server-Deployment" mit Link
- [x] `ROADMAP.md`: "Phase Web" als geshippte Phase markieren
- [x] ADR-0032 finalisieren (siehe `docs/architecture/adr/0032-server-deployment-headless-http.md`)

**DoD Web-6:** Doku ist abgeschlossen, ein Outside-Tester (oder Yannik selbst from-scratch) kann ohne Rückfragen deployen.

---

## Out-of-Scope (bewusst nicht in dieser Phase)

- **Multi-User echt**: Phase Web-5 bereitet vor, aber Login/Registrierung/User-Management ist eigene Phase
- **Public-Internet-MSP-Bridges**: `claude-os-msp` ist separates Repo (ADR-0030); Server-Variante hier ist Personal-Workspace-only
- **OAuth-Provider statt Bearer-Token**: Bearer reicht für Single-User; OAuth (GitHub/Google) wäre Multi-User-Begleitung
- **Mobile-App**: Web-UI ist mobile-responsive (existierendes CSS prüfen), aber keine native App
- **PWA / offline-Modus**: Nicht in MVP

---

## Reihenfolge-Regeln

- Web-1 (Server-Transport) **vor** Web-2 (Frontend) — sonst nichts zu callen
- Web-2 **vor** Web-3 (Chat-PTY) — PTY ist additiv, nicht Voraussetzung
- Web-3 **kann parallel** zu Web-4 (Docker) gebaut werden
- Web-5 (Auth-Setup) **vor** Web-6 (Doku) — Doku beschreibt den realen Setup-Flow
- Web-6 **immer letzte**

## Geschwindigkeits-Schätzung

| Phase | Aufwand | Komplexität |
|---|---|---|
| Web-1 Server-Transport | 4-6 h | M |
| Web-2 Frontend-Abstr. | 3-5 h | M |
| Web-3 PTY-WS | 3-4 h | M |
| Web-4 Docker | 2-3 h | S |
| Web-5 Auth-Setup | 2 h | S |
| Web-6 Doku | 2-3 h | S |
| **Gesamt** | **16-23 h** | |

MVP-Pfad (Web-1 → -2 → -4 → -5 → -6, Chat später): ~13 h, Yannik hat dann eine **vollständig im Browser nutzbare Memory + Vault + Catalog-Oberfläche**, nur Chat fehlt initial.

## Klärungspunkte (warten auf Yannik-OK)

1. **HTTP-Framework**: Fastify (Vorschlag — async-native, leichter, `pino` integration) oder Express (etablierter)?
2. **Branch-Name**: `feature/phase-web-server-deployment` ok? Off main.
3. **Image-Registry**: `ghcr.io/iteenschmiede/claude-os` ok für GitHub Actions?
4. **MVP-Pfad**: erstmal Web-1/-2/-4/-5/-6 ohne Chat, oder Chat (Web-3) gleich mit?
5. **Bestehender PR-Stack**: aktueller Branch `feature/phase-8-tauri-updater-scaffold` — bleibt unverändert, Server-Phase ist orthogonal. OK?
6. **Proxmox-Deployment-Form**: VM mit Debian-12 + Docker (Vorschlag, robust) oder LXC mit Docker (leichter, aber Cgroup/AppArmor-Quirks)? Empfehlung: VM, LXC nur falls explizit RAM-knapp.
7. **Cloudflare-Variante**: A klassisch / B proxied / C Tunnel — welche Doku-Variante priorisieren? Vorschlag: **alle drei dokumentieren**, **B proxied als Default-Empfehlung** (DDoS-Schutz + kein Origin-IP-Leak, ohne den Tunnel-Aufwand).
8. **Cloudflare Tunnel als Compose-Service**: soll `cloudflared` direkt im `docker-compose.example.yml` als optionaler 2. Service drin sein (kommentiert)? Vorschlag: ja, macht's für Self-Hoster trivial.
