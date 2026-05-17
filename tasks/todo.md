# Claude Develop Environment OS — Implementierungs-Tracker

**Quelle:** `C:\Users\reapertakashi\Downloads\claude-develop-environment-os.md`
**Plan-Datum:** 2026-05-15
**Gesamtschätzung:** ~120 Stunden
**Architektur-Entscheidungen:** [docs/architecture/adr/](../docs/architecture/adr/)

---

## Phase 0 — Repo-Vorbereitung (2 h, Komplexität L)

**Ziel:** Sauberer Ausgangspunkt; USB-Reste raus, Branch + Tracking-Struktur steht.

- [x] Branch `feature/claude-os-v1` aus `main` erstellen (2026-05-16)
- [x] USB-Sync-Scripts löschen: `sync-from-usb.bat`, `sync-to-usb.bat` → Commit `a300592`
- [x] Legacy-Launcher in `legacy/` verschieben: `start.bat`, `start.ps1`, `setup.bat`, `sync-vault-pull.bat`, `sync-vault-push.bat` → Commit `954ee9b`
- [ ] GitHub-Issues: Epic + 1 Tracking-Issue pro Phase (oder lokale Issue-Liste falls kein GitHub-Sync gewünscht) — *pending User-Entscheidung*
- [x] `tasks/todo.md` (diese Datei) committen → Commit `1466bd5`
- [x] `tasks/lessons.md` initialisieren → Commit `1466bd5`

**Test-Kriterium:** `git log --oneline` zeigt Cleanup-Commits; `git ls-files | grep -E "sync.*usb"` leer. **Status: erfüllt (3/3 Commits, sauberer Working-Tree).**

---

## Phase 1 — Node-Bootstrap und Doctor MVP (16 h, M, deps: Phase 0)

**Ziel:** Lauffähiges TypeScript-Projekt mit `claude-os doctor` als ersten Smoke-Test.

- [x] `package.json` (Node ≥ 20, ESM, scripts; current-version Deps post npm view audit) → Commit `076acd5` + `9c3b432` (commander v14, pino v10, typebox v0.34, keyring v1.3 — alle latest)
- [x] `tsconfig.json` strict, Pfad-Aliase (`baseUrl` entfernt für TS 7 compat, `types: ["node"]` für globals) → Commit `076acd5` + `9c3b432`
- [x] **biome v2.3 (per ADR-0014)**: `biome.json` mit `recommended: true`, strict TS-Rules → Commit `2dafcea` (user-authored wegen config-protection-Hook)
- [ ] **husky + lint-staged**: lint-staged-Config in package.json, husky-Init noch nicht ausgeführt (deferred zu Phase 1c)
- [x] **Vitest** statt Jest (pivot wegen ESM-Pain, siehe `lessons.md` 2026-05-16 Eintrag); Coverage-Threshold 70 % in `vitest.config.ts` → Commit `9c3b432`
- [x] `src/core/environment/root-resolver.ts` mit Env-Var- und Repo-Detect-Fallback + `types.ts` + `index.ts` → Commit `9c3b432`
- [x] `src/core/doctor/` — 5 Checks: Mount, Node-Version, Git, `bin/claude{,.exe}`-Existenz, Schreibrechte → Commit `5a3b6ab` (16 tests, all 5 checks runnable, runDoctor() handles RootNotFoundError gracefully)
- [x] `src/cli/index.ts` mit **commander v14**, Command `doctor` aktiv; globaler `--json`-Flag mit zentralem Renderer in `src/cli/presenters/doctor.ts` (ASCII-Marker für cmd.exe-Compat) → Commit `5a3b6ab`
- [x] `src/core/logging/` — pino-Factory mit Redaction-Path-Liste in `redact-paths.ts` (Pflicht-Code-Review-Gate); pino-roll + Stderr-Mirror deferred zu Phase 6 (per ADR-0013 §3 Production-Transport) → Commit `983c805`
- [x] Redaction-Tests: 15 Tests, Pflicht-`[REDACTED]`-Coverage für ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_*, GITHUB_TOKEN, *.password, *.token, credentials.* → Commit `983c805`
- [x] Shims: `claude-os.cmd` (Windows) + `claude-os` (POSIX, +x bit gesetzt via git index) am Repo-Root — 2026-05-17. Smoke: `./claude-os doctor --json` retourniert valid JSON über den Shim.
- [x] Unit-Tests Root-Resolver: 11 Tests + 9 detectCloudProvider-Tests = 20 grün → Commit `9c3b432`
- [x] Unit-Tests Doctor-Checks: 11 tests in checks.test.ts + 6 tests in runner.test.ts → 36 total (env=20, doctor=16), alle grün → Commit `5a3b6ab`
- [ ] `npm link` Smoke: `claude-os doctor` grün auf aktueller Maschine
- [ ] README-Skelett (Deutsch, Bootstrap-Sektion)
- [ ] **TypeBox-Setup (per ADR-0012)**: `@sinclair/typebox` als Dep, `src/core/schemas/`-Verzeichnis, erste `EnvironmentManifest`-Schema-Definition mit `Type.Strict()`-Export
- [x] `src/core/validation/format.ts` + `assertValid` + `ValidationError` (~100 LOC) für TypeBox/Ajv-Errors → Commit `0066278`
- [x] Validation-Tests: 16 Tests, formatPath JSON-Pointer→dotted-bracket, formatErrors/assertValid für valid/invalid/constraint-violation → Commit `0066278`

