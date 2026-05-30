# Claude OS — Architektur

Bei Konflikt mit historischen Spec-Dokumenten gewinnt dieses Dokument. ADR-Entscheidungen liegen in `tasks/adr/`.

## 1. Stack (entschieden)

| Schicht | Wahl | ADR |
|---|---|---|
| Runtime | Node.js + TypeScript | — (im Repo etabliert) |
| Package-Manager | npm (package-lock.json) | — |
| GUI-Framework | Tauri (Rust + Vite/TS) | — |
| CLI-Framework | Commander.js | — |
| Linter/Formatter | Biome | — |
| Test-Runner | Vitest | — |
| Schema-Validation | TypeBox (`@sinclair/typebox`) | — |
| Secrets-Storage | NAPI-RS Keyring | siehe `SECURITY.md` §3 |
| Agent-Protocol | MCP (`@modelcontextprotocol/sdk`) | — |
| Inter-Process | Tauri Sidecar (Node-Process unter Tauri-Shell) | — |
| AI-Interaktion | Delegation an `bin/claude.exe` (kein eigenes Provider-Interface) | ADR-0003 |
| Anthropic-Auth | State-Check via `claude auth status` + Refresh-Mutex + Multi-Profile via `$ANTHROPIC_CONFIG_DIR` | ADR-0011 |
| Memory-Index | FTS5 in SQLite + watchdog | ADR-0025 |
| Lizenz | MIT (für Public-Core) | ADR-0029 |
| Repo-Strategie | Hybrid Public-Core + Private MSP-Bridges + Private House-Watch | ADR-0030 |
| Vault-Strategie | Multi-Workspace mit `personal/` als Default | ADR-0031 |

## 2. Repo-Struktur

```
Claude-portable/                      # Public, MIT, dieses Repo
├── CLAUDE.md                         # Verhalten
├── ARCHITECTURE.md                   # diese Datei
├── ROADMAP.md                        # Phasen + DoD
├── SECURITY.md                       # Trust, Audit, MSP-Gates
├── SOUL.md                           # Identität (geplant)
├── TOOLS.md                          # Tool-Inventar (geplant)
├── AGENTS.md                         # Agent-Rollen
├── README.md                         # User-facing
├── docs/
│   ├── gitnexus.md                   # Code-Intelligence-Workflow
│   └── ...                           # weitere Docs
├── src/
│   ├── core/
│   │   ├── audit/                    # Append-only JSONL audit-log (Phase 6 foundation)
│   │   ├── config/                   # .env loader + AppEnv (Phase 2a)
│   │   ├── doctor/                   # Self-diagnostic checks
│   │   ├── environment/              # claude-os-root resolver (ADR-0002)
│   │   ├── git-metadata/             # External git-dir migrator
│   │   ├── logging/                  # pino factory + redact-paths
│   │   ├── paths/                    # Platform-aware per-machine paths
│   │   ├── schemas/                  # TypeBox environment-manifest
│   │   └── validation/               # TypeBox/Ajv error formatter
│   ├── domains/                      # DDD bounded contexts
│   │   ├── agent-runs/               # JSONL agent-run log + index
│   │   ├── ask/                      # Prompt-Composer für claude.exe-Delegation (Phase 2e)
│   │   ├── auth/                     # Anthropic CLI auth state-check (ADR-0011)
│   │   ├── catalog/                  # Skill/Plugin/MCP marketplace + lock
│   │   ├── claude-bridge/            # Anthropic-claude.exe-Bridge (ADR-0003)
│   │   ├── mcp-clients/              # MCP-Server-Watcher + Trust-Store (ADR-0024)
│   │   ├── memory-index/             # sql.js FTS4 + indexer + watcher + search (Phase 3)
│   │   ├── notes/                    # Frontmatter-validated Markdown-Notes (Phase 2b)
│   │   ├── retrieval/                # BM25 linear-scan + fallback dispatcher (Phase 2c+3e)
│   │   ├── scheduler/                # Cron-style scheduler (v1.5)
│   │   ├── secrets/                  # KeyringStore + EncryptedFileStore (ADR-0004)
│   │   ├── skill-lifecycle/          # Lessons-reader + draft-generator (Phase 5 foundation)
│   │   ├── skills/                   # SKILL.md loader + BM25 matcher (Phase 4)
│   │   ├── tenant/                   # Tenant-Isolation guards (Phase 6 foundation per ADR-0027)
│   │   ├── update-orchestrator/      # Tiered auto-update (ADR-0005)
│   │   ├── vault-sync/               # Branch-aware snapshot-sync (obsidian-git-pattern)
│   │   └── workspace/                # Multi-Workspace per ADR-0031 (Phase 2a)
│   ├── mcp/                          # MCP-Server + Tool-Registry
│   ├── sidecar/                      # Tauri-Sidecar-Bridge (JSON-RPC NDJSON)
│   └── cli/                          # Commander-Entrypoints
├── gui/                              # Tauri (src-tauri/ + Vite-Frontend)
├── workspace/
│   └── skills/<name>/SKILL.md        # User-Skills (heilig)
├── tasks/
│   ├── todo.md
│   ├── lessons.md
│   └── adr/                          # Architecture Decision Records
└── tests/                            # Vitest-Spiegel

claude-os-msp/                        # Private repo (separat)
└── src/domains/
    ├── tanss-bridge/
    ├── ninja-bridge/
    ├── veeam-bridge/
    ├── m365-bridge/
    └── securepoint-bridge/

house-watch/                          # Private repo (separat)
└── src/                              # Immobilien-Crawler
```

