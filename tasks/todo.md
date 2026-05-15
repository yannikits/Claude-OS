# Claude Develop Environment OS — Implementierungs-Tracker

**Quelle:** `C:\Users\reapertakashi\Downloads\claude-develop-environment-os.md`
**Plan-Datum:** 2026-05-15
**Gesamtschätzung:** ~120 Stunden
**Architektur-Entscheidungen:** [docs/architecture/adr/](../docs/architecture/adr/)

---

## Phase 0 — Repo-Vorbereitung (2 h, Komplexität L)

**Ziel:** Sauberer Ausgangspunkt; USB-Reste raus, Branch + Tracking-Struktur steht.

- [ ] Branch `feature/claude-os-v1` aus `main` erstellen
- [ ] USB-Sync-Scripts löschen: `sync-from-usb.bat`, `sync-to-usb.bat`
- [ ] Legacy-Launcher in `legacy/` verschieben: `start.bat`, `start.ps1`, `setup.bat`, `sync-vault-pull.bat`, `sync-vault-push.bat`
- [ ] GitHub-Issues: Epic + 1 Tracking-Issue pro Phase (oder lokale Issue-Liste falls kein GitHub-Sync gewünscht)
- [ ] `tasks/todo.md` (diese Datei) committen
- [ ] `tasks/lessons.md` initialisieren

**Test-Kriterium:** `git log --oneline` zeigt Cleanup-Commits; `git ls-files | grep -E "sync.*usb"` leer.

---

## Phase 1 — Node-Bootstrap und Doctor MVP (16 h, M, deps: Phase 0)

**Ziel:** Lauffähiges TypeScript-Projekt mit `claude-os doctor` als ersten Smoke-Test.

- [ ] `package.json` (Node ≥ 20, ESM, scripts: `build`, `test`, `check`, `format`, `dev`); Deps: `@sinclair/typebox`, `pino`, `pino-roll`, `pino-pretty` (dev), `commander@^12`, `chokidar@^5`, `simple-git`, `@napi-rs/keyring`, `husky`, `lint-staged`
- [ ] `tsconfig.json` strict, Pfad-Aliase `@core/*`, `@domains/*`
- [ ] **biome v2.3 (per ADR-0014)**: `biome.json` mit `recommended: true`, strict TS-Rules; `npm run check` und `npm run format` als Shortcuts
- [ ] **husky + lint-staged**: Pre-Commit `biome check --apply` auf staged Files; non-bypassable ohne Begründungs-Commit
- [ ] Jest-Setup mit Coverage-Threshold 70 %
- [ ] `src/core/environment/root-resolver.ts` mit Env-Var- und Repo-Detect-Fallback
- [ ] `src/core/doctor/` — Checks: Mount, Node-Version, Git-Verfügbarkeit, `bin/claude.exe`-Existenz, Schreibrechte
- [ ] `src/cli/index.ts` mit **commander v12 (per Researcher-Spike)**, Command `doctor` aktiv; globaler `--json`-Flag mit zentralem Renderer in `src/cli/presenters/`
- [ ] `src/core/logging/` — **pino-Singleton (per ADR-0013)** mit Redaction-Path-Liste in `redact-paths.ts` (Pflicht-Code-Review-Gate); `pino-roll` für `%APPDATA%/claude-os/logs/`, `pino.destination(2)` für Tauri-Stderr-Mirror (ADR-0006)
- [ ] Redaction-Test: künstliches Secret in Log-Object → Output enthält `[REDACTED]`, nicht das Secret
- [ ] Shims: `claude-os.cmd` (Windows) + `claude-os` (POSIX)
- [ ] Unit-Tests Root-Resolver (3 Szenarien: Env-Var gesetzt / Repo-Detect / beides fehlt)
- [ ] Unit-Tests Doctor-Checks (gemockt)
- [ ] `npm link` Smoke: `claude-os doctor` grün auf aktueller Maschine
- [ ] README-Skelett (Deutsch, Bootstrap-Sektion)
- [ ] **TypeBox-Setup (per ADR-0012)**: `@sinclair/typebox` als Dep, `src/core/schemas/`-Verzeichnis, erste `EnvironmentManifest`-Schema-Definition mit `Type.Strict()`-Export
- [ ] `src/core/validation/format.ts` — User-Friendly-Error-Wrapper (~100 LOC) für TypeBox/Ajv-Errors
- [ ] Validation-Tests: Schema-Roundtrip (TS-Type ↔ JSON-Schema ↔ Validator) für `EnvironmentManifest`

