# Changelog

Alle relevanten Aenderungen an `claude-os` werden hier dokumentiert. Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Versionierung folgt [SemVer](https://semver.org/).

## [Unreleased]

### Sicherheit (Critical-Block aus Code-Review 2026-05-21)

- **C1** `scheduler/runner` — `shell: true` RCE entfernt; user-supplied commands werden via argv-tokenization an `spawn` weitergereicht (PR #61).
- **C2** `sidecar/methods` — `inbox.import` Path-Traversal/Symlink-Exfil-Schutz: lstat + realpath + deny-list (`<dataDir>`, `~/.claude`, cloud-mount root) (PR #61).
- **C3** `catalog/safe-tar-extract` — Allow-list-filter (File/Directory/GNULongPath only) verhindert symlink/hardlink Schreibversuche aus malicious Tarballs; cleanupOnFailure entfernt partial-extracted state (PR #61).
- **C4** `vault-sync/scheduler` — `fireSnapshot` Race fix: `pendingFire`-Flag + finally re-fire fuer Event-Bursts (PR #61).
- **C5** `vault-sync/busy-flag` — TOCTOU-safe `acquire()` via `openSync('wx')` exclusive-create + ownership-check in `release()` (PR #61).
- **C6** `cli/commands/catalog` — `as never`-Cast entfernt; Type-Check wieder aktiv fuer `lockCatalog`-Payload (PR #61).
- **C7** `tests/auto-deps-resolver` — false-positive Cycle-Test gefixt + Version-Conflict-Test ergaenzt (PR #61).

### Sicherheit (Major-Security aus Code-Review 2026-05-21)

- **M1** `sidecar/chat-sessions` — `.cmd`/`.bat`-spawn refused args mit Shell-Metachars (`&|<>"`^`) (PR #62).
- **M2** `claude-bridge/resolve-binary` — `ResolvedBinary.warning` bei `$PATH`-fallback (PATH-Hijack-Defense) (PR #62).
- **M4** `catalog/marketplace-url-loader` — SSRF-Schutz: `allowedHosts`-Allowlist + https-only; `DEFAULT_MARKETPLACE_HOSTS` exportiert (PR #62).
- **M6** `secrets/encrypted-file-store` — Node-GCM-internal-Message wird beim decrypt-Fehler scrubbed; opaque "wrong master key or corrupted file" (PR #62).
- **M7** `core/git` — `GitArgValidationError`-Guard gegen argv-injection via remote/branch/clone-source mit `-`-Prefix (CVE-2024-32002-Familie) (PR #62).
- **M9** `secrets/encrypted-file-store` — Windows-ACL-Caveat dokumentiert (`mode: 0o600` wird auf Windows ignoriert) (PR #62).
- **M10** `auth/credentials` — `$ANTHROPIC_CONFIG_DIR` wird realpath-aufgeloest; `validateAnthropicConfigDir`-Helper fuer Doctor (PR #62).
- **M11** `sidecar/methods` — `catalog.list` leakt nicht mehr File-Path bei `InvalidCatalogError`; opake `{ok:false, code:'invalid-catalog'}` shape (PR #62).

### Architektur (Major-Architektur aus Code-Review 2026-05-21)

- **M19+M22** `cli/output.ts` — `GlobalOpts`/`printJson`/`printLine`/`printErr`/`resolveRootOrExit` aus 11 CLI-Files extrahiert; ~150 LOC duplicate weg (PR #63).
- **M20** `sidecar/logger` — `REDACT_PATHS` jetzt auch im Sidecar-pino angewendet (vorher silent un-redacted) (PR #63).
- **M23** `catalog/auto-deps-resolver` — Klassen-Rename `MissingProviderError → AutoDepsMissingProviderError` (kein `as`-Aliasing mehr in facade) (PR #63).
- **M24** `sidecar/methods` — `SecretsLockedError` aus secrets-Facade statt Internal-Types-Import (PR #63).

### Performance (Major-Performance aus Code-Review 2026-05-21)

- **M12** `cli/index` — Lazy subcommand-loader via dynamic-import. Spart 50-150ms CLI cold-start fuer nicht-catalog Subcommands (PR #64).
- **M13** `sidecar/methods` — `agent.list` Singleton-Repository; O(records) → O(1) per RPC bei cold-cache (PR #64).
- **M15** `catalog/capability-resolver` — `findProviders` mit `WeakMap<Catalog, ProvidersIndex>`-Cache; O(N²·R·Pp) → O(N·R) (PR #64).
- **M16** `agent-runs/index-builder` — `JSON.stringify` ohne pretty-print indent; -30-40% Size + Stringify-Zeit (PR #64).
- **M17** `migration/copy-tree` — File-counts im `fs.cp`-filter-Callback erfasst; zweiten `walkAsync` entfernt; halbiert Wall-Time fuer `--from-portable` (PR #64).

### Correctness (Major-Correctness aus Code-Review 2026-05-21)

- **M25** `scheduler/runner` — Default-`setTimer` ruft `.unref()` (Process bleibt sonst infinite live) (PR #65).
- **M26** `scheduler/cron-parser` — DST-Caveat fuer `tz='local'` dokumentiert (PR #65).
- **M27** `vault-sync/scheduler` — `onWatcherError`-Hook surfaced chokidar-Errors (EMFILE/EACCES) statt silent-swallow (PR #65).
- **M28** `cli/mcp` — `--concurrency` mit `Number.isFinite`-Validation symmetrisch zu `--timeout` (PR #65).
- **M29** `migration/runner` — `'aborted'`-Status fuer Folge-Steps nach erstem failure (vorher silent `'skipped'`) (PR #65).
- **M30** `sidecar/rpc` — Notification-Handler-Errors werden vor `swallow` auf stderr geloggt (PR #65).
- **M31** `mcp-clients/live-probe` — `probedProtocolVersion` als local closure-var statt Entry-Mutation (PR #65).
- **M32** `mcp-clients/live-probe` — `stdoutPartialLine`-Buffer fuer JSON-RPC-Responses ueber Chunk-Grenzen (PR #65).

### Tests (Major-Tests aus Code-Review 2026-05-21)

- **M33** Sidecar-RPC tests: `agent.list`, `vault.status`, `catalog.installAutoDeps` (+11 cases) (PR #66).
- **M34** `auth/state-check` — `Number.isFinite`-Guard fuer `expiresAt`; NaN/Infinity → no-creds (PR #66).
- **M35** `vault-sync/conflict-policy` — 5 error-branch tests (fetch-fail / push-fail / branch-create-fail / reset-fail) (PR #66).
- **M36** `migration/runner` — Test fuer partial-failure → `'aborted'`-Status (PR #66).
- **M37** `scripts/smoke-cli.mjs` — CLI Smoke-Test fuer 6 Subcommands mit `--json`-Assertion; `npm run smoke` und in `npm run ci` (PR #66).

### Docs (Major-Docs aus Code-Review 2026-05-21)

- **M38** `README.md` — Broken ADR-0006-Link gefixt (`0006-tauri-node-sidecar-ipc.md`) (PR #67).
- **M39** `README.md` — Status-Drift gefixt: "v1.5.3" + 815/818 Tests (vorher "v1.0.0", 529/532) (PR #67).
- **M40** `cli/index` — Version aus `package.json` gelesen statt hardcoded `'0.1.0-alpha.1'` (PR #67).
- **M41** `docs/architecture/adr/README.md` — Index um ADR-0015 bis 0020 erweitert (PR #67).
- **M42** — Dieses CHANGELOG.md (PR #67).

### Deferred als Follow-ups

- **M3** mcp-Trust-Prompt — braucht GUI-Design-Sprint.
- **M5** secrets cross-process file-lock — braucht `proper-lockfile`-Dep oder Custom-OS-EXCL-Loop.
- **M8** RPC-Nonce — braucht koordinierten Tauri-Shell-Pull (`gui/src-tauri/`).
- **M14** sidecar config-file mtime-cache — touches 5 RPC-Handler.
- **M18** `cli/commands/catalog.ts:actAutoDeps` Refactor zu `installFromGithubWithAutoDeps`-Call.
- **M21** `sidecar/methods.ts` Split nach RPC-Namespace.

### Breaking Changes (User-Migration)

- **C1**: User mit `command: "cd foo && npm run x"` in `schedules.json` muessen jetzt explizit `cmd.exe /c "cd foo && npm run x"` schreiben — argv-tokenization akzeptiert keine Shell-Pipes.
- **C5**: Bei korruptem `vault-sync-state.json` wird der Lock nicht mehr silent auto-recovered — User muss `claude-os vault unlock` rufen.

## [1.5.3] — 2026-05-21

Pre-Code-Review-State. Siehe [`tasks/todo.md`](tasks/todo.md) §"Session 2026-05-20" fuer Detail-Tracker pro Phase.

- v1.5: Catalog-CLI-Pipeline (install + sync + lock + update), Scheduler-Foundation, Auto-Deps-Resolver.
- v1.6: MCP-Live-Spawn-Probe, MCP-Watcher.
- v1.7: MCP-Clients GUI Phase B (Live-Status-Panel + Reprobe-Button).
- v1.8: Dashboard Custom-Status-Cards.
- v1.5.3-Fix: Codex-Adversarial-Review-Fixes (4 echte Findings behoben, PR #58).

## [1.0.0] — 2026-05-17

Initialer Release-Tag nach Abschluss Phase 0-7.

[Unreleased]: https://github.com/yannikits/Claude-portable/compare/v1.5.3...HEAD
[1.5.3]: https://github.com/yannikits/Claude-portable/releases/tag/v1.5.3
[1.0.0]: https://github.com/yannikits/Claude-portable/releases/tag/v1.0.0