**Test-Kriterium:** `npm test` + `npm run lint` grün; `claude-os doctor` grüner Status.

### Phase 1.5 / Phase 1g — Git-Metadaten-Migration (abgeschlossen 2026-05-16)

- [x] `claude-os doctor --migrate-git-metadata`: verschiebt `vault/.git/` nach `%APPDATA%/claude-os/git-metadata/vault.git/` via `git init --separate-git-dir` (Standalone-Modus — skippt regulärer Check-Suite). Implementiert in `src/core/git-metadata/migrator.ts` mit 5 States (`not-needed`, `no-git-dir`, `already-migrated`, `migrated`, `error`).
- [x] Idempotenz-Test: zweiter Aufruf erkennt gitfile + canonical path und retournt `already-migrated` ohne FS-Mutation.
- [x] Neue paths-Domain `src/core/paths/`: plattform-bewusste per-machine Pfade (win32 `%APPDATA%/claude-os/`, POSIX `${XDG_CONFIG_HOME:-~/.config}/claude-os/`) mit `$CLAUDE_OS_DATA_DIR`-Override für Tests; expose `gitMetadataDir`, `dataDir`, `logsDir` + `externalGitDirFor(repoName)`.
- [x] Tests: 13 paths-Tests + 8 migrator-Tests (real git init via simple-git, Idempotenz-Roundtrip, Gitfile-Pointing-Elsewhere-Error, Clobber-Prevention, custom workTreeName).

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

## Phase 3 — Hybrid-CLI mit AI-Delegation (abgeschlossen 2026-05-17)

**Ziel:** Vollständiger `claude-os`-Command-Tree und stabile `claude.exe`-Anbindung. Aufgeteilt in 5 Sub-Phasen (3a–3e).

