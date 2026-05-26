# Claude Develop Environment OS

OS-unabhängige Entwicklungs-Umgebung rund um Anthropic Claude. Tauri-GUI + Node-CLI + cloud-mount Vault-Sync.

> **Status (2026-05-26):** Post-Spec-Split nutzt das Repo die ROADMAP-Phasen-Struktur — siehe [`ROADMAP.md`](ROADMAP.md) als authoritative Statusquelle.
>
> - **In main:** Phasen 0–6 als Code shipped via PRs #135–150. Memory-MVP-Workflow funktional (CLI + GUI), FTS-Index-Layer, Skill-Engine, Skill-Lifecycle-Foundation, Public-Core-Foundation für MSP-Bridges (audit + tenant). ~1150+ vitest cases grün (3 long-running gated hinter `RUN_SLOW_TESTS=1`).
> - **CI:** grün auf ubuntu/win/macos × `cli` / `rust-shell` / `gui-typecheck`. Bundle pipeline (MSI/DMG/AppImage) grün.
> - **GUI:** Dashboard + Memory-Page + 7 weitere Views functional, Drag-Drop end-to-end (siehe [`docs/migration-from-portable.md`](docs/migration-from-portable.md) für Setup, [`gui/README.md`](gui/README.md) für GUI-Build).
> - **Vorgänger:** `claude-portable` (USB-only Variante). Die alten Launch-Scripts liegen in `legacy/` und sind nicht mehr aktiv.

## Was es ist

Eine cross-Machine konsistente Claude-Umgebung mit einer einzigen Quelle: dem Cloud-Mount.

- **Vault, Configs, Skills, Plugin-Manifeste, inbox/outbox-Drops** leben im Cloud-Mount (OneDrive/Dropbox/Drive/rclone). Plain-Text + JSON-Lines. Sicher gegen File-by-File-Sync.
- **Git-Metadaten, SQLite-Indizes, Logs, Secrets** leben **pro Maschine** ausserhalb des Mounts (`%APPDATA%/claude-os/` bzw. `~/.config/claude-os/` + OS-Keychain). Sicher gegen Repo-Korruption und Locking-Probleme.
- **Anthropic `claude` Binary** wird via streaming Node-Bridge gespawnt (kein 120s-Buffer-Cutoff, Heartbeat, SIGINT-Propagation).

Die These: was im Cloud-Mount liegt, muss tolerant gegen "wahllose Reihenfolge von File-Updates" sein. Was das nicht ist, gehört raus. Siehe [ADR-0002](docs/architecture/adr/0002-cloud-mount-data-placement.md).

## Architektur in 60 Sekunden

```
$CLAUDE_OS_ROOT/                    <-- Cloud-Mount (OneDrive/Dropbox/...)
├── .claude-os-root                 Marker-File
├── bin/claude{,.exe}               Anthropic-CLI-Binary (optional, fallback: $PATH)
├── vault/                          Obsidian-Markdown-Vault
│   └── .git                        Gitfile -> per-Machine git-metadata
├── config/                         geteilte Configs
└── inbox/, outbox/                 Drop-Folder

%APPDATA%/claude-os/                <-- pro Maschine
├── git-metadata/vault.git/         echtes Git-Verzeichnis
├── data/
│   ├── vault-config.json           {conflictMode, idleSeconds, scheduleEnabled}
│   ├── vault-sync-state.json       Persistenter Busy-Flag
│   └── secrets.enc                 AES-256-GCM, falls keine OS-Keychain
└── logs/                           pino-Logs

OS-Keychain                         <-- Secrets (Service: claude-os)
                                    Windows Credential Manager / macOS Keychain
                                    / Linux Secret Service
```

## Voraussetzungen

- **Node.js ≥ 20** (ESM-Setup)
- **System-`git`** im PATH
- **Anthropic `claude`-Binary** (irgendwo im PATH oder unter `$CLAUDE_OS_ROOT/bin/claude{,.exe}`)
- **Cloud-Mount** mit Schreibrechten (OneDrive/Dropbox/Drive/rclone/...). Alternative: lokaler Pfad mit Marker-File für Single-Machine-Setup.

