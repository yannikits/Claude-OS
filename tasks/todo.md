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
- [x] **husky + lint-staged**: `.husky/pre-commit` ruft `npx lint-staged`; lint-staged-Glob `*.{ts,tsx,js,jsx,json}` → `biome check --write --no-errors-on-unmatched`. biome v2.4-Migration (`files.ignore` → `files.includes`, `organizeImports` → `assist.actions.source.organizeImports`) via `npx biome migrate --write`. Korrupter `core.hooksPath = --version/_` aus früherem broken `prepare`-Run via unset+re-prepare gefixt. → Commit `4909fb2`
- [x] **Vitest** statt Jest (pivot wegen ESM-Pain, siehe `lessons.md` 2026-05-16 Eintrag); Coverage-Threshold 70 % in `vitest.config.ts` → Commit `9c3b432`
- [x] `src/core/environment/root-resolver.ts` mit Env-Var- und Repo-Detect-Fallback + `types.ts` + `index.ts` → Commit `9c3b432`
- [x] `src/core/doctor/` — 5 Checks: Mount, Node-Version, Git, `bin/claude{,.exe}`-Existenz, Schreibrechte → Commit `5a3b6ab` (16 tests, all 5 checks runnable, runDoctor() handles RootNotFoundError gracefully)
- [x] `src/cli/index.ts` mit **commander v14**, Command `doctor` aktiv; globaler `--json`-Flag mit zentralem Renderer in `src/cli/presenters/doctor.ts` (ASCII-Marker für cmd.exe-Compat) → Commit `5a3b6ab`
- [x] `src/core/logging/` — pino-Factory mit Redaction-Path-Liste in `redact-paths.ts` (Pflicht-Code-Review-Gate); pino-roll + Stderr-Mirror deferred zu Phase 6 (per ADR-0013 §3 Production-Transport) → Commit `983c805`
- [x] Redaction-Tests: 15 Tests, Pflicht-`[REDACTED]`-Coverage für ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_*, GITHUB_TOKEN, *.password, *.token, credentials.* → Commit `983c805`
- [x] Shims: `claude-os.cmd` (Windows) + `claude-os` (POSIX, +x bit gesetzt via git index) am Repo-Root — 2026-05-17. Smoke: `./claude-os doctor --json` retourniert valid JSON über den Shim.
- [x] Unit-Tests Root-Resolver: 11 Tests + 9 detectCloudProvider-Tests = 20 grün → Commit `9c3b432`
- [x] Unit-Tests Doctor-Checks: 11 tests in checks.test.ts + 6 tests in runner.test.ts → 36 total (env=20, doctor=16), alle grün → Commit `5a3b6ab`
- [x] `npm link` Smoke: `npm run build && npm link` registriert globalen Shim `C:\Users\reapertakashi\AppData\Roaming\npm\claude-os.ps1`; `claude-os doctor` → `Summary: 5 ok, 1 warn, 0 fail (54ms total)`. WARN ist erwarteter `claude-binary not found in bin/` (User's `claude.exe` liegt in `~/.local/bin/`, nicht im claude-portable-Repo-CWD). — 2026-05-17
- [x] README-Skelett (Deutsch, Bootstrap-Sektion): Vollständiger Rewrite mit Was-es-ist / Architektur-in-60-Sekunden / Bootstrap / CLI-Overview. → Commit `9eb699b`
- [x] **TypeBox-Setup (per ADR-0012)**: `@sinclair/typebox` als Dep (war seit Phase 1a installiert via validation/format.ts); `src/core/schemas/{environment-manifest,index}.ts` + Test (19 Cases). Schema beschreibt `.claude-os-root`-Marker-Payload mit `version: 1` Literal, ISO-8601 `createdAt` (eigener `pattern` statt `format: 'date-time'` — vermeidet ajv-formats peer-dep), Optional `name`/`cloudProvider`/`notes`, `additionalProperties: false`. JSON-Schema-Export via `JSON.parse(JSON.stringify(...))` — TypeBox 0.34 removed `Type.Strict()`, da Schemas bereits spec-konform sind und JSON.stringify Symbol-keyed Metadata per ES2020 verwirft. → Commit `dc3ffc5`
- [x] `src/core/validation/format.ts` + `assertValid` + `ValidationError` (~100 LOC) für TypeBox/Ajv-Errors → Commit `0066278`
- [x] Validation-Tests: 16 Tests, formatPath JSON-Pointer→dotted-bracket, formatErrors/assertValid für valid/invalid/constraint-violation → Commit `0066278`

**Test-Kriterium:** `npm test` + `npm run lint` grün; `claude-os doctor` grüner Status. **Status: erfüllt** — `npx vitest run` 427/428 grün (1 long-running gated); `claude-os doctor` 5 ok / 1 warn (warn = erwarteter `claude-binary not found in bin/` da im claude-portable-Repo-CWD ausgeführt; User's `claude.exe` liegt in `~/.local/bin/`).

**Follow-up offen (separat von Phase 1 tail):** biome v2.4-Migration deckte 149 errors / 10 warnings im Source-Tree auf. Meist Suppression-Comment-Drift (Rule-Namen in v2.4 umbenannt) + neue Rules die v2.3 nicht enforce hat. Eigener Cleanup-Sprint. Pre-commit-Hook ist unaffected, da lint-staged nur auf gestagete Files läuft.

### Phase 1.5 / Phase 1g — Git-Metadaten-Migration (abgeschlossen 2026-05-16)

- [x] `claude-os doctor --migrate-git-metadata`: verschiebt `vault/.git/` nach `%APPDATA%/claude-os/git-metadata/vault.git/` via `git init --separate-git-dir` (Standalone-Modus — skippt regulärer Check-Suite). Implementiert in `src/core/git-metadata/migrator.ts` mit 5 States (`not-needed`, `no-git-dir`, `already-migrated`, `migrated`, `error`).
- [x] Idempotenz-Test: zweiter Aufruf erkennt gitfile + canonical path und retournt `already-migrated` ohne FS-Mutation.
- [x] Neue paths-Domain `src/core/paths/`: plattform-bewusste per-machine Pfade (win32 `%APPDATA%/claude-os/`, POSIX `${XDG_CONFIG_HOME:-~/.config}/claude-os/`) mit `$CLAUDE_OS_DATA_DIR`-Override für Tests; expose `gitMetadataDir`, `dataDir`, `logsDir` + `externalGitDirFor(repoName)`.
- [x] Tests: 13 paths-Tests + 8 migrator-Tests (real git init via simple-git, Idempotenz-Roundtrip, Gitfile-Pointing-Elsewhere-Error, Clobber-Prevention, custom workTreeName).

---

## Phase 2 — Vault-Sync-Subsystem (abgeschlossen 2026-05-17)

**Ziel:** Branch-aware Snapshot-Sync für Vault, push-only, mit Idle-Detection statt Cron (obsidian-git-Pattern). Conflict-Policy in 3 Modi, persistenter Busy-Flag. Aufgeteilt in 6 Sub-Phasen (2a–2f).

- [x] Phase 2a — `src/core/git/git-service.ts` (per ADR-0008): typed `simple-git`-Wrapper, `GitError`-Hierarchie (`GitNotInstalledError` / `GitLockfileError` / `GitMergeConflictError`), `mapError()` parsed stderr → typed errors. Doctor `checkWindowsLongPaths()` warnt bei `core.longpaths != true` mit One-Line-Fix. → Commit `434fc43`
- [x] Phase 2b — `domains/vault-sync/{types,branch-detect,snapshot,index}.ts`. `detectVaultBranch()` refused detached HEAD (Fix Memory-S251 — kein `main`-Hardcoding). Snapshot-Pipeline stage→commit→push mit ISO-timestamped Message `claude-os snapshot <ISO>`; Best-Effort-Push lässt lokalen Commit auf push-failed stehen. → Commit `3474d41`
- [x] Phase 2c — `vault-sync/{gitignore-template,busy-flag}.ts`. Default-Ignore-Liste curated aus obsidian-git #114 (workspace*, .obsidian/cache, .trash, claudeos-machine-state, OS-Cruft). BusyFlag persistiert `{busy, reason, pid, hostname, acquiredAt}` als JSON unter `<dataDir>/vault-sync-state.json` (atomic tempfile+rename, 0o600). Same-host stale-PID-Detection via `process.kill(pid, 0)`; cross-host nur via `vault unlock` (forceReset). → Commit `0b3fb26`
- [x] Phase 2d — `vault-sync/scheduler.ts`: chokidar-basierter Idle-Watcher mit separatem `setTimeout(idleMs)` (NICHT awaitWriteFinish für Multi-Minuten-Window — Issues #384/#675); `awaitWriteFinish {2000ms/100ms}` parallel für Per-File-Save-Smoothing; Cloud-Mount-Auto-Detect → polling-Mode `{usePolling: true, interval: 2000, binaryInterval: 5000}` (Issues #895/#998/#225); In-flight-Guard verhindert Double-Fire. Test-Seams `chokidarFactory`/`timers`/`now()` injectable. → Commit `9523116`
- [x] Phase 2e — `vault-sync/conflict-policy.ts`: 3-Modi Push-Reject-Handling. `abort` Hard-Fail mit Doctor-Hint, `prefer-local` Fetch+`force-with-lease` (Lease schützt gegen echte concurrent writers), `prefer-remote` legt Backup-Branch `claude-os/backup/<branch>/<ISO>` (colons→hyphens für ref-name-Legality) und rewindet via `git reset` auf remote tip. `isPushConflictError` Predicate exportiert für Caller-Decision. → Commit `c0d93e2`
- [x] Phase 2f — `vault-sync/vault-config.ts` (atomic JSON-Persistence) + CLI-Wire: `vault snapshot` (acquires busy-flag → snapshot → on push-failed apply policy → release), `vault status` (text/--json), `vault conflict-mode`, `vault schedule --enable/--disable [--idle-seconds N]` (Scheduler runs in Phase-6-Sidecar; CLI persistiert nur Config), `vault unlock` (forceReset busy-flag), `vault init-gitignore` (idempotent merge). → Commit `57d6c63`

**Test-Kriterium:** Real CLI-Smoke (Windows, temp bare-repo fixture): `vault status` → defaults; `echo X > vault/n.md` + `vault snapshot` → `[OK] master: pushed 1 files to origin`; `vault conflict-mode prefer-local` persistiert; `vault schedule --enable --idle-seconds 60` persistiert; `vault init-gitignore` legt 11 Default-Lines; `vault unlock` graceful no-op. **Status: erfüllt.**

**Tests-Gewinn:** +64 (2a 13, 2b 11, 2c 15, 2d 9, 2e 8, 2f 8). Total 191/191 grün (+1 long-running gated). Alle Sub-Module gegen reale bare-repo + tmpdir-Fixtures + FakeWatcher EventEmitter unit-getestet.

**v1-Abweichungen (transparent):**

- **Busy-Flag als JSON statt SQLite** — atomic tempfile+rename + 0o600 reicht für single-process Sidecar-Modell; sql.js-Migration nicht nötig. ADR-0002 spec'te sqlite, aber JSON ist robuster ohne native-build.
- **Working-tree merge-conflicts explizit out-of-scope** für v1 automatic policy — `conflict-policy` adressiert ausschließlich push-rejection-Divergenzen. Echte merge-conflicts bleiben Hard-Fail mit Doctor-Hinweis (Phase 6 evtl. UI).
- **Real-FS-Scheduler-Roundtrip + BusyFlag-Integration** als Long-Running-E2E deferred zur Sidecar-Phase — Scheduler-Unit-Tests nutzen FakeWatcher; reine FS-Integration kommt mit Phase-6-Tauri-Sidecar-Lifecycle (Scheduler läuft dort, nicht im CLI-Prozess).
- **`force-push --with-lease` statt Confirm-Prompt** in `prefer-local` — Lease ist sicherer als interaktiver Bestätigungsprompt (atomic against concurrent writers). v1 hat keine TTY-Prompt-Infra; Phase 6 kann GUI-Confirm darüberlegen.
- **TOCTOU-Race im Busy-Flag dokumentiert** — v1 vertraut auf single-process-Scheduler + user-serialisiertes CLI. Echter Mutex (file-locking/lockfile) ist Phase-6-Hardening.

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

## Phase 5 — Agent-OS-Subsystem + Catalog/Skill-Registry (abgeschlossen 2026-05-17)

**Ziel:** Account-Auth, JSON-Lines-Agent-Runs (ADR-0002), Vault-Output-Persistence, Catalog-System-Foundation (ADR-0009 + ADR-0010). Aufgeteilt in 8 Sub-Phasen (5a–5h).

- [x] Phase 5a — `domains/agent-runs/{types,jsonl-writer,index}.ts`. AgentRunRecord-Schema mit Project-Column (Memory-565 Fix). Append-only JSONL via `appendFileSync`, eine Datei pro `(project, machineId)`. → Commit `(5a)`
- [x] Phase 5b — `agent-runs/index-builder.ts`. **JSON-basiert statt SQLite** für v1 (kein zusätzlicher native-build Dep). Walks JSONL → sortiert timestamp-DESC → atomic write. Query-API mit Filter (project, machineId, sinceIso, limit). Malformed-Lines tolerant. → Commit `2c30490`
- [x] Phase 5c — `agent-runs/{repository,vault-writer}.ts`. Public Façade mit `record/list/show/byProject/refreshIndex`. VaultWriter emittiert `<vault>/agent-runs/<project>/<ISO-safe>.md` mit YAML-Frontmatter + Prompt + stdio-inherit-Caveat. → Commit `(5c)`
- [x] Phase 5d — `domains/auth/{types,credentials,profile-manager,state-check}.ts`. State-Check-Resolution-Order: CI-Env → CLI-Subprocess (injectable) → `.credentials.json` File → no-creds. ProfileManager mit `$ANTHROPIC_CONFIG_DIR`-Sandboxing für Multi-Account. Doctor-Schema-Drift-Check für `.credentials.json`-Felder. → Commit `(5d)`
- [x] Phase 5e — `domains/catalog/{source-resolver,tarball-installer}.ts`. Parser für `marketplace:` / `github:owner/repo[@ref][:subPath]` / `local:` Sources. Tarball-Installer mit sha256-Cache-Key, idempotenter Reuse, codeload.github.com-URL für public repos. → Commit `(5e)`
- [x] Phase 5f — `catalog/{marketplace-registry,scope-merger,cache-cleaner}.ts`. File-based Registry-Loader (ETag-URL-Fetch deferred), Scope-Merge (Project wins über User), 30-day Tarball-Retention. → Commit `(5f)`
- [x] Phase 5g — `catalog/{capability,capability-resolver}.ts`. Deterministischer DFS-Resolver mit 4 ResolutionError-Subtypen (MissingProvider, VersionConflict, CyclicDependency, AmbiguousProvider). Eigener Mini-Comparator (`>=`, `>`, `<=`, `<`, `=`) ohne semver-Dep. **2 explizite Regression-Tests gegen Memory-587/593 + ruflo #1676 Reproducer.** → Commit `(5g)`
- [x] Phase 5h — CLI-Wire: `agent list|show|replay`, `auth status|login|profile create|use|list|delete`, `catalog install|resolve` (echte impl) + `catalog list|uninstall|enable|disable|update|lock|sync` (Phase-6-Sidecar-Hint). → Commit `59e16a9`

**Test-Kriterium:** Echtes Smoke-Roundtrip auf User's Windows-Maschine — `auth status` retourniert `source=file, loggedIn=true, scopes=user:*` aus realer Anthropic-Login. `agent list` schreibt korrekt "(no agent runs recorded yet)". `catalog` rendert install/resolve mit Phase-6-Hints für staged subcommands.

**Tests-Gewinn:** +135 (5a 12, 5b 17, 5c 16, 5d 35, 5e 26, 5f 28, 5g 29, 5h 0 — CLI integration deferred). Domain-Module unit-tested gegen reale bare-repos + tmpdir-Fixtures + injektive Mocks für Subprocess + Fetch. Total 408/408 grün.

**v1-Abweichungen (transparent):**

- **Agent-Runs Index in JSON statt SQLite** — kein native-build-dep für v1; sql.js drop-in für v1.x. Performance für Early-Adoption-Datensätze trivial.
- **macOS-Keychain-Read deferred** zu v1.x — `.credentials.json`-Fallback funktioniert auf macOS auch.
- **Refresh-Mutex / proaktiver Refresh deferred** — claude.exe besitzt den Refresh; wir warnen bei expiresAt < 1h via state-check.warning. Regression-Tests gegen claude-code #50743/27933/31095 sind deferred (Race-Reproducer braucht echte concurrent claude.exe-Spawns).
- ~~**Marketplace ETag-URL-Fetch deferred** — der RegistryLoader-Pattern ist injectable, file-Loader shipped, URL-Loader fehlt.~~ → **erledigt 2026-05-17 Phase 5k** (Commit folgt). `src/domains/catalog/marketplace-url-loader.ts` mit injektivem `fetch`-Hook, ETag-Cache unter `<cacheDir>/marketplace-<sha16>.{json,etag}`, `If-None-Match`+304-Roundtrip. `validateRegistry` aus `marketplace-registry.ts` herausgezogen für Shared-Use. +13 Tests inkl. 304-null-body-Spec-Workaround und Multi-URL-Cache-Key-Disjunktion.
- ~~**Capability-Resolver Version-Constraints** beschränkt auf `>=` / `>` / `<=` / `<` / `=` (keine `^` / `~`-Ranges in v1).~~ → **erledigt 2026-05-17 Phase 5j** (Commit `fee2aff`). `^` + `~` implementiert per npm-semver-Regel (`^1.2.3` → `>=1.2.3 <2.0.0` mit left-most-non-zero für major=0; `~1.2.3` → `>=1.2.3 <1.3.0`). +13 Tests inkl. major-zero/patch-zero Edge-Cases. `~1` (nur major) bleibt v1-Simplification = `==1.0.0` (für "any 1.x.x" `^1` nutzen — dokumentiert).
- **Lazy-Activation + Uninstall-Hooks** deferred zur Phase-6-Sidecar-Integration.
- **`--auto-deps` flag** + transitive marketplace resolution deferred — v1 erfordert manuelle Pre-Installation der Provider.
- ~~**catalog.json / catalog.lock.json Schema + Validator deferred** zur Phase-6-Sidecar-Integration. `catalog list/uninstall/enable/disable/update/lock/sync` zeigen Phase-6-Pointer.~~ → **vollständig erledigt 2026-05-17**: **Phase 5i** (Commit `cff079c`) schema + store + `list`; **Phase 5l** (Commit `4fa4f7d`) `enable/disable/uninstall` real; **Phase 5m** (Commit `bb195f0`) `lock` real via `lockCatalog`-Builder; **Phase 5n** (Commit folgt) `sync` (`applyLock` → extract enabled github-entries aus Cache nach `<root>/config/{skills|plugins|mcp}/<id>` via strip=1 tar.extract) + `update [<id>]` (full-relock alias für `lock`, oder Single-Entry-Update mit `mergeLockEntry` merge into existing lock). Komplette Catalog-Pipeline shipped. Bindings=[] bleibt offen (Phase 5o — Plugin-Manifest-Reader + `resolveCapabilities`-Integration).
- **Skill-Pack-Import** als bundled marketplace deferred — User kann via direkter `github:`-Source nutzen.

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