**Test-Kriterium:** `npm test` + `npm run lint` grün; `claude-os doctor` grüner Status.

### Phase 1.5 — Git-Metadaten-Migration (2 h, eingebettet)

- [ ] `claude-os doctor --migrate-git-metadata`: verschiebt `vault/.git/` nach `%APPDATA%/claude-os/git-metadata/vault.git/` via `git init --separate-git-dir`
- [ ] Idempotenz-Test: zweiter Aufruf ist No-Op

---

## Phase 2 — Vault-Sync-Subsystem (18 h, M, deps: Phase 1)

**Ziel:** Branch-aware Snapshot-Sync für Vault, push-only, mit Idle-Detection statt Cron (obsidian-git-Pattern). Conflict-Policy in 3 Modi, persistenter Busy-Flag.

- [ ] `src/core/git/git-service.ts` — zentrale `simple-git`-Abstraktion (per ADR-0008); kein direkter `simple-git`-Import aus Domain-Code
- [ ] Doctor-Pre-flight: `git --version` Check, Windows-Long-Paths-Auto-Config (`core.longpaths true`)
- [ ] Error-Mapping: `GitNotInstalledError`, `GitLockfileError`, `GitMergeConflictError` als `DomainError`-Subklassen
- [ ] `domains/vault-sync/branch-detect.ts` — `git symbolic-ref --short HEAD`, kein `main`-Hardcoding (Fix Memory-S251)
- [ ] `domains/vault-sync/snapshot.ts` — stage all → commit mit ISO-Timestamp → push (via `git-service`)
- [ ] **Default `.gitignore`-Template** mit `.obsidian/workspace*.json`, `.obsidian/cache`, `.trash/`, `claudeos-machine-state/` (Multi-Device-Konflikt-Quelle laut obsidian-git Issue #114)
- [ ] `domains/vault-sync/scheduler.ts` — **Idle-Detection**: triggert `snapshot()` N Sekunden (default 300) nach letztem Write-Event in `vault/**`. KEIN fester Cron. Implementation-Specs:
  - chokidar v5 (ESM-only, Node 20+) als File-Watcher
  - **Cloud-Mount-Auto-Detect** via Pfad-Prefix-Match (`%OneDrive%`, `~/Dropbox`, Drive-File-Stream-Reparse-Point); auf erkannten Cloud-Pfaden `usePolling: true, interval: 2000, binaryInterval: 5000` (chokidar #895/#998/#225 — native Events unzuverlässig auf Files-On-Demand-Mounts)
  - **Idle-Timer separat von `awaitWriteFinish`**: Raw-Events aus chokidar → `setTimeout(syncTrigger, 300_000)` mit Reset bei jedem Event. NICHT `awaitWriteFinish` für 300s missbrauchen (Issues #384/#675 — Events verloren bei großen Files)
  - `awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }` parallel für Per-File-Stabilität bei Editor-Saves
  - `atomic: 100` (default) für Obsidian/VS-Code; auf 300 hochsetzbar via Config für Logseq/Zettlr
  - Linux: Setup-Doku mit `fs.inotify.max_user_watches=524288` (Default 8192 reicht nicht für 10k-File-Vaults)
- [ ] `domains/vault-sync/busy-flag.ts` — persistenter `busy: boolean` in `%APPDATA%/claude-os/data/vault-sync-state.sqlite` (überlebt Sidecar-Restart, blockt parallele Snapshots). Manuelles Reset via `claude-os vault unlock`.
- [ ] `domains/vault-sync/conflict-policy.ts` — **3-Modi**: `abort` (default, Hard-Fail mit Doctor-Hinweis), `prefer-local` (lokal gewinnt, force-push mit Confirm), `prefer-remote` (remote gewinnt, lokale Änderungen in Backup-Branch). Konflikt-Detection via `git status --porcelain`-Marker-Scan.
- [ ] CLI: `claude-os vault snapshot|status|schedule --enable/--disable [--idle-seconds N]`, `claude-os vault conflict-mode <abort|prefer-local|prefer-remote>`, `claude-os vault unlock`
- [ ] Integrationstest gegen lokales Bare-Repo-Fixture
- [ ] Branch-Detection-Tests für `main`, `master`, `feature/*`
- [ ] Busy-Flag-Persistenz-Test: Sidecar-Crash mitten in Snapshot → Restart → Flag noch true → `claude-os vault unlock` setzt zurück
- [ ] Conflict-Mode-Tests für alle drei Modi

**Test-Kriterium:** Roundtrip-Test (write in vault → 300 s idle → auto-commit → push → fetch in Fixture) grün; künstlicher Konflikt löst korrekten Modus aus; nach Sidecar-Kill mitten im Snapshot ist Flag persistent.

---

## Phase 3 — Hybrid-CLI mit AI-Delegation (20 h, H, deps: Phase 1)

**Ziel:** Vollständiger `claude-os`-Command-Tree und stabile `claude.exe`-Anbindung.

- [ ] Command-Stubs: `update`, `doctor`, `vault`, `catalog`, `secrets`, `agent`, `auth`, `ai`
- [ ] `domains/claude-bridge/spawn.ts` — `child_process.spawn`, kein 120s-Cutoff (Fix Memory 569/577/578)
- [ ] Cancellation via SIGINT-Propagation, SIGKILL nach 5 s Timeout
- [ ] Heartbeat-Logging alle 10 s während Session
- [ ] `cli/commands/ai.ts` — leitet alle Args nach `claude.exe`, propagiert Exit-Code
- [ ] Globale Flags: `--root <path>`, `--verbose`, `--json`
- [ ] `domains/secrets/` — `@napi-rs/keyring`-Adapter + encrypted-file Fallback (ADR-0004)
- [ ] CLI: `claude-os secrets set/get/list/delete`
- [ ] Long-Running-E2E-Test: `claude-os ai -p "hello"` läuft 180 s ohne Abbruch

**Test-Kriterium:** Manueller Smoke: `claude-os ai --help` reicht Anthropic-Help durch.

---

## Phase 4 — Update-Orchestrator (18 h, M, deps: Phase 1+3)

**Ziel:** Tiered Auto-Update beim Start; Plugin-Updates explizit; Selective-Merge-Pattern nach ADR-0005.

- [ ] `domains/update-orchestrator/env-repo.ts` — `git pull --ff-only` auf Repo-Root, bei Konflikt skip+warn
- [ ] `domains/update-orchestrator/skills-repo.ts` — Sync `iteenschmiede/claude-config` nach `config/skills/`, Diff anzeigen
- [ ] `domains/update-orchestrator/plugins.ts` — nur via `claude-os update --plugins`, verbose, separates Log-File (Fix Memory 587–593)
- [ ] Daemon-Probe vor Plugin-Update
- [ ] `cli/commands/update.ts` — Flags `--env`, `--skills`, `--plugins`, `--all`, `--auto-accept`, `--resume`, `--rollback`
- [ ] Boot-Hook in Launcher: env+skills auto, Plugins nicht
- [ ] Pin claude-flow auf exakte Version, `--legacy-peer-deps`

**Selective-Merge-Implementation nach ADR-0005:**

- [ ] `BackupManager`: `.snapshot(scope)` / `.restore(timestamp)` / `.prune(retention=5)` unter `%APPDATA%/claude-os/backups/update-<iso>/`
- [ ] `DiffEngine` über `diff` (npm) — unified-diff-Rendering im Terminal
- [ ] `ZoneClassifier` liest `.skill-lock`-YAML + Skill-Frontmatter `claudeos: locked`; klassifiziert pro Datei in System | Personal | Locked
- [ ] Interaktive Diff-Review-UI mit `enquirer` — keep / upgrade / merge / skip / diff pro Datei
- [ ] `ResumableChecklist`: atomar geschriebenes State-File `%APPDATA%/claude-os/data/upgrade-checklist.<ts>.md`, `claude-os update --resume` setzt fort
- [ ] `claude-os update --rollback [<ts>]` stellt aus Backup wieder her (default: jüngstes)
- [ ] `--auto-accept` übernimmt nur clean Diffs (kein lokaler Modify), Konflikte landen in Review-Queue-File

**Test-Kriterium:** Sandbox-Clone → `claude-os doctor` triggert env+skills-Pull; `--plugins` bleibt unverändert; künstlich modifizierte Skill-Datei wird im Diff-Review-Modus präsentiert, nicht überschrieben.

---

## Phase 5 — Agent-OS-Subsystem + Catalog/Skill-Registry (28 h, H, deps: Phase 2+3)

**Ziel:** Account-Auth, JSON-Lines-Agent-Runs (ADR-0002), Vault-Output-Persistence, vollständiges Catalog-System (ADR-0009 + ADR-0010).

### Agent-Runs-Domain

- [ ] JSON-Lines-Schema: `vault/agent-runs/<project>/<machineId>.jsonl` (eine Datei pro Maschine, append-only)
- [ ] `domains/agent-runs/jsonl-writer.ts` — atomare Appends via tempfile + rename
- [ ] `domains/agent-runs/index-builder.ts` — scannt alle JSONL-Files, baut lokalen SQLite-Index unter `%APPDATA%/claude-os/data/`
- [ ] `domains/agent-runs/repository.ts` — typed query-API mit Project-Column (Fix Memory-565)
- [ ] `domains/auth/anthropic.ts` — Auth-Integration nach ADR-0011:
  - **State-Check**: `claude auth status` JSON-Parser; Fallback File-Read `.credentials.json` (Linux/Win) bzw. macOS-Keychain (`Claude Code-credentials`, Key `claudeAiOauth`) via `@napi-rs/keyring`
  - **Refresh-Mutex**: File-Lock auf `~/.claude-os/data/auth.refresh.lock` (PID + Timestamp, stale-Detection 60s); proaktiver Refresh bei `expiresAt < now + 60_000ms`; bei Fail → Doctor-Warnung
  - **Multi-Profile**: `auth profile create|use|list` setzt `$ANTHROPIC_CONFIG_DIR` für neue claude.exe-Spawns; aktives Profil in Statusline (Phase 6)
  - **CI/Headless**: respektiert `CLAUDE_CODE_OAUTH_TOKEN`/`_REFRESH_TOKEN`/`_SCOPES` Env-Vars
  - **Schema-Version-Check** im Doctor: erwartete Keys in `.credentials.json` → bei Drift Warnung "Anthropic-CLI-Schema möglicherweise geändert"
- [ ] Regressions-Tests gegen claude-code-Issues #50743, #27933, #31095 (Race-Reproducer)
- [ ] `domains/agent-runs/vault-writer.ts` — Run-Output als Markdown nach `vault/agent-runs/<project>/<timestamp>.md`
- [ ] CLI: `claude-os agent list/show/replay`
- [ ] Index-Rebuild im Doctor-Run integriert

### Catalog-Domain (ADR-0009)

- [ ] `config/catalog.json` Schema-Definition (zod) und Validator
- [ ] `config/catalog.lock.json` Schema-Definition mit resolved-source + sha256-Hashes
- [ ] `domains/catalog/source-resolver.ts` — Parser für drei Source-String-Formate (`marketplace:*`, `github:*`, `local:*`)
- [ ] `domains/catalog/tarball-installer.ts` — Download nach `%APPDATA%/claude-os/cache/<sha256>.tar.gz`, Hash-Check (idempotent), Extract nach Scope-Pfad
- [ ] `domains/catalog/marketplace-registry.ts` — Resolve marketplace-Name zu GitHub-Source, ETag-basierter Marketplace-Index-Cache
- [ ] `domains/catalog/scope-merger.ts` — User-Scope (`~/.claude/`) + Project-Scope (`vault/.claude/`) Merge, Project gewinnt
- [ ] `domains/catalog/cache-cleaner.ts` — Doctor-Hook: Tarball-Cache älter als 30 Tage löschen
- [ ] CLI: `claude-os catalog list|install|uninstall|enable|disable|update|lock|sync`
- [ ] Lock-File-Konflikt-Detection (Cloud-Sync File-Conflict-Copies) im Doctor

### Capability-Resolver (ADR-0010)

- [ ] `domains/catalog/capability-resolver.ts` — deterministischer Resolver
- [ ] `ResolutionError`-Subtypen: `MissingProvider`, `VersionConflict`, `CyclicDependency`, `AmbiguousProvider`
- [ ] Plugin-Manifest-Validator: `plugin.json`-Schema mit `requires[]` + `provides[]` als Capability-Strings
- [ ] Strikt isolierte Module-Trees: kein Hoisting in Root-`node_modules`, jedes Plugin hat eigenes `node_modules/`
- [ ] CLI: `claude-os catalog resolve <plugin>` (dry-run Resolution-Plan)
- [ ] **Regressions-Tests gegen ruflo #1676 / #174 Reproducer** + Memory-587/593-Szenarien
- [ ] `--auto-deps` Flag für transitives Resolving
- [ ] **Lazy-Activation** (VSCode-Pattern): `triggers` im Skill-Frontmatter + `mcp.serverScope: on-demand|session-start`
- [ ] **Uninstall-Hook** pro Plugin: bei `catalog uninstall` werden Plugin-spezifische Cleanup-Scripts ausgeführt (MCP-Server-Prozess-Cleanup, State-Files)

### Skill-Pack Import

- [ ] **Optional Skill-Pack-Import**: `claude-os catalog install marketplace:claudesidian:claudesidian-pack` — importiert die acht generischen Knowledge-Worker-Skills (`thinking-partner`, `daily-review`, `weekly-synthesis`, `de-ai-ify`, `add-frontmatter`, `pragmatic-review`, `inbox-processor`, `research-assistant`). Upgrade-fähig nach ADR-0005.

**Test-Kriterium:**
- Dummy-Agent-Run schreibt JSONL + Markdown + Index-Eintrag konsistent
- `claude-os catalog sync` auf zwei Maschinen produziert identischen Stand (Lock-File-Reproducibility)
- Capability-Resolver fail-loud bei Reproducer-Cases (ruflo #1676 et al.)
- `claude-os catalog install <ruflo-style-plugin>` (mit Capability-Manifest) installiert ohne npm-peer-deps-Konflikte
- `claude-os catalog install claudesidian-pack --dry-run` listet erwartete Importe ohne Filesystem-Änderung

---

## Phase 6 — Tauri-GUI (26 h, H, deps: Phase 3+5)

**Ziel:** Desktop-App-Shell mit Claude-Desktop-Look-and-Feel (ADR-0001, ADR-0006).

- [ ] `gui/src-tauri/` — Rust-Shell mit Tauri-Config
- [ ] **Long-lived Node-Sidecar-Lifecycle (per ADR-0006)**: `Command::sidecar().spawn()` beim App-Start, JSON-RPC via stdin/stdout (`kkrpc` als Lib), `ping`-Health-Check alle 30 s, 3-Strikes-Exponential-Backoff (1 s / 4 s / 16 s) bei Crash. Nach 3 Fails: Read-Only-Modus + Error-Toast.
- [ ] **`$TARGET_TRIPLE`-Suffix-Konvention** für Sidecar-Binaries (Hoppscotch-Pattern): `claude-os-sidecar-aarch64-apple-darwin`, `claude-os-sidecar-x86_64-pc-windows-msvc`, etc. Build-Script in `scripts/build-sidecar.{ps1,sh}`.
- [ ] Rust-Seite: minimale JSON-RPC-Layer auf `tokio::io::AsyncBufReadExt::lines` (~100 LOC, kein `kkrpc-rs`)
- [ ] Node-Seite: `kkrpc`-Registry mit `<domain>.<operation>`-Methodennamen, Domain-Code bleibt transport-agnostisch
- [ ] Graceful-Shutdown: `app.on_window_event(Close)` → `shutdown`-RPC → 2 s wait → SIGTERM → 2 s wait → SIGKILL
- [ ] `gui/src/` — Vite + React + TypeScript
- [ ] Tauri-Sidecar-Konfiguration für Node-Sidecar (long-lived) und für `bin/claude.exe` (per Command spawn, kurzlebig)
- [ ] Views: Dashboard, Chat-Wrapper, Settings, Catalog, Vault-Status, Agent-Run-Browser, Secrets
- [ ] **Drag-and-Drop via `webview.onDragDropEvent()`** — Multi-File nativ; **Dedup pro `event.id`** gegen [Tauri Bug #14134](https://github.com/tauri-apps/tauri/issues/14134). Auto-scoped Pfade — keine fs-Allowlist nötig.
- [ ] File-Watcher `inbox/` + `outbox/` via `chokidar` im Node-Sidecar
- [ ] Drag-and-Drop in Renderer schreibt nach `inbox/`
- [ ] Sidecar-Logs nach `%APPDATA%/claude-os/logs/sidecar-YYYY-MM-DD.log` (per ADR-0002 Pfad-Schema), Stderr zusätzlich in Renderer-Konsole
- [ ] Loading-Spinner während Sidecar-Init (~500 ms nach App-Start nicht verfügbar)
- [ ] `tauri.conf.json` Targets: Win MSI, macOS DMG (unsigniert v1), Linux AppImage
- [ ] Renderer-Smoke-Tests (React Testing Library)
- [ ] Sidecar-Restart-E2E-Test: kill via Task-Manager → Restart-within-5 s, RPC weiterhin funktional
- [ ] Drag-Drop-Dedup-Test: simulierter doppelter Event mit gleicher `event.id` → nur ein Inbox-Schreibvorgang

**Test-Kriterium:** GUI startet; Drag-and-Drop landet in `inbox/`; Skill-Liste rendert ≥ 1 Eintrag; Sidecar-Kill löst Auto-Recovery in <5 s aus; doppelte Drag-Events werden dedupt.

---

## Phase 7 — Cross-Platform-Validation und Docs (16 h, M, deps: Phase 6)

**Ziel:** Beweis der OS-Unabhängigkeit, vollständige Doku.

- [ ] macOS-Build via `tauri build`, manueller Run auf macOS-VM
- [ ] Linux-AppImage-Build, Run unter Ubuntu LTS
- [ ] `docs/cloud-providers.md` — Setups für OneDrive (Default), Google Drive, Dropbox, Nextcloud, rclone, `abraunegg/onedrive` für Linux
- [ ] `docs/migration-from-portable.md` — Schritt-für-Schritt für Bestands-User
- [ ] README rewrite (Deutsch, Bootstrap, Quickstart, Architekturdiagramm)
- [ ] **CI: GitHub Actions Matrix via `tauri-apps/tauri-action@v0`** über `windows-latest`, `macos-latest`, `ubuntu-22.04` für `build` + `test` + `biome ci`
- [ ] **Sidecar-Pre-Build im Workflow**: `$TARGET_TRIPLE`-Suffix-Binaries vor `tauri build` (Hoppscotch-Pattern: `rustc -Vv | grep host` → Resolver-Step für triple-Name)
- [ ] **macOS-Universal**: separate Builds für `x86_64-apple-darwin` + `aarch64-apple-darwin` (sonst Bundling-Fail)
- [ ] **Gatekeeper-Workaround-Doc** für unsignierte macOS-DMG (Phase 6 lieferte ungezeichnet)
- [ ] Tag v1.0.0

**Test-Kriterium:** Grüne CI-Matrix; Smoke-Test je OS dokumentiert.

---

## Out-of-Scope (v1)

Vollständige Roadmap mit Begründung: [docs/future.md](../docs/future.md).

- **v1.1**: MCP-Bundle pro Domain (per ADR-0007) — Constraint für v1: Domain-Interfaces müssen transport-agnostisch bleiben
- **v1.2**: Rust-Crate für Vault-Sync-Hot-Path (Spacedrive-Pattern)
- **v1.x**: Multi-Runtime-Skill-Symlinks (.claude/.pi/.opencode Pattern aus claudesidian)
- **v1.x**: Mobile-Access via Tailscale + Termius
- **v1.x**: macOS-Code-Signing
- **v1.x**: iCloud Drive als Cloud-Provider
- **v2**: Multi-User-Betrieb (mehrere Anthropic-Accounts pro Installation)
- **v2**: Tiefe OS-Integration (Autostart-Services, Systray, OS-Treiber)
- **v2**: Konfliktlösungs-UI für Vault-Merge-Konflikte (v1 bleibt Hard-Fail mit Doctor-Hinweis)
- **Permanent out-of-scope**: Eigene LLM-Hosting-Infrastruktur (Anthropic-API bleibt Backend)

---

## Top-Risiken

| Prio | Risiko | Mitigation |
|---|---|---|
| HIGH | `claude.exe` 120s-Hang reproduziert sich trotz neuem Wrapper | Streaming-stdin/stdout, kein voller Buffer, Heartbeat alle 10 s, integrierter Long-Running-E2E-Test in Phase 3 |
| MEDIUM | OneDrive transient `EBUSY` blockiert Snapshot-Worker | Retry-Backoff (3× je 500 ms), Lock-File-Awareness, Doctor warnt bei wiederholten Locks |
| ~~MEDIUM~~ MITIGATED | `iteenschmiede/claude-config` Auto-Pull überschreibt lokale Skill-Modifikationen | Gelöst durch ADR-0005 Selective-Merge-Pattern (Backup → Diff-Review → Zone-Classification → Resumable Checklist → Rollback) |
| MEDIUM | Tauri-Sidecar-Pattern hat Lernkurve | Phase 6 startet mit isoliertem Spike, offizielle Tauri-Docs sind ausreichend |
| LOW | JSON-Lines-Scans skalieren schlecht bei vielen Runs | Lokaler SQLite-Index als Read-Cache absorbiert, O(n) Rebuild beim Doctor |
| LOW | Schema-Drift in JSON-Lines | Versioniertes Schema-Feld pro Zeile, Reader toleriert ältere Versionen |

---

## Review-Sektion

(wird nach Abschluss jeder Phase ergänzt)