Auf Windows zusätzlich empfohlen: `git config --global core.longpaths true` (vom Doctor automatisch geprüft).

## Quickstart

```bat
:: 1. Repo holen + bauen
git clone <repo-url> claude-os
cd claude-os
npm install
npm run build

:: 2. Cloud-Mount markieren (einmalig pro Mount)
type NUL > "C:\Users\%USERNAME%\OneDrive\Claude\.claude-os-root"
set CLAUDE_OS_ROOT=C:\Users\%USERNAME%\OneDrive\Claude

:: 3. Doctor laufen lassen
.\claude-os.cmd doctor

:: 4. Vault-Sync vorbereiten
.\claude-os.cmd vault init-gitignore
.\claude-os.cmd doctor --migrate-git-metadata
```

POSIX äquivalent — `./claude-os` statt `.\claude-os.cmd`, `export CLAUDE_OS_ROOT=...`.

## CLI-Übersicht

| Command | Status | Was es macht |
|---|---|---|
| `claude-os doctor [--json] [--migrate-git-metadata]` | ready | Self-diagnostic; Migrations-Modus verschiebt `vault/.git/` extern |
| `claude-os ai <args...>` | ready | Forward an Anthropic claude-Binary; streaming stdio |
| `claude-os secrets set/get/list/delete <key> [value]` | ready | OS-Keychain (Fallback AES-256-GCM-File) |
| `claude-os vault snapshot [--no-push]` | ready | Stage, commit ISO-Timestamp, push |
| `claude-os vault status` | ready | Config + Busy-Flag + aktive Settings |
| `claude-os vault conflict-mode <mode>` | ready | `abort` \| `prefer-local` \| `prefer-remote` |
| `claude-os vault schedule --enable/--disable [--idle-seconds N]` | ready (Config) | Config-Toggle; Watcher selbst läuft im Phase-6-Sidecar |
| `claude-os vault unlock` | ready | Reset Busy-Flag (Crash-Recovery) |
| `claude-os vault init-gitignore` | ready | Default-Template anwenden |
| `claude-os update [--env\|--skills\|--plugins\|--all\|--rollback [ts]]` | ready (Foundation) | Tiered Auto-Update mit Selective-Merge-Foundation. Full interactive review staged für eine Folge-Iteration — siehe v1-Abweichungen unten. |
| `claude-os agent list\|show\|replay` | ready | Agent-Run-Browser (replay = print-only in v1, full re-spawn staged) |
| `claude-os auth status\|login\|profile create\|use\|list\|delete` | ready | Anthropic-CLI-Auth + Multi-Profile via `$ANTHROPIC_CONFIG_DIR`-Sandboxing |
| `claude-os catalog install\|resolve\|list\|enable\|disable\|uninstall\|lock\|sync\|update [<id>]` | ready | Vollständige Catalog-Pipeline: github-Tarball-Install + Capability-Resolution-Dry-Run, catalog.json/lock.json schema-validiert (TypeBox + assertValid), Mutation-Subcommands real (atomic write + UnknownCatalogEntryError), `lock` (fetch+sha256+cache, marketplace/local skip mit warning), `sync` (extract enabled-entries nach `<root>/config/{skills\|plugins\|mcp}/<id>`), `update [<id>]` (full re-lock oder single-entry merge). |
| `claude-os catalog install <source> --auto-deps --registry <path>` | ready (v1.5) | End-to-End-Install mit transitiver Marketplace-Auflösung: fetch target → peek plugin.json → resolve requires gegen Registry → writeCatalog + lockCatalog + applyLock in einem Schritt. Siehe ADR-0020. |
| `claude-os schedule add/list/remove/enable/disable` | ready (v1.5) | Zeit-basierte Tasks (cron-Expression). Sidecar tickt alle 60s und feuert fällige Commands; Live-Output landet als `schedule://event` Tauri-Notification. Siehe ADR-0019. |
| `claude-os mcp clients list/probe` | ready (v1.6) | Discovery + Static-Status-Check + Live-Spawn-Probe für MCP-Server aus Claude Desktop / Claude Code. Im Sidecar läuft zusätzlich ein Watcher der alle 60s reprobt und Status-Changes als `mcp-client://event` emittiert. |
| `claude-os migrate --from-portable <path>` | ready (v1.5) | Automatisierte Migration von claude-portable v0.x → claude-os v1: robocopy-equivalent recursive copy mit Overlap-Protection, idempotent. Siehe docs/migration-from-portable.md. |
| `claude-os mcp serve` | ready (v1.4) | claude-os als MCP-Server für Claude Desktop / Claude Code (Tools-API über stdio). Siehe ADR-0016. |