> **Stand 2026-05-30 — Drift-Hinweis:** Der oben skizzierte Public/Private-Split (separates Repo `claude-os-msp`, ADR-0030) wurde für die MSP-Bridges **nicht ausgeführt**. Tatsächlich liegen alle implementierten Bridges (TANSS/Veeam/Sophos/Securepoint) im **Monorepo** `yannikits/Claude-OS` unter `src/domains/msp-bridges/` (Phase 7-C/D). Neuer MSP-Code (Automations-Engine, Write-Actions, NinjaOne) kommt ebenfalls dorthin. Eine formale ADR-0030-Amendment steht aus. `house-watch` bleibt als separates Repo geplant.

MSP-Bridges und House-Watch konsumieren `Claude-portable` als npm-Dependency oder Git-Submodule. Niemals umgekehrt.

## 3. Domain Boundaries (DDD)

### Core (`src/core/*`)

| Context | Verantwortung | Externe Dependencies |
|---|---|---|
| `audit` | Append-only JSONL audit-log per UTC-day, file mode 0o600 (Phase 6 foundation per ADR-0027 + SECURITY.md §4) | (none — pure fs + os.hostname) |
| `config` | `.env`-Loader via dotenv, typed `AppEnv` view of `CLAUDE_OS_VAULT_PATH` etc. (Phase 2a) | `dotenv` |
| `doctor` | 5-Check self-diagnostic suite (Mount, Node-Version, Git, bin/claude, Schreibrechte) | (none) |
| `environment` | `claude-os-root` resolver via marker/env/repo-detect, cloud-provider detection (ADR-0002) | `simple-git` (in git-metadata) |
| `logging` | pino factory mit Redaction-Path-Liste (Pflicht-Code-Review-Gate für neue paths) | `pino` |
| `paths` | Platform-aware per-machine paths (`%APPDATA%/claude-os/` vs `~/.config/claude-os/`) | (none) |
| `validation` | TypeBox/Ajv error formatter (JSON-Pointer → dotted-bracket) | `@sinclair/typebox` |

### Domains (`src/domains/*`)

