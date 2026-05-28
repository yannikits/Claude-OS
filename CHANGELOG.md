# Changelog

Alle relevanten Aenderungen an `claude-os` werden hier dokumentiert. Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Versionierung folgt [SemVer](https://semver.org/).

## [Unreleased]

## [1.7.2] — 2026-05-28

### Fixed

- **Doctor blockt eigene Default-Config (PR #203):** Der `server-env`-Check verlangte `CLAUDE_OS_SECRETS_BACKEND === 'file'`, einen Backend-Wert der gar nicht existiert. Die `SecretBackend`-Union ist `'keyring' | 'encrypted-file'` und das Dockerfile setzt `encrypted-file` als Default → jeder Container der das offizielle Image ohne `CLAUDE_OS_SKIP_DOCTOR=1` startete fiel in eine Restart-Schleife. Fix akzeptiert jetzt `encrypted-file` und leeres/unset (Factory probet selbst), lehnt `keyring` mit klarer Headless-Begründung ab. `scripts/smoke-multi-user.sh` exportierte denselben kaputten `=file`-Wert — auch korrigiert.

### Added

- **`scripts/setup.sh` — interaktiver First-Time-Setup-Wizard.** Generiert `CLAUDE_OS_AUTH_TOKEN` + `CLAUDE_OS_SECRETS_PASSPHRASE` (je 32-byte hex), fragt nach Admin-Email + Session-Persistenz + Self-Registration. Schreibt `.env` mit `chmod 600` und zeigt am Ende die nächsten 3 Befehle (`docker compose pull/up`, `users create`). Idempotent: bestehende `.env` wird per `.env.bak` gesichert. Vereinfacht den TL;DR auf vier Befehle.

### Changed

- **`docker-compose.example.yml`:** `CLAUDE_OS_SESSION_PERSIST`, `CLAUDE_OS_ADMIN_EMAILS` und `CLAUDE_OS_SKIP_DOCTOR` aus den auskommentierten Beispielen in den aktiven `environment:`-Block gehoben — mit `${VAR:-default}`-Syntax, sodass sie ohne `.env`-Eintrag safe-default werden und mit Eintrag sofort greifen (kein zusätzliches `docker-compose.yml`-Edit pro Deployment mehr nötig). Image-Tag im Default jetzt `:v1.7.2`.
- **`tasks/v1.7.1-install-anleitung.md`:** Titel + Inhalt auf v1.7.2 aktualisiert, neue TL;DR-Section mit Wizard-Pfad oben.

## [1.7.1] — 2026-05-28

### Fixed

- **Docker-Image-Build (PR #200):** `gui/src/components/SkillDiffView.tsx` importierte `diff` aus dem **root** `package.json` (npm-hoisting macht das lokal transparent), aber die Dockerfile-`frontend-builder`-Stage läuft nur `npm ci` innerhalb `gui/`. Jeder `docker-image.yml`-Lauf seit #196 (Phase 5c GUI) ist deshalb beim `npx vite build` mit `Rolldown failed to resolve import "diff"` gescheitert — v1.7.0-Image war **nicht** auf GHCR verfügbar. Fix: `"diff": "^9.0.0"` in `gui/package.json` `dependencies` ergänzt + Lockfile-Update. Lokaler vite-Build verifiziert.

## [1.7.0] — 2026-05-28

### MSP-E — Note-to-Skill GUI (Phase 2 GUI)

GUI-Layer obendrauf auf das MSP-E Backend (PR #195/#196): von der Memory-Page wird jede Vault-Note in zwei Klicks zu einem Draft-Skill — direkte Brücke vom Memory-MVP in die Phase-5c Skill-Promotion-Pipeline (Quarantäne → Sandbox → Signatur).

**Frontend (PR #197):**
- `gui/src/lib/rpc.ts` — typed wrappers `proposeNoteAsSkill` + `createSkillDraftFromNote` mit `NoteToSkillError`-Envelope (`note-not-found` | `draft-exists` | `invalid-name`).
- `gui/src/components/note-to-skill-modal.tsx` — initial Proposal-Fetch + 250ms-debounce-Re-Propose + Customer-Confidential-Banner + alreadyExists-Guard.
- `gui/src/pages/memory.tsx` — per-Hit `→ Skill`-Button + Toast mit Link auf `/skill-review`.
- 7 RTL-Tests, biome + tsc clean.

### Phase Web-7-7 — Admin HTTP API + Smoke

Letzter Baustein der Web-7-Multi-User-Arbeit (PR #198): HTTP-Pendants zur `claude-os users` CLI, damit ein Linux/Web-Deployment ohne Shell-Access administriert werden kann.

**Endpoints** unter `/api/admin/users` (gegated via `CLAUDE_OS_ADMIN_EMAILS` env, comma-separated):
- `GET /api/admin/users` — full list (incl. disabled), safe shape (no passwordHash leak)
- `POST /api/admin/users` — create (201/409/400)
- `POST /api/admin/users/:idOrEmail/disable` — flip + revoke all target-sessions
- `POST /api/admin/users/:idOrEmail/enable`
- `POST /api/admin/users/:idOrEmail/reset-password` — sets new password + revokes all target-sessions

**No-Schema-Migration:** Admin-Set kommt aus env beim Boot statt aus `users.sqlite` (kein Touch an ADR-0036). Trade-off: Restart bei Admin-Set-Änderung — akzeptabel für typische Small-Team-Deployments. Audit-Events `admin.user.{create,disable,enable,reset-password}` mit hashed Admin-Email (no plaintext PII per SECURITY.md §4).

**Smoke (`scripts/smoke-multi-user.sh`):**
- Section 7 — Admin HTTP API E2E (list, create, duplicate-409, disable + login-denied)
- Section 8 — MSP-E Note-to-Skill RPC + Draft-Materialisation auf Disk
- Logout renumbered to Section 9. Vault-Bootstrap (workspaces/personal + vault-config.json) upfront prepared.

**Tests:** +16 routes-admin (vitest). Full backend suite: **1601 pass / 8 skip / 0 fail.**

### Phase 5c — Skill-Promotion-Pipeline (ADR-0026 Gate 3 Closeout)

End-to-end Self-Improvement-Loop ist deployment-ready. Lessons werden zu Draft-Skills (existing), Yannik promotet sie durch Quarantäne → optional sandbox-run → Ed25519-Signatur → aktiv. CLI + Sidecar-RPCs + GUI alle wired auf eine einzige `promote.ts` als Foundation.

**Domain:** `src/domains/skill-lifecycle/promote.ts` — sechs pure async state-transitions (`promoteDraftToQuarantined` / `runQuarantinedSandbox` / `proposeReview` / `approveReview` / `deprecate` / `disable` / `reactivate`) mit typed `PromoteError(code: 'not-found' | 'wrong-state' | 'signature-invalid' | 'signature-mismatch-diff-hash' | 'audit-write-failed' | 'fs-failed')`. `diffHash` = SHA-256 über canonical `{beforeContent, afterContent, classification}` — bound in die `ReviewApprovalPayload` sodass ein Tamper zwischen Sign und Activate `signature-mismatch-diff-hash` triggert.

**CLI:** `claude-os skill list-drafts` / `list-quarantined` / `list-pending-review` / `propose-review` / `promote <name> --to-quarantined|--run-sandbox|--to-active|--deprecate|--disable|--reactivate`. JSON-mode propagiert `PromoteError.code` direkt.

**Sidecar-RPCs:** 9 neue Methods unter `skill.*`. Mutating RPCs **nicht** über MCP-Tools exposed (approval gehört nicht über agentic Tool-Calls).

**GUI:** neue `SkillReviewPage` (`/skill-review`) — Pending-List + Side-by-Side-Diff via `diff@9` + Customer-Confidential-Warn-Banner (rot) + Sandbox-Run-Card. "Signieren + aktivieren …" CTA mit CLI-Hint-Modal (offline-sign + `--signed-envelope`-Pfad). Tauri-Native-Password-Approval (Phase 5c-5) folgt — niedrige Priorität seit Distribution-Pivot (Web/Linux ist Primary).

**Audit-Trail:** jede Transition schreibt JSONL nach `<dataDir>/audit/audit-YYYY-MM-DD.jsonl` (UTC-day-Rotation, mode `0o600`). Audit-FIRST auf Approve → Audit-Store-Failure → kein half-moved Skill.

**Sicherheits-Bindungen:**
- `diffHash` in SignedEnvelope (Tamper-Protection)
- skillId-Binding (Envelope.payload.skillId muss zum approveReview-Argument matchen)
- Optionaler `expectedPublicKeyB64`-Pin (Keypair-Swap-Defense)
- Snapshot-on-Overwrite via `<name>.prev-<ts>/` (Rollback-Pfad)

**Docs:** [`docs/skill-promotion-workflow.md`](docs/skill-promotion-workflow.md) — End-to-End-Walkthrough (de).

**ADR:** [`docs/architecture/adr/0026-skill-auto-promotion-lifecycle.md`](docs/architecture/adr/0026-skill-auto-promotion-lifecycle.md) — Status auf "shipped 2026-05-28" geflippt.

**Tests:** +42 vitest (18 promote.ts + 17 sidecar-RPCs + 6 GUI + 1 CLI-help-smoke). Backend full suite: **1560 pass / 8 skip / 0 fail**.

**Operator-Caveat:** sandbox-run benötigt `--script-path` zum Loadable-Modul. Standard-Skills ohne eigenes Script können Quarantäne ohne Run durchlaufen.

### Multi-User Stage 2 — Email + Passwort + Session-Cookies (Phase Web-7, ADR-0036)

Persistente Email/Passwort-Identitäten obendrauf auf Stage 1 (ADR-0033 Bearer-Token). Opt-in via `ServerConfig.multiUser` — wenn nicht gesetzt, verhält sich der Server exakt wie ADR-0033 Stage 1.

**Neue Domains:**
- `src/domains/users/` — sql.js-backed `UserRepository` mit schema-versioned migration (v1), atomic-save mit POSIX-mode `0o600`. scrypt-Hashing (`N=16384, r=8, p=1, dkLen=64`, OWASP-2023-Baseline) mit algorithm-tagged Format `scrypt$N=…$r=…$p=…$<salt-b64>$<hash-b64>` für künftige KDF-Migration. `MIN_PASSWORD_LEN=12`, `timingSafeEqual` über derived buffers, user-enumeration defense via lazy fake-hash.
- `src/domains/sessions/` — `SessionRepository` mit in-memory LRU (default 1000 entries), 30-Tage sliding-TTL, 256-bit CSPRNG session-ids (base64url, 43 chars). Injectable `now()` für Tests.

**Neue Server-Module:**
- `src/server/cookies.ts` — Set-Cookie builders mit HttpOnly + SameSite=Strict + conditional Secure, dev-bypass via `$CLAUDE_OS_INSECURE_COOKIES=1`.
- `src/server/csrf.ts` — double-submit token + timingSafeEqual.
- `src/server/rate-limit.ts` — per-IP token-bucket (login 5/15min, registration 3/h), max-tracked-IPs 10k mit oldest-eviction.
- `src/server/cookie-auth.ts` — cookie-first → bearer-fallback hook. CSRF enforced auf unsafe-methods im cookie-Pfad; Bearer-only Clients skippen CSRF.
- `src/server/routes-auth.ts` — `POST /api/auth/{login,logout,refresh,register,change-password}` + `GET /api/auth/me`.

**Neue tenant-Resolver:**
- `userToTenantId(user)` + `resolveTenantFromUser(user)` in `domains/tenant/resolve-token.ts`. Namespace-disjunkt zu `tokenToTenantId` (user-prefix vs hex-prefix → keine Kollision).

**Doctor:**
- `checkUserStore` — öffnet `users.sqlite` mit `autoRebuildOnSchemaDrift=false` (schema-mismatch fail-loud statt silent-drop). Drei Outcomes: not-in-server-mode-skip, no-file-ok, openable-ok-mit-count, corrupt-fail.

**Admin-CLI** (Phase Web-7-5):
- `claude-os users create --email <e> --password <p> [--tenant-override <id>]`
- `claude-os users list [--include-disabled] [--json]`
- `claude-os users disable <id-or-email>` / `enable …`
- `claude-os users reset-password <id-or-email> [--password <p> | --random]`
- `claude-os users sessions list [--user <id-or-email>]` / `sessions revoke <id>`

**Frontend (gui/src/):**
- `lib/auth-api.ts` — standalone fetch wrappers für login/register/logout/me/changePassword. CSRF-Header aus Cookie. `isCookieAuthed()`-Flag in sessionStorage (session cookie ist HttpOnly → JS kann es nicht direkt prüfen).
- `pages/login.tsx` — refactored mit Tabs (Email default, API-Token legacy). `onSwitchToRegister` + `successBanner` props.
- `pages/register.tsx` — NEU. Email+Passwort+Confirm, client-side Validation, server-codes auf Deutsch.
- `components/profile-drawer.tsx` — NEU. Sidebar-Widget mit email + tenant + logout + change-password.
- `components/change-password-modal.tsx` — NEU. Pattern aus secret-add-modal, 3 Password-Felder mit clear-on-submit.
- `App.tsx` — `useAuthGate` widened von binary auf `AuthMode = 'tauri'|'cookie'|'token'|'none'`. Mount-Time `/api/auth/me` Probe upgraded `'none' → 'cookie'` bei vorhandener Session-Cookie.

**Audit-Events (neu in `AuditEventKind`):** `auth.login.success`, `auth.login.failed`, `auth.logout`, `auth.register`, `auth.password.change`. Pflicht-Hashing von email+IP (sha256-prefix, 16 hex chars).

**Deps:** `@fastify/cookie@11.0.2`.

**Tests:** +144 (Backend 111: UserRepo 46, Sessions 21, CSRF 6, Rate-Limit 8, Routes-Auth 33, Tenant 6, Doctor 5 + audit-kind extension; Frontend 33: auth-api 11, login-page 6, register-page 5 + die Web-7-5-CLI ist real-smoke-verifiziert). Full backend suite: **1512 passed / 8 skipped / 0 failed**.

**ADR:** [`docs/architecture/adr/0036-multi-user-stage-2-email-password.md`](docs/architecture/adr/0036-multi-user-stage-2-email-password.md)

**Operator-Caveat:** sql.js ist single-writer. Admin-CLI muss laufen während der Server gestoppt ist. Documented in `docs/server-deployment.md` §"Multi-User mit Email-Login (Stage 2)".

## [1.6.0] — 2026-05-21

Comprehensive Code-Review-Pass: 60+ Items adressiert quer ueber 9 Blocks (Critical/Codex-R2/M-Security/M-Architektur/M-Performance/M-Correctness/M-Tests/M-Docs/Cleanup) + alle 6 deferred-followups. Sidecar-process-arch komplett gehaertet (RCE/symlink/path-traversal/TOCTOU/argv-injection-defenses), full security-test-suite, Tauri-Rust nonce-handshake fuer RPC-MITM-defense-in-depth.

Tests: 845/848 grun (+200 vs v1.5.3). CI: ubuntu+macOS+Windows+Rust-cargo-check alle gruen.

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

### Performance (Folge-Iteration nach Cleanup-Sprint)

- **M14** `sidecar/mtime-cache.ts` — neue `mtimeCached(path, loader, cache)`-Helper mit per-file `{mtimeMs, size}`-key + tombstone-Support. Wired in `catalog.list`, `vault.status` (config-Pfad, BusyFlag bleibt uncached), `schedule.list`. Spart ~5-20ms blocking-I/O pro Dashboard-Poll-RPC. 8 neue Tests (cache-hit/miss, mtime-change, size-change, missing-tombstone, transitions, multi-path-isolation). 823/826 vitest gruen (PR #76).

### Architektur (Folge-Iteration nach Cleanup-Sprint)

- **M21** `sidecar/methods.ts` Namespace-Split — 549 LOC → 84 LOC orchestrator + 9 per-Namespace-Module unter `methods/` (catalog/vault/inbox/settings/secrets/chat/schedule/mcp/agent). Plus `methods/_shared.ts` mit `MethodsContext` + `requireString`/`Boolean`-Helpers (ersetzt 14× kopiertes Validierungspattern) + `canonicalizeRoots`/`isUnder` (C2 helpers). Public API unveraendert. 823/826 vitest + 6/6 smoke gruen (PR #78).
- **M18** `cli/commands/catalog.ts:actAutoDeps` ruft `installFromGithubWithAutoDeps` — Domain-Funktion um `dryRun?: boolean`-Opt erweitert (`--json` mapped darauf). CLI shrunk von ~193 auf ~80 LOC; Codex-Adversarial-Review-Findings #2 (transactional persistence) und #3 (existing-manifests hydration) gelten jetzt fuer CLI- UND RPC-Caller. Exit-Codes 4/5/6/7/9 via `exitCodeForAutoDepsError`-Mapping back-compat preserved. Net -60 LOC (PR #80).

### Sicherheit (Folge-Iteration nach Cleanup-Sprint)

- **M5** `secrets/encrypted-file-store` cross-process file-lock via `proper-lockfile@2.x` — `set()`/`delete()` gehen jetzt durch `withFileLock(operation)` (realpath:false, 10 retries 25-250ms exponential, 30s stale-timeout). Verhindert silent-overwrite-race wenn CLI und Sidecar parallel `secrets.enc` mutieren. 2 neue concurrency tests verifizieren 10× parallel set + 5×set/5×delete-Mix produce konsistenten Endstand. 825/828 vitest gruen (PR #82).
- **M3** `mcp-clients` trust-gating — neuer `McpTrustStore` mit on-disk-acknowledged-list (`<dataDir>/mcp-trust.json`). `probeServer({isTrusted, serverKey})` checked VOR spawn — un-acknowledged servers liefern `kind: 'trust-required'` ohne arbitrary-binary-execution. 3 neue RPCs: `mcp.trust.list/acknowledge/revoke`. Sidecar-Entry-Point wired den trust-store in den watcher. GUI-Integration additiv (rendert trust-required + ruft trust-RPCs). 839/842 vitest gruen + 13 neue tests (PR #84).
- **M8** per-spawn RPC-Nonce-Handshake — Sidecar generiert `randomBytes(16).hex` beim Startup, emittiert `{"type":"sidecar-ready","nonce":"...","pid":N}\n` auf stderr BEFORE Dispatcher-enforcement. `RpcDispatcher.setExpectedNonce()` aktiviert -32001-Reject fuer falsche/fehlende Nonce. Tauri-Supervisor parsed Handshake aus stderr (nested if-let, edition=2021) + attached Nonce an jeden Wire-RPC. `$CLAUDE_OS_RPC_NONCE=disabled` opt-out fuer dev/tests. `invoke()` (in-process) bleibt nonce-frei. Defense-in-depth gegen pipe-MITM + zukuenftigen HTTP-Transport. 845/848 vitest gruen + 6 neue tests; Rust-Compile-Verifikation in CI (cargo lokal nicht verfuegbar) (PR #85).

### Deferred als Follow-ups

_Alle deferred-items aus dem Code-Review 2026-05-21 sind geshipped._

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

[Unreleased]: https://github.com/yannikits/Claude-portable/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/yannikits/Claude-portable/releases/tag/v1.6.0
[1.5.3]: https://github.com/yannikits/Claude-portable/releases/tag/v1.5.3
[1.0.0]: https://github.com/yannikits/Claude-portable/releases/tag/v1.0.0