### Memory-MVP-Commands (ROADMAP Phase 2 + 3 + 4)

| Command | Status | Was es macht |
|---|---|---|
| `claude-os workspace list\|current\|use <id>\|where [<id>]` | ready (Phase 2a) | Multi-Workspace per ADR-0031 — `personal` / `msp-internal` / `msp-customers/<id>`. Strict id-validation. |
| `claude-os save-note <filename> --body \| --from-file \| --from-stdin [--type --tags --classification --tenant --overwrite]` | ready (Phase 2e) | Schreibt Markdown-Note mit frontmatter-validation in active Workspace. |
| `claude-os ask "<prompt>" [--workspace --top-k --no-context --include-ephemeral --dry-run]` | ready (Phase 2e) | Komponiert Prompt mit BM25-vault-context, delegiert an `claude.exe -p "..."` (ADR-0003). |
| `claude-os skills list\|show <name>\|match "<query>" [--top-k]` | ready (Phase 4) | SKILL.md-Loader + BM25 description-matcher pro Workspace. |

Sidecar-only RPCs (kein CLI-Equivalent — via GUI Memory-page oder Tauri-IPC): `workspace.*`, `notes.*`, `retrieval.*` (Phase 2f), `memory.stats` / `memory.rebuild` (Phase 3f).

Globale Flags: `--root <path>` (statt `$CLAUDE_OS_ROOT`), `--vault <path>` (statt `$CLAUDE_OS_VAULT_PATH`), `--json`, `-v/--verbose`.

### Memory-MVP-Quickstart

```bash
# 1. Vault konfigurieren (einmalig)
echo 'CLAUDE_OS_VAULT_PATH=D:\OneDrive\Obsidian Vault' > .env

# 2. Workspace wählen
claude-os workspace use personal

# 3. Notes schreiben (CLI oder GUI Memory-page)
echo "Migration runs Sonntag 0300. Affects all DCs." | claude-os save-note migration.md --from-stdin --type session

# 4. Mit Vault-Kontext fragen — claude-os baut den Prompt, claude.exe antwortet
claude-os ask "when is the migration?"

# 5. Skills im Workspace listen / matchen
claude-os skills list
claude-os skills match "find notes about deployments"
```

Vault-Layout per ADR-0031:

```
<CLAUDE_OS_VAULT_PATH>/Claude-OS/
├── workspaces/
│   ├── personal/skills/<name>/SKILL.md       # User-Skills (heilig)
│   ├── personal/<note>.md                    # Notes mit frontmatter
│   ├── msp-internal/...
│   └── msp-customers/<customer-id>/...       # Tenant-isoliert
└── .claude-os/index.db                       # FTS4 (sql.js, ADR-0025)
```

## Cross-Machine-Setup (zweite Maschine)

1. Cloud-Sync-Client einrichten und auf den Mount warten (alle Markdowns + Configs sind bereits da).
2. `git clone` des claude-os-Repos lokal, `npm install && npm run build`.
3. `claude-os doctor` zeigt was fehlt. Auf Windows: `core.longpaths true` setzen wenn der Doctor warnt.
4. `claude-os doctor --migrate-git-metadata` initialisiert die externe `.git`-Metadata-Direction.
5. Optional: `claude-os secrets set <key> <value>` für API-Keys, die nicht im Cloud-Mount liegen sollen.

Der Vault-Status auf der zweiten Maschine wird durch den Cloud-Sync-Client gepullt; Git-Operationen laufen lokal gegen die externe Metadata-Direction.

## Konfiguration

### Environment-Variablen