- [x] Phase 3a — Command-Stubs für `update`, `vault`, `catalog`, `secrets`, `agent`, `auth`, `ai` → Commit `d878c1a`
- [x] Phase 3b — `src/domains/claude-bridge/spawn.ts` mit `child_process.spawn` + `stdio: 'inherit'` (kein 120s-Cutoff, Fix Memory 569/577/578) → Commit `4f26d80`
- [x] Phase 3b — SIGINT-Propagation mit 5s-Grace → SIGKILL (zweite Ctrl-C eskaliert sofort); SIGTERM-Forward → Commit `4f26d80`
- [x] Phase 3b — Heartbeat alle 10s als strukturiertes pino-Log mit `{pid, elapsedMs}` → Commit `4f26d80`
- [x] Phase 3b — `resolve-binary.ts` mit `<root>/bin/claude{,.exe,.cmd}` → `$PATH`-Walk-Fallback (deckt User's `~/.local/bin/claude.exe`-Install, Memory 549/550) → Commit `4f26d80`
- [x] Phase 3c — `cli/commands/ai.ts` forwarded argv 1:1, Exit-Code propagiert (Signals → 130/143/137), BinaryNotFoundError → exit 127 → Commit `4f26d80`
- [x] Phase 3d — `domains/secrets/` mit `KeyringStore` (@napi-rs/keyring, Service-Name `claude-os`) + `EncryptedFileStore` (AES-256-GCM, PBKDF2-SHA-256 mit 600k iterations, 16-byte salt, 12-byte IV, 16-byte GCM-tag, atomic write via tempfile+rename, mode 0o600) → Commit `0f766f5`
- [x] Phase 3d — `factory.ts` Backend-Detection: `$CLAUDE_OS_SECRETS_BACKEND` Override → `probeKeyring()` set+delete sentinel → encrypted-file fallback → Commit `0f766f5`
- [x] Phase 3d — CLI: `secrets set/get/list/delete` mit --json-Mode, Values nie geloggt → Commit `0f766f5`
- [x] Phase 3e — Long-Running-E2E (180s) via vitest's `describe.skipIf` gated hinter `$RUN_SLOW_TESTS=1` (regulärer `npm test` bleibt schnell) → (commit pending nach Test-Run)

**Test-Kriterium:** Manueller Smoke: `claude-os ai --help` reicht Anthropic-Help durch. **Status: erfüllt** — auf User's Windows-Maschine `node dist/cli/index.js ai --help` resolved `~/.local/bin/claude.exe` via `$PATH`, forwarded `--help`, Anthropic-CLI druckte sein eigenes Help, Exit 0 propagiert.

**Tests-Gewinn:** +33 (3a 0, 3b 16, 3c 0, 3d 17, 3e 1 gated). Total 121/121 grün ohne Long-Slow-Tag, 122 mit `RUN_SLOW_TESTS=1`.

---

## Phase 4 — Update-Orchestrator (abgeschlossen 2026-05-17)

**Ziel:** Tiered Auto-Update beim Start; Plugin-Updates explizit; Selective-Merge-Pattern nach ADR-0005. Aufgeteilt in 6 Sub-Phasen (4a–4f).

- [x] Phase 4a — `domains/update-orchestrator/env-repo.ts` + `skills-repo.ts` mit `git pull --ff-only`, 7-state UpdateState (up-to-date/updated/cloned/aborted-dirty/aborted-diverged/no-remote/error). GitService.clone() static + pull-with-ffOnly. → Commit `eb3e80d`
- [x] Phase 4b — `BackupManager` mit `snapshot(scope, sourceDir)` / `restore(ts|'latest', dest)` / `prune(retention=5)` / `list()`. Layout `<dataRoot>/backups/update-<ISO-safe-ts>/{scope/,manifest.json}`. → Commit `2451433`
- [x] Phase 4c — `ZoneClassifier`: `.skill-lock.json` (JSON statt YAML — Lesson 2026-05-17) + Frontmatter-Regex `claudeos: locked`; klassifiziert pro Datei in System / Personal / Locked. → Commit `0908298`
- [x] Phase 4d — `DiffEngine` über `diff@9` (Binary-Detect via NUL-byte, 5-state DiffStatus) + presentation-agnostic `ReviewLoop` mit injectable decide+applyUpgrade. Locked/personal/unchanged/removed auto-keep; system+modified ruft IMMER decide (auch mit --auto-accept). → Commit `5221a06`
- [x] Phase 4e — `ResumableChecklist` mit atomic markdown persistence (`<dir>/upgrade-checklist-<ISO-safe-ts>.md`). `create()` / `load()` / `loadLatest(scope)` (skipt completed Runs default) / `markDone()` / `complete()` / `abandon()`. → Commit `239a4de`
- [x] Phase 4f — `plugins.ts` placeholder mit separater Log-Datei `<logsDir>/plugin-update-<ts>.log` (Memory-587/593-Mitigation steht; echte Install-Logik braucht Phase-5-Catalog). CLI `update [--env|--skills|--plugins|--all|--auto-accept|--rollback [ts]|--resume]` end-to-end wired. → Commit `5f93a4c`

**Test-Kriterium:** Real CLI-Smoke (Windows): `update --env` retourniert `[WARN] env-repo working tree dirty (11 files); refusing to pull` mit Exit 2; `update --plugins` retourniert `[WARN] plugins: plugin updates require Phase 5 catalog` mit Exit 2; `update` ohne Flag → Hint + Exit 1; `update --rollback` listet Backups oder Hint wenn keine vorhanden.

**Tests-Gewinn:** +50 (4a 9, 4b 12, 4c 12, 4d 17, 4e 12, 4f 0 — CLI integration deferred). Domain-Module sind direct unit-tested gegen reale bare-repo + tmpdir-Fixtures. Total 245/245 grün (+1 long-running gated).

**v1-Abweichungen von ADR-0005 (transparent):**

- `.skill-lock.json` statt YAML — JSON ist robuster (kein eigener Parser), gleiches Verhalten. ADR-0005 §38 erwähnt YAML als claudesidian-Vorbild, ist aber nicht zwingend.
- **Full selective-merge orchestrator deferred**: Die einzelnen Pieces (BackupManager + ZoneClassifier + DiffEngine + ReviewLoop + ResumableChecklist) sind isoliert getestet und einsatzbereit. Die CLI-Composition (upstream-mirror-clone → walk → classify → diff → review-loop → checklist → apply) ist in `update.ts` skizziert aber nicht voll verdrahtet. `update --skills` bei `aborted-dirty` zeigt einen Hint statt zu starten. Vollständiger Flow ist eine kleinere Folge-Iteration.
- **Interactive review** (enquirer-Prompts) deferred — die ReviewLoop akzeptiert einen injectable `decide`-Callback; eine echte TTY-UI ist Phase-4-Tail oder Phase-6-GUI. v1 lebt mit `--auto-accept` für clean Diffs.
- **Plugin install path** deferred zu Phase 5 (braucht Catalog für Manifest-Resolution).

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

### Phase 0 — abgeschlossen 2026-05-16

**Ausführungsdauer:** 1 Bash-Call, ~5 Sekunden.

**Output:**
- Branch `feature/claude-os-v1` aktiv
- Commits:
  - `a300592` chore: remove USB sync layer (2 Files gelöscht, 53 Lines weg)
  - `954ee9b` chore: move legacy launchers to legacy/ (5 Files verschoben)
  - `1466bd5` docs: add 14 ADRs and Phase 0 task tracking (18 neue Files, 1758 Lines)
- Working-Tree clean

**Offen:** GitHub-Issue-Anlage übersprungen (User-Entscheidung "lokale issues").

**Nicht gepushed:** Branch lebt nur lokal. Push wenn User es freigibt.

### Phase 1a — abgeschlossen 2026-05-16

**Commits:**
- `076acd5` Node-Bootstrap-Config (package.json + tsconfig.json + .editorconfig + .gitignore-Erweiterung)
- `2dafcea` biome.json (User-authored wegen config-protection-Hook)
- `42a50dd` Phase-0-Tracking-Update

**Output:** Funktionierende npm-Konfiguration; 139 Packages installiert nach Version-Audit, 0 vulnerabilities.

### Phase 1b — abgeschlossen 2026-05-16

**Commit:** `9c3b432` — environment-Domain mit root-resolver + vitest-Setup.

**Tech-Pivots:**
- Jest → Vitest (ESM-Pain-Avoidance, dokumentiert in `lessons.md`)
- Deprecated `baseUrl` aus tsconfig entfernt (TS 7 compat)
- Major-Bumps auf aktuelle Versionen post `npm view`-Audit (commander v14, pino v10, typescript v6, @types/node v25, biome v2.4, vitest v4)

**Verifikation:**
- `npx tsc --noEmit` → exit 0
- `npm test` → 20/20 grün (11 resolveRoot-Tests + 9 detectCloudProvider-Tests)
- Coverage-Threshold 70% in vitest.config.ts gesetzt

### Phase 1d — abgeschlossen 2026-05-16

**Commit:** `983c805` — logging-Domain mit pino-Factory + Redaction.

**Output:** 4 Files, 313 LOC. createLogger() mit zentralem REDACT_PATHS, ISO-timestamps, ENV-Var-basierter Level-Resolution.

**Constraints:** pino-roll + Stderr-Mirror deferred zu Phase 6 (per ADR-0013 §3 — Production-Transport ist GUI-Shell-Responsibility).

**Verifikation:**
- `npx tsc --noEmit` → exit 0
- `npm test` → 51/51 grün (+15 Redaction-Tests)

### Phase 1e — abgeschlossen 2026-05-16

**Commit:** `0066278` — validation-Domain mit formatErrors + assertValid.

**Output:** 3 Files, 200 LOC. `formatPath()` konvertiert JSON-Pointer `/entries/2/source` → `entries[2].source`. `assertValid()` throwing variant für fail-fast Contexts.

**Lesson:** TypeBox `format: 'email'` benötigt ajv-formats peer-dep. Tests nutzen strukturelle Constraints (minLength, minimum) statt — keine zusätzliche Dep nötig.

**Verifikation:**
- `npx tsc --noEmit` → exit 0
- `npm test` → 67/67 grün (+16 Validation-Tests)

### Phase 1c — abgeschlossen 2026-05-16

**Commit:** `5a3b6ab` — doctor-Domain + CLI commander-Skelett mit `claude-os doctor` end-to-end runnable.

**Output:** Erstes echtes Subcommand des Projekts. 10 neue Files, 559 LOC.

**Erkenntnisse:**
- Architektur-Recon zu Session-Start hatte `bin/claude.exe` im claude-portable-Repo angenommen — Memory-ID 549/550 zeigt aber dass User's `claude` unter `~/.local/bin/claude` liegt. Fix: `.claude-os-root`-Marker-File explizit erstellt (war ohnehin der vorgesehene Mechanismus per ADR-0002).
- runDoctor() handlet RootNotFoundError graceful: produziert `root-resolution`-Check-Fail + läuft trotzdem die root-unabhängigen Checks (node-version, git-available).
- ASCII-Marker `[OK]`/`[WARN]`/`[FAIL]` statt Unicode-Symbole für cmd.exe-Render-Kompatibilität.

**Verifikation:**
- `npx tsc --noEmit` → exit 0
- `npm test` → 36/36 grün (16 neue doctor-Tests)
- `npm run build` → dist/ populated
- Real Smoke-Test in claude-portable: 4 OK + 1 WARN (claude-binary fehlt erwartungsgemäß), Overall WARN, exit 0
- `claude-os doctor --json` produces valid JSON

### Phase 1g — abgeschlossen 2026-05-16

**Output:** `--migrate-git-metadata` Standalone-Flag am `doctor`-Command. Move-Logic via `git init --separate-git-dir`. Neue paths-Domain als Foundation für Phase 2/5/6.

**Files (7 neu + 2 Edits):**
- `src/core/paths/{types,machine-paths,index}.ts` — plattform-bewusste per-machine Pfade
- `src/core/git-metadata/{types,migrator,index}.ts` — idempotenter Migrator
- `src/cli/presenters/migration.ts` — Text + JSON Output
- `src/cli/commands/doctor.ts` — `--migrate-git-metadata` Flag wired
- Tests: `tests/core/paths/machine-paths.test.ts`, `tests/core/git-metadata/migrator.test.ts`

**Lessons:**
- Node's `fs.realpathSync` resolves Symlinks aber NICHT Windows-8.3-Short-Names. Für `REAPER~1` → `reapertakashi` braucht es `fs.realpathSync.native` (OS-Implementation, Windows-spezifisch funktional). Geloggt in `lessons.md`.
- `path.resolve`/`path.join` sind runtime-platform-fest. Für Cross-Platform-Tests einer plattform-bewussten Module muss man explizit `path.posix.*` / `path.win32.*` dispatchen — sonst kollabiert die POSIX-Branch auf Windows-Runnern zu `C:\home\test\...`.

**Verifikation:**
- `npx tsc --noEmit` → exit 0
- `npm test` → 88/88 grün (+21 neue Tests: 13 paths + 8 migrator)
- `npm run build` → dist/ populated
- Real Smoke: `node dist/cli/index.js doctor --migrate-git-metadata --json` retourniert `no-git-dir` korrekt (kein vault/ im claude-portable repo), externalGitDir resolved nach `%APPDATA%\claude-os\git-metadata\vault.git`