| Context | Repo | Verantwortung | Phase / ADR |
|---|---|---|---|
| `agent-runs` | public | JSONL agent-run log + index | (existing) |
| `ask` | public | Prompt-Composer für claude.exe-Delegation: query + retrieval-hits → composed prompt | Phase 2e (ADR-0003) |
| `auth` | public | Anthropic-CLI Auth State-Check, Multi-Profile via `$ANTHROPIC_CONFIG_DIR` | ADR-0011 |
| `catalog` | public | Skill/Plugin/MCP Marketplace + Lock | (existing) |
| `claude-bridge` | public | Anthropic-`claude.exe`-Subprocess-Bridge: spawn lifecycle, heartbeat, SIGINT-grace, secrets-strip | ADR-0003 + ADR-0021 |
| `mcp-clients` | public | MCP-Server-Watcher + Trust-Store (Acknowledge-Modal) | ADR-0024 |
| `memory-index` | public | sql.js FTS4 + indexer + chokidar-watcher + BM25-search drop-in | Phase 3 (ADR-0025) |
| `notes` | public | Frontmatter-validated Markdown-Notes (TypeBox-Schema) — read lenient, write strict | Phase 2b (ADR-0031) |
| `retrieval` | public | Phase-2c BM25 linear-scan + Phase-3e fallback-dispatcher (FTS-first, linear-fallback) | Phase 2c/3e |
| `scheduler` | public | Cron-style scheduler runner | (existing) |
| `secrets` | public | KeyringStore + EncryptedFileStore (AES-256-GCM, PBKDF2-SHA-256 600k) | ADR-0004 |
| `skill-lifecycle` | public | Lessons-Reader (`tasks/lessons.md`) + Draft-Generator (`_drafts/` bucket). Sandbox/Signature/Review-UI gated. | Phase 5 (ADR-0026) |
| `skills` | public | Workspace-scoped SKILL.md Loader + BM25 Description-Matcher. Strict skill-name validation refuses malicious paths. | Phase 4 |
| `tenant` | public | `TenantContext` resolver + `assertActiveTenant` / `assertNoActiveTenant` guards. Bridge-Calls in `claude-os-msp` importieren das hier. | Phase 6 foundation (ADR-0027 + ADR-0031) |
| `update-orchestrator` | public | Tiered auto-update mit Backup + Diff-Review + Resumable-Checklist | ADR-0005 |
| `vault-sync` | public | Branch-aware Snapshot-Sync für Vault (obsidian-git-Pattern), 3-Modi Conflict-Policy | (existing) |
| `workspace` | public | Multi-Workspace per ADR-0031: paths, vault-resolver, atomic active-state, audit-log shim | Phase 2a (ADR-0031) |
| `tanss-bridge` / `ninja-bridge` / `veeam-bridge` / `m365-bridge` / `securepoint-bridge` | **private MSP-Repo `claude-os-msp`** | API-Clients mit Approval-Gates (Phase 6 read, Phase 7 write). Importieren `audit` + `tenant` aus Public-Core. | ADR-0027 + ADR-0030 |
| `house-watch` | **private House-Repo** | Immobilien-Crawler | ADR-0030 |

**Regel:** Domains rufen einander nur über definierte Public-Interfaces an. Keine direkten Datenstruktur-Imports zwischen `domains/*`. Private MSP/House-Repos konsumieren `Claude-portable` als npm-Dependency oder Git-Submodule — **niemals umgekehrt** (Public-Core kennt keine Customer-Internals).

## 4. AI-Layer (Claude-Bridge)

**Kein eigenes Provider-Interface.** Die AI-Interaktion läuft per Delegation an `bin/claude.exe` (ADR-0003 Hybrid-CLI). Stream-JSON, Tool-Use, Plan-Mode, Slash-Commands liegen vollständig in Anthropics Hand.

- **Modul:** `src/domains/claude-bridge/` — Subprocess-Spawn-Lifecycle via `stdio:'inherit'` (by-design kein Buffer-Hang, **kein** Wrapper-Timeout — Memory 569/577/578), SIGINT-Propagation mit 5s-Grace → SIGKILL (double-Ctrl-C eskaliert sofort), Heartbeat-Logging alle 10s als pino-strukturiertes Event
- **Interaktive Sessions:** node-pty + xterm.js (ADR-0021)
- **Auth:** Read-only auf Anthropic-CLI-Credentials, State-Check via `claude auth status`, Refresh-Mutex (ADR-0011)
- **Multi-Profile:** `$ANTHROPIC_CONFIG_DIR` sandboxt pro-Profil-Spawns (ADR-0011 §4)
- **Modell-Auswahl:** wird durch `claude.exe` selbst gemanaged, nicht durch claude-os