| Var | Wirkung |
|---|---|
| `$CLAUDE_OS_ROOT` | Cloud-Mount-Pfad (sonst: Repo-Detect via Marker-File) |
| `$CLAUDE_OS_VAULT_PATH` | Obsidian-Vault-Root (per ADR-0031). Workspaces leben unter `<vault>/Claude-OS/workspaces/<id>/`. Pflicht für Memory-Commands (workspace/notes/retrieval/skills); install-only Befehle (doctor/secrets/ai) brauchen es nicht. Aus `.env` oder shell. Details: [`docs/environment.md`](docs/environment.md). |
| `$CLAUDE_OS_DEFAULT_WORKSPACE` | Default-Workspace beim Start (default: `personal`). |
| `$CLAUDE_OS_DATA_DIR` | Override für `%APPDATA%/claude-os/` (Tests + unusual installs) |
| `$CLAUDE_OS_LOG_LEVEL` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` (Default: `info`) |
| `$CLAUDE_OS_SECRETS_BACKEND` | `keyring` \| `encrypted-file` (Default: Auto-Detect via Probe) |
| `$CLAUDE_OS_SECRETS_KEY` | Master-Key für encrypted-file Backend |
| `$RUN_SLOW_TESTS=1` | Aktiviert den 180s Long-Running-E2E-Test |

### Config-Files (pro Maschine, in `<dataDir>`)

- **`vault-config.json`** — `{conflictMode: "abort"|"prefer-local"|"prefer-remote", idleSeconds: 300, scheduleEnabled: false}`
- **`vault-sync-state.json`** — Persistent Busy-Flag (Crash-Recovery)
- **`secrets.enc`** — AES-256-GCM Fallback wenn OS-Keychain nicht verfügbar. **Windows-Hinweis (M9):** `mode: 0o600` wird auf Windows von Node-FS ignoriert — der File erbt die ACL des Parent-Verzeichnisses. Auf Multi-User-Hosts via `icacls` einschränken oder den OS-Keyring (`CLAUDE_OS_SECRETS_BACKEND=keyring`) bevorzugen.

## Tauri-GUI (Phase 6 + v1.5/v1.7 Erweiterungen)

Desktop-App-Shell mit Claude-Desktop-Look-and-Feel (per [ADR-0001](docs/architecture/adr/0001-gui-framework-tauri.md) / [ADR-0006](docs/architecture/adr/0006-tauri-node-sidecar-ipc.md)).

**GUI-Tabs:**

- **Dashboard** — Status-Cards (Sidecar / Catalog / Vault / Agent Runs)
- **Chat** — Full-TTY claude-Spawn via xterm.js + node-pty: interaktive Prompts (`/login`, Passwoerter), volle ANSI-Sequences, Resize-aware (ADR-0021). Legacy line-buffered `chat.*`-RPC bleibt parallel (ADR-0017).
- **Catalog** — `+ Install` Form mit Auto-Deps-Toggle + Plugin-Liste (ADR-0020)
- **Vault** — Conflict-Mode + Busy-State + Schedule-Config
- **Agent Runs** — Letzte 50 Runs aus dem JSONL-Store
- **Schedule** — Cron-Tasks anlegen/togglen/loeschen mit Live-Event-Feed (ADR-0019)
- **MCP-Clients** — Live-Status aller in Claude Desktop / Claude Code konfigurierten MCP-Server (color-coded alive/init-timeout/crashed/protocol-error/spawn-failed)
- **Secrets** — Keys-only-Liste + Add/Update via native OS-Dialog (Wert beruehrt nie den Renderer-JS-Heap; Inline-Fallback fuer headless-Linux/CI; ADR-0023). Values niemals lesbar in der GUI.
- **Settings** — Anthropic-Login (embedded xterm-Modal mit OAuth-Browser-Callback) + Profile-Switch-Dropdown + Profile-Create/Delete mit GitHub-Style type-to-confirm + Read-only Config-Snapshot (ADR-0022 + ADR-0023)

```
+-------------------------------------+
|  Tauri Window (WebView)             |
|  React 19 + Vite + react-router     |
|  9 Tabs: Dashboard / Chat /         |
|         Catalog / Vault / AgentRuns |
|         Schedule / MCP-Clients /    |
|         Secrets / Settings          |
+----------------+--------------------+
                 | invoke("rpc_call") +
                 | listen("...://...")
+----------------v--------------------+
|  Rust Shell (claude-os-shell.exe)   |
|  - SupervisorState (Arc-managed)    |
|  - 3-strikes backoff (1s/4s/16s)    |
|  - 30s ping health-check            |
|  - graceful shutdown                |
|    (shutdown-RPC -> 2s -> kill)     |
|  - DragDrop dedup (paths-hash       |
|    + 200ms time-bucket)             |
+----------------+--------------------+
                 | stdio NDJSON (json-rpc 2.0)
+----------------v--------------------+
|  Node Sidecar (claude-os-sidecar    |
|                -<TARGET_TRIPLE>.exe)|
|  - RpcDispatcher                    |
|  - Domain methods (catalog.list +   |
|    .installAutoDeps / vault.status /|
|    agent.list / inbox.import /      |
|    schedule.list/add/remove + ... / |
|    mcp.clients.status / chat.*)     |
|  - chokidar watcher                 |
|    (inbox/ + outbox/)               |
|  - Background services (ADR-0019):  |
|    - Scheduler-Runner (60s tick)    |
|    - MCP-Watcher (60s tick + probe) |
+-------------------------------------+
```

GUI bauen + starten:

```powershell
# Erst Sidecar-Binary für die eigene Plattform
npm run sidecar:build

# Dann Tauri dev oder full bundle
cd gui
npm install
npm run tauri:dev      # entwicklung
npm run tauri:build    # produktion: MSI / DMG / AppImage
```

Voraussetzung: Rust-Toolchain via [rustup](https://rustup.rs/) + plattformspezifische Build-Tools. Details + Gatekeeper-Workaround in [`gui/README.md`](gui/README.md).

## Weitere Docs

**Foundation (verbindlich):**

- [`CLAUDE.md`](CLAUDE.md) — Verhaltensgrundlage für Claude Code (Plan-First, Verification, Lessons-Loop, Verbote, Hierarchie)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — Stack-Wahrheit, Trust-Boundaries, Memory-Layer, Failure-Modes, ADR-Index
- [`ROADMAP.md`](ROADMAP.md) — MVP-Definition, Phasen, DoD, Ist-Stand, Video-Insights
- [`SECURITY.md`](SECURITY.md) — Threat-Model, Data-Classification, NAPI-RS Keyring, Audit-JSONL, Self-Improving-Skill-Lifecycle, MSP-Tenant-Isolation, DSGVO
- [`docs/gitnexus.md`](docs/gitnexus.md) — Code-Intelligence-Workflow (Impact-Analysis vor Symbol-Edits)

**Setup + Operation:**

- **[`docs/setup-guide.md`](docs/setup-guide.md) — Detaillierte Schritt-für-Schritt Setup-Anleitung (Szenario A: App, B: + CLI, C: + Dev) inkl. Troubleshooting**
- **[`docs/server-deployment.md`](docs/server-deployment.md) — Server-Variante per Docker (Proxmox-Homelab + Cloudflare + nginx proxy manager, alpha)**
- [`docs/cloud-providers.md`](docs/cloud-providers.md) — Setup für OneDrive, Drive, Dropbox, Nextcloud, rclone, abraunegg/onedrive
- [`docs/migration-from-portable.md`](docs/migration-from-portable.md) — 7-Schritte-Migration von claude-portable v0.x (USB) zu claude-os v1
- [`docs/macos-gatekeeper.md`](docs/macos-gatekeeper.md) — unsignierte DMG auf macOS öffnen
- [`docs/linux-updates.md`](docs/linux-updates.md) — AppImage Self-Update via zsync (v1.3+)
- [`docs/mcp-integration.md`](docs/mcp-integration.md) — claude-os als MCP-Server für Claude Desktop / Claude Code (v1.4+)
- [`gui/README.md`](gui/README.md) — Tauri-Shell + Sidecar build
- [`.env.example`](.env.example) — Runtime-Env-Var-Surface

**Tracking + Decisions:**

- [`tasks/todo.md`](tasks/todo.md) — Phase-Tracker, Reviews, Deferrals, v1.x Roadmap
- [`tasks/lessons.md`](tasks/lessons.md) — cross-session pattern-Sammlung
- [`docs/specs/auto-deps-flag.md`](docs/specs/auto-deps-flag.md) — Spec für `catalog install --auto-deps` (Phase 5p/5q/5r)
- [`docs/integration-plan-cowork-os.md`](docs/integration-plan-cowork-os.md) — Cowork-OS-Video-Analyse + Feature-Roadmap (#1 + #3 shipped)
- [`docs/troubleshooting/stop-hook-hang.md`](docs/troubleshooting/stop-hook-hang.md) — Diagnose-Doc + Script für Claude-Code Stop-Hook-Hänger
- [`docs/architecture/adr/`](docs/architecture/adr/) — 31 ADRs (Index in `ARCHITECTURE.md` §11)

## Architektur-Entscheidungen

Alle wesentlichen Design-Entscheidungen sind in [`docs/architecture/adr/`](docs/architecture/adr/) als ADRs dokumentiert. Hot-Spots:

- [ADR-0001 — Tauri statt Electron für die GUI](docs/architecture/adr/0001-gui-framework-tauri.md)
- [ADR-0002 — Cloud-Mount-Datenplatzierung](docs/architecture/adr/0002-cloud-mount-data-placement.md) (zentral)
- [ADR-0003 — Hybrid-CLI mit claude.exe-Delegation](docs/architecture/adr/0003-hybrid-cli-with-claude-exe-delegation.md)
- [ADR-0004 — Secrets via @napi-rs/keyring](docs/architecture/adr/0004-secrets-via-napi-rs-keyring.md)
- [ADR-0005 — Selective-Merge-Update-Pattern](docs/architecture/adr/0005-selective-merge-update-pattern.md)
- [ADR-0008 — Git-Backend simple-git](docs/architecture/adr/0008-git-backend-simple-git.md)
- [ADR-0013 — Logging mit pino](docs/architecture/adr/0013-logging-pino.md)
- [ADR-0015 — Plugin-Binding-Resolution (Phase 5o)](docs/architecture/adr/0015-plugin-binding-resolution.md)
- [ADR-0016 — MCP-Single-Server-Bridge (v1.4)](docs/architecture/adr/0016-mcp-single-server-bridge.md)
- [ADR-0017 — Chat-View-MVP über line-buffered child_process (v1.2)](docs/architecture/adr/0017-chat-view-mvp-line-buffered.md)
- [ADR-0018 — AppImage Self-Update via zsync (v1.3)](docs/architecture/adr/0018-appimage-zsync-self-update.md)
- [ADR-0019 — Sidecar Background-Services-Pattern (v1.5/v1.7)](docs/architecture/adr/0019-sidecar-background-services.md)
- [ADR-0020 — Auto-Deps Fixed-Point-Resolution (v1.5)](docs/architecture/adr/0020-auto-deps-fixed-point-resolution.md)
- [ADR-0021 — Full-TTY Chat-View via node-pty + xterm.js (v1.x)](docs/architecture/adr/0021-pty-upgrade-xterm-node-pty.md)
- [ADR-0022 — GUI-Mutation fuer Auth-Login, Profile-Switch, Secrets-Edit (v1.x.+1)](docs/architecture/adr/0022-gui-auth-and-secrets-mutation.md)
- [ADR-0023 — GUI Profile-Create/Delete + Native Password-Input (v1.x.+2)](docs/architecture/adr/0023-profile-crud-and-native-password.md)

## v1-Abweichungen (bekannt + transparent)

**Phase 4 (Update-Orchestrator):**

- **`update --skills` Selective-Merge-Composition**: Die Bausteine (BackupManager, ZoneClassifier, DiffEngine, ReviewLoop, ResumableChecklist) sind isoliert getestet und einsatzbereit, die End-to-End-CLI-Komposition (upstream-mirror-clone → walk → classify → diff → review-loop → checklist → apply) ist noch nicht voll verdrahtet. `update --skills` bei `aborted-dirty` zeigt einen Hint statt zu starten.
- **`update --resume`**: ResumableChecklist-Modul ist fertig + getestet, aber die CLI-Orchestration für Resume hängt an obigem Composition-Punkt.
- **Interactive Review**: Die `decide`-Callback der ReviewLoop ist injectable; eine echte TTY-UI mit `enquirer` ist Folge-Iteration oder Phase-6-GUI. v1 nutzt `--auto-accept` für clean Diffs.
- **`.skill-lock.json`** statt YAML (ADR-0005 §38 erwähnt YAML; JSON ist robuster, kein Parser nötig).

**Phase 5 (Agent-Runs + Auth + Catalog):**

- **Agent-Runs Index in JSON statt SQLite** — sql.js drop-in für v1.x; v1-Performance für Early-Adoption-Datensätze trivial.
- **macOS-Keychain-Read** für `.credentials.json` deferred zu v1.x — File-Fallback funktioniert auch auf macOS.
- **Refresh-Mutex / proaktiver Token-Refresh deferred** — claude.exe besitzt den Refresh; `auth status` warnt bei expiresAt < 1h.
- ~~**Marketplace ETag-URL-Fetch deferred**~~ → Phase 5k (Commit `15ae558`): `urlLoader({url, cacheDir, fetch?})` mit If-None-Match + 304-Reuse, atomic body/etag cache, injectable fetch.
- ~~**Capability-Resolver Version-Constraints** beschränkt auf `>=`/`>`/`<=`/`<`/`=`~~ → Phase 5j (Commit `fee2aff`): `^` + `~` implementiert per npm-semver left-most-non-zero rule.
- ~~**catalog.json / catalog.lock.json Lifecycle deferred**~~ → Phase 5i/l/m/n (Commits `cff079c`/`4fa4f7d`/`bb195f0`/`5abac44`): TypeBox-Schema + atomic Store, `list/enable/disable/uninstall` Mutations, `lock` (sha256-Cache) + `sync` (extract→install-dirs) + `update [<id>]` (full-relock oder merge-by-id). Komplette 9/9 Catalog-CLI real.
- **Catalog-Lock `bindings: []`** (v1.x): braucht Plugin-Manifest-Reader (Tarball-Peek oder Post-Sync re-read) + `resolveCapabilities`-Run. Schema forward-kompatibel; Realität (Plugins ohne `requires`/`provides`) macht den Aufwand für v1 nicht wert.
- **`agent replay` print-only** — full re-spawn der gespeicherten Prompts ist v1.x.
- **Coverage-Scope** (2026-05-17): vitest-Coverage erfasst nur unit-testbaren Code. Ausgeschlossen: `src/cli/**` (Commander-Glue → real-binary Smoke), `keyring-store.ts` (native @napi-rs/keyring), `plugins.ts` (Phase-4f-Placeholder). Aktuelle Werte: 90/78/93/92 % stmt/branch/func/line — `npm run ci` exit 0.

## Entwicklung

```bat
npm test                          :: 815/818 grün (+3 long-running gated)
npm run build                     :: tsc -> dist/
npm run check                     :: biome lint
npm run ci                        :: biome ci + tsc + coverage
$env:RUN_SLOW_TESTS = "1"; npm test :: inkl. 180s Bridge-Regression
```

Test-Tracker: [`tasks/todo.md`](tasks/todo.md), Lessons aus Korrekturen: [`tasks/lessons.md`](tasks/lessons.md).

## Lizenz

MIT — siehe [`LICENSE`](LICENSE). Attribution-Notizen für Hermes / OpenClaw / Claude Code / Tauri / MCP-SDK / NAPI-RS Keyring / TypeBox stehen in [`NOTICE`](NOTICE). License-Entscheidung dokumentiert in [ADR-0029](docs/architecture/adr/0029-license-mit-public-core.md).

Für private abgeleitete Repos (`claude-os-msp`, `house-watch` per [ADR-0030](docs/architecture/adr/0030-repo-strategy-hybrid.md)) gilt proprietär ("All rights reserved").