Falls jemals ein zweiter Provider relevant wird (OpenRouter, lokales Modell): eigenes ADR. Kein vorgezogenes Multi-Provider-Interface — YAGNI.

## 5. Memory-Layer

### 5.1 Vault als Source of Truth (Multi-Workspace)

```
<vault-root>/Claude-OS/
├── workspaces/
│   ├── personal/                     # Default — Yannik privat
│   │   ├── Sessions/YYYY/MM/
│   │   ├── Skills-Memory/
│   │   ├── People/
│   │   └── Projects/
│   ├── msp-internal/                 # Allgemeine MSP-Doku (nicht customer-spezifisch)
│   │   └── ...
│   └── msp-customers/
│       └── <customer-id>/            # Tenant-isoliert pro Customer
│           └── ...
└── .claude-os/
    └── index.db                      # FTS5 mit workspace-column
```

Vault-Pfad in `.env` als `CLAUDE_OS_VAULT_PATH`. Aktiver Workspace als Session-State, expliziter Wechsel per CLI/GUI.

### 5.2 Frontmatter (Pflicht)

```yaml
---
created: 2026-05-24T03:30:00Z
updated: 2026-05-24T03:30:00Z
tags: [...]
type: session|skill-memory|person|project
classification: personal|operational|customer-confidential|secret|ephemeral
workspace: personal             # oder msp-internal | msp-customers/<id>
schema_version: 1
---
```

Fehlende `classification` → fail-safe `customer-confidential` (siehe `SECURITY.md` §2).

### 5.3 FTS5-Index (ADR-002)

- SQLite-DB unter `<vault>/.claude-os/index.db`
- Re-Indexierung trigger-basiert (watchdog auf Vault-Mutations)
- Schema: `documents(path, workspace, frontmatter_json, body, mtime, classification)` + FTS5-Virtual-Table
- **Conflict-Resolution:** Vault ist Source-of-Truth; bei Index-Inkonsistenz wird neu indexiert, nie der Vault korrigiert
- **Failure-Mode:** Linear-Scan-Fallback, kein Crash

### 5.4 Context-Injection

- Top-K Retrieval-Policy (nicht starre 30 %): Ranking aus Recency + Source-Type + Classification-Trust + FTS-Match
- **Workspace-Scope:** nur aktiver Workspace, niemals cross-workspace by default
- `SOUL.md` immer geladen
- Aktive `Projects/*.md` mit `status: active`
- `customer-confidential` niemals automatisch — nur auf explizite Anforderung

## 6. Concurrency-Modell

- **I/O-Default:** async/await (`fs/promises`, `fetch`)
- **Parallel-Fan-out:** `Promise.all` mit semaphore-begrenztem Pool (max 8)
- **Worker-Threads** nur für CPU-bound Tasks (FTS-Index-Build), explizit dokumentiert

## 7. Trust-Boundaries

Von vertraut nach un-vertraut:
1. Local User (Yannik) — full trust
2. `CLAUDE.md` / `SOUL.md` / `SECURITY.md` — repo-verifizierte Policies
3. Lokaler Vault — vertraut, aber `classification`-Frontmatter respektieren
4. Workspace-Skills — vertraut nach Erstellung; vor Erstellung quarantänisiert
5. MCP-Tools (built-in) — vertraut nach Schema-Validation
6. MSP-API-Responses — un-vertraut, immer validieren
7. Web-Content (defuddle etc.) — un-vertraut
8. Self-improving Skill-Drafts — un-vertraut, Sandbox + Review (siehe ADR-003)

## 8. Failure-Mode-Design

| Failure | Verhalten |
|---|---|
| Vault unavailable | Read-only-Modus, klare Fehlermeldung, kein Crash |
| FTS-Index korrupt | Auto-Rebuild im Background, Linear-Scan als Fallback |
| Provider-API down | klar fehlschlagen mit Hint auf `.env`-Modell-Switch; kein silent fallback |
| MCP-Tool wirft | Logging mit Correlation-ID, kein silent catch |
| Sidecar-Process crasht | Auto-Restart mit Exponential-Backoff, max 3 Versuche, dann GUI-Notification |
| Memory-Konflikt | User-Notify "Konflikt erkannt", keine Auto-Resolution |

## 9. Versioning & Migration

- **Vault-Frontmatter-Schema:** `schema_version` als Integer, Migrations in `src/domains/vault-sync/migrations/`
- **SQLite-Index:** eigene Migration-Files, never destructive
- **Skill-Format:** `version` in SKILL.md-Frontmatter, breaking-changes mit Migrations-Doku
- **MCP-Tool-Schemas:** semver in `TOOLS.md`

## 10. Packaging & Distribution

- **Tauri-Bundle:** MSI für Windows (Primary), DMG für macOS (Secondary), Linux best-effort
- **Sidecar:** als Tauri-managed externalBin
- **Update-Strategie:** Tauri-Updater + GitHub-Release-Source (ADR-005 vor v1.0)
- **Code-Signing:** offen — ADR vor v1.0
- **Config-Locations:**
  - User-Config: `%APPDATA%\claude-os\config.json` (Win) / `~/Library/Application Support/claude-os/` (mac)
  - Project-Config: `<repo>/.claude-os/`
  - Secrets: NAPI-RS Keyring (siehe `SECURITY.md`)

## 11. ADRs (Details in `docs/architecture/adr/`)

**Bestehende, relevante ADRs (im Repo seit 2026-05-15..23):**

| ADR | Thema |
|---|---|
| [0001](docs/architecture/adr/0001-gui-framework-tauri.md) | GUI-Framework Tauri 2.x |
| [0003](docs/architecture/adr/0003-hybrid-cli-with-claude-exe-delegation.md) | Hybrid-CLI mit claude.exe-Delegation (AI-Layer) |
| [0004](docs/architecture/adr/0004-secrets-via-napi-rs-keyring.md) | Secrets via NAPI-RS Keyring |
| [0006](docs/architecture/adr/0006-tauri-node-sidecar-ipc.md) | Tauri ↔ Node-Sidecar IPC |
| [0011](docs/architecture/adr/0011-anthropic-cli-auth-integration.md) | Anthropic-CLI Auth-Integration |
| [0012](docs/architecture/adr/0012-schema-validation-typebox.md) | Schema-Validation mit TypeBox |
| [0014](docs/architecture/adr/0014-code-quality-biome.md) | Code-Quality-Toolchain Biome |
| [0018](docs/architecture/adr/0018-appimage-zsync-self-update.md) | AppImage zsync Self-Update (Linux) |
| [0024](docs/architecture/adr/0024-mcp-trust-prompt-model.md) | MCP-Server Trust-Prompt-Model |

**Neu mit dem Spec-Split (2026-05-24):**

| ADR | Thema | Entscheidung |
|---|---|---|
| [0025](docs/architecture/adr/0025-memory-indexing-fts5.md) | Memory-Indexierung | FTS5 in SQLite + watchdog, workspace-Spalte |
| [0026](docs/architecture/adr/0026-skill-auto-promotion-lifecycle.md) | Skill-Auto-Promotion | Lifecycle draft→quarantined→reviewed→active, Sandbox + Yannik-Signatur |
| [0027](docs/architecture/adr/0027-msp-bridge-permission-model.md) | MSP-Bridge Permission | Read-only Phase 6, Write Phase 7 mit Approval-Gate |
| [0028](docs/architecture/adr/0028-tauri-updater-windows-macos.md) | Update-Mechanismus Win/Mac | Tauri-Updater + GitHub-Release-Manifest (Linux bleibt ADR-0018) |
| [0029](docs/architecture/adr/0029-license-mit-public-core.md) | Lizenz | MIT für Public-Core, proprietär für MSP-/House-Repos |
| [0030](docs/architecture/adr/0030-repo-strategy-hybrid.md) | Repo-Strategie | Hybrid Public-Core + Private MSP-Bridges + Private House-Watch |
| [0031](docs/architecture/adr/0031-vault-multi-workspace.md) | Vault-Strategie | Multi-Workspace mit `personal/` als Default |
