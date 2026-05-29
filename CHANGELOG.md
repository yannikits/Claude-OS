# Changelog

Alle relevanten Aenderungen an `claude-os` werden hier dokumentiert. Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Versionierung folgt [SemVer](https://semver.org/).

## [Unreleased]

## [1.9.3] — 2026-05-30

### Added

- **MSP-Health Dashboard-Polish (Phase 7-E.1, ADR-0044):** Drei user-sichtbare Verbesserungen am Dashboard. Frontend-only — keine Backend-Änderungen, kein Schema-Change.
  - **Auto-Refresh-Polling:** Header-Segment-Control `off|1m|5m|15m` (default `off`). Wenn aktiv: silent reload via cache-aware `mspHealthRows()` (kein force-bust). Implementation als wiederverwendbare React-Hook `useAutoRefresh()` mit closure-stale-fix via `loaderRef` und sauberer cleanup-on-unmount/intervalSec-change.
  - **Pagination:** Footer-Bar mit page-size-segment `25|50|100` (default 50) + prev/next + page-info „page N / M (X total)". Client-side slice — kein zusätzlicher Backend-Roundtrip pro Seitenwechsel.
  - **Audit-Drill-Down:** Neue `AUDIT`-Spalte rechts. Pro Zeile `<a href="/audit?tenant=<slug>&kinds=bridge.read">audit</a>`. onClick stoppt Propagation damit Row-Expand nicht mit-getriggert wird. Öffnet das Audit-Trail-Dashboard (ADR-0037) mit vorbefüllten Filtern → 1-Click-Antwort auf „warum ist diese Zelle rot, wann ging's kaputt".

### Fixed

- **Securepoint-Spalte im MSP-Health Dashboard restored.** Beim v1.9.2-Frontend-Edit ging die `SecurepointCell`-Komponente sowie die Securepoint-Spalte im RowGroup-Rendering verloren (CHANGELOG-Eintrag für 1.9.2 ist auch nie ins Repo gekommen — Release-Notes auf GitHub sind die Wahrheit dazu). Beides wieder eingefügt — die SECUREP.-Spalte rendert jetzt korrekt im Dashboard.

### Tests

- **7 neue Tests** für `useAutoRefresh` (null-no-op, fire-at-interval, latest-loader-via-ref, reset-on-interval-change, cleanup-on-unmount/null-switch, double-fire prevention)
- Backend-Suite unverändert: **1984 passed / 8 skipped** — keine Regression

### Docs

- **ADR-0044** — MSP-Health Dashboard-Polish (Auto-Refresh, Pagination, Drill-Down)

## [1.9.2] — 2026-05-30

> CHANGELOG-Eintrag wurde beim Release versehentlich nicht ins Repo committed. Volle Release-Notes auf GitHub: https://github.com/yannikits/Claude-OS/releases/tag/v1.9.2

### Added

- **Securepoint USC Read-Bridge (Phase 7-D.2, ADR-0043):** Vierte konkrete Read-Bridge. Single Cloud-API + shared Metrics-Cache, eigener Prometheus-Text-Parser, forgiving device-label-matching.

  Architektur-Variant gegen TANSS/Veeam/Sophos: EINE Cloud-API liefert in einem Request alle UTMs aller Mandanten. Bridge cached die parsed Map mit 60s TTL → 100 Customer auf einem Dashboard-Refresh = EIN upstream HTTP-Call.

  - **Endpoint:** `GET portal.securepoint.cloud/sms-mgt-api/api/2.0/metrics?version=2.2` mit Bearer-API-Key
  - **`SecurepointStatus`:** `online`, `licenseDaysRemaining`, `licenseStatus` (valid/expiring-soon/expired/unknown, ≤30d = expiring-soon), `additionalMetrics` (clip 20)
  - **Eigener Prom-Parser** (~80 LOC): labeled/unlabeled, escaped strings, Floats+Sci, Comments, NaN-reject, malformed-skip
  - **Forgiving label-matching:** akzeptiert utm/device/name/serial als device-key. `isDeviceMissing()` → misconfigured mit Typo-Hint
  - **Stampede-Protection** für shared cache: 10 concurrente Probes → 1 upstream fetch
  - **CLI:** `claude-os msp probe securepoint <slug>` mit --base-url/--api-version/--timeout-ms
  - **Doctor:** `securepoint-config`-Check (single MSP-wide apiKey)
  - **Bootstrap:** registriert iff irgendein Customer `bridges.securepoint` hat
  - **Dashboard:** SECUREP.-Spalte mit `ONLINE|OFFLINE · license <status>`

### Tests

- 62 neue Tests (14 prom-parser + 12 mapper + 11 classify-error + 11 cache + 14 bridge + 5 doctor)
- runner.test.ts updated (12 → 13; 10 → 11)
- Gesamt-Suite: **1984 passed / 8 skipped** — keine Regression

## [1.9.1] — 2026-05-30

### Added

- **Sophos XG/XGS Read-Bridge (Phase 7-D, ADR-0042):** Dritte konkrete Read-Bridge. Per-customer on-prem Firewall, XML-API auf Port 4444.
  - **Endpoint:** `POST {host}:{port}/webconsole/APIController` mit `Content-Type: application/x-www-form-urlencoded` Body `reqxml=<XML>`. Eine Probe = ein HTTP-Call mit ZWEI eingebetteten `<Get>`-Blöcken (Firmware + LicenseInformation).
  - **Auth:** XML-eingebettete Credentials in jedem Request (`<Login><Username/><Password/></Login>`). Kein Token, keine Session. Per-Call frisch aus `sophos/<host>/{username,password}` im Secrets-Backend (ADR-0038-Hard-Rule).
  - **`SophosStatus`:** `firmwareVersion` + `firmwareType` + `licenseSummary` (`active`/`expiring-soon`/`expired`/`mixed`/`unknown`) + `daysToEarliestExpiry` + `subscriptions[]` (jeweils name/status/expiresAt/daysRemaining). `licenseSummary`-Heuristik: alle aktiv mit MIN(days)≤30 → `expiring-soon`; alle abgelaufen → `expired`; gemischt → `mixed`. „Subscribed" mit negativem daysRemaining wird als expired gewertet (Sophos sync-lag).
  - **Sophos `<Status code>`-Handling:** 534 (IP nicht in API ACL) → `auth-failed` mit klarer Message; 532 (API nicht aktiviert) → `misconfigured` mit Enable-Hint. Ohne Status: `<Login>` „Authentication Failure" → `auth-failed`.
  - **TLS:** `CLAUDE_OS_SOPHOS_INSECURE_TLS=1` (oder `--insecure-tls`) für XG/XGS-Default-Self-Signed-Cert. Sonst hartes `unreachable` mit `INSECURE_TLS`-Hint.
  - **XML-Parsing:** Neue Dep `fast-xml-parser` (~10M weekly downloads, MIT, 0 transitive deps). Gated in `sophos/xml-parser.ts` — der Rest des Codebases bleibt XML-agnostisch.

- **Schema-Update für `bridges.sophos` (BREAKING gegen v1.9.0):**
  - `firewallHostname: string` jetzt **Pflicht** (war optional)
  - `firewallPort?: number` neu, default 4444
  - `centralCustomerId?: string` bleibt reserved-for-future (Sophos Central-Bridge)
  
  Niemand produktiv → keine Migration nötig (analog zu Veeam v1.8.3).

- **CLI: `claude-os msp probe sophos <slug>`** — Smoke-Test. Liest customer.yaml, holt Creds aus Secrets-Backend, probt, pretty-print + `--json`. Optionen: `--insecure-tls`, `--timeout-ms`.

- **Doctor-Check: `sophos-config`** — analog `veeam-config`: enumeriert Customer-Workspaces, sammelt distinct `firewallHostname`-Werte, prüft pro Host ob `sophos/<host>/{username,password}` im Secrets-Backend liegen. **ok** bei kein-Sophos ODER alle-Hosts-Creds-da. **warn** bei N von M Hosts ohne Creds — listet welche. Never fail.

- **Bootstrap-Wiring in `serve.ts`:** SophosBridge wird registriert iff irgendein Customer `bridges.sophos` hat. Wrapped via `withAuditTrail` — alle Probes landen im Audit-Log.

- **MSP-Health Dashboard:** Neue SOPHOS-Spalte mit Per-Cell-Rendering `firmware · license-summary [· N days]`. Color-coded: `active` grün, `expiring-soon`/`mixed` gelb, `expired`/`unknown` rot.

### Privacy

Audit-Wrapper schreibt nur `customerSlug` / `bridgeKind` / `resultKind` / `durationMs`. Keine Subscription-Namen, keine Firmware-Versionen, keine Credentials. Test prüft das explizit.

### Docs

- **ADR-0042** — XML-API-Wahl, Sophos `<Status>`-Code-Mapping, License-Heuristik, TLS-Trade-off
- **`docs/sophos-bridge-guide.md`** — User-Setup, API-Access-List-Hint, Troubleshooting-Tabelle mit 12 Symptomen

### Tests

- **74 neue Tests** (4 xml-builder + 11 xml-parser + 18 mapper + 13 classify-error + 16 bridge + 8 doctor-check + 4 schema)
- runner.test.ts updated (11 → 12 checks; 9 → 10 when root unresolvable)
- Gesamt-Suite: **1922 passed / 8 skipped** — keine Regression

## [1.9.0] — 2026-05-29

### Added

- **MSP-Health Aggregat-Dashboard (Phase 7-E, ADR-0041):** Web-UI über alle konfigurierten Read-Bridges × alle Customer-Workspaces. **Eine** Tabelle, eine Zeile pro Customer, eine Spalte pro Bridge — admin-gated wie das Audit-Trail-Dashboard.
  - **Backend-Domain `src/domains/msp-aggregate/`:** `runProbes` orchestriert Probes mit parallel-across-bridges + serial-per-bridge Topologie (Token-Cache amortisiert), Per-Probe-Timeout (capped 10s), Whole-Aggregate-Hard-Cap (30s default), unfinished cells → `{kind:'timeout'}`.
  - **`AggregateCache`:** Single-slot TTL (60s default, `CLAUDE_OS_MSP_HEALTH_TTL_SEC`-override) + Stampede-Protection (10 Admins gleichzeitig → 1 Probe-Run, alle warten auf dasselbe Promise) + loader-throw clear für sauberen retry.
  - **HTTP-Routes (`src/server/routes-msp-health.ts`):** Drei admin-gated Endpoints:
    - `GET /api/msp-health/rows` (cache-hit-friendly)
    - `GET /api/msp-health/config` (peek, no probe trigger)
    - `POST /api/msp-health/refresh` (cache bust + fresh probe)
  - **Frontend (`gui/src/pages/msp-health.tsx`):** Operator-Console-styled — Header mit customer-count + bridges + cache-age + Refresh, Table mit color-coded cells (tone-ok/warn/error), Click-Row → expand inline JSON-detail-blocks. Per-Bridge-Cell-Rendering: TANSS „N open / M total · last <date>", Veeam „X ok · Y warn · Z failed · W running [· N missing]" (missingJobs flag = Job-Rename-Detection im Dashboard sichtbar).
  - **Nav-Entry:** „MSP Health" in OVERVIEW-Section, `adminOnly: true`. Route nur registered wenn `isAdmin === true`. Selbes Pattern wie Audit-Page.
  - **Bootstrap-Wiring in `serve.ts`:** Aktiv wenn multi-user mode + adminEmails gesetzt. Bridges env-/vault-driven registriert: TANSS iff `CLAUDE_OS_TANSS_SERVER_URL` gesetzt, Veeam iff irgendein Customer `bridges.veeam` hat. Beide werden mit `withAuditTrail` gewrappt — alle Probes landen im Audit-Log.

- **`ServerConfig.mspHealth`** opt-in Field (Phase 7-E). Wenn gesetzt UND `adminEmails` non-empty → `/api/msp-health/*` Routes registered.

### Foundation pays off

`src/domains/msp-aggregate/` hat **null** vendor-spezifischen Code. Phase 7-D (Sophos+Securepoint) wird nur eine Schema-Erweiterung in `msp-customers` + neue Bridges + neue Frontend-Cell-Components brauchen. Aggregator-Backend bleibt unverändert.

### Privacy by Design

Audit-Wrapper (aus Phase 7-A) garantiert pro `bridge.read`-Event nur `customerSlug` / `bridgeKind` / `resultKind` / `durationMs`. Keine API-Bodies, keine Sample-Tickets, keine Job-Namen, keine Credentials im Audit — auch vom Aggregat aus geprobed.

### Docs

- **ADR-0041** — MSP-Health Aggregat-Dashboard (Topologie, Cache, Stampede-Protection, Trade-offs)
- **`docs/msp-health-dashboard-guide.md`** — User-Setup, Cell-Bedeutung, Drill-Down, Performance, Troubleshooting-Tabelle

### Tests

- **36 neue Tests** (24 backend-aggregator + 12 HTTP-routes inkl. Stampede-Test mit 10 concurrent requests)
- Gesamt-Suite: **1846 passed / 8 skipped** — keine Regression

## [1.8.3] — 2026-05-29

### Added

- **Veeam Read-Bridge (Phase 7-C, ADR-0040):** Zweite konkrete Read-Bridge — per-customer VBR (Yannik-Entscheidung), nicht zentraler Server.
  - **Endpoint:** `GET {baseUrl}/api/v1/sessions?typeFilter=Backup&limit=200` mit Bearer-Auth + `x-api-version: 1.1-rev1` (override via `CLAUDE_OS_VEEAM_API_VERSION`).
  - **Auth:** OAuth2 Password-Grant (`POST /api/oauth2/token`). Credentials kommen pro Probe frisch aus dem Secrets-Backend (Schlüssel `veeam/<host>/username` + `veeam/<host>/password`). Token wird in-memory pro Host mit 60s Margin gecached → mehrere Customer-Probes auf demselben VBR teilen sich einen Login.
  - **401-Retry:** Read 401 invalidiert den Cache-Eintrag für den Host und macht EINEN Re-Login-Retry. Zweite 401 → `auth-failed`.
  - **VeeamStatus:** `knownJobs` / `okCount` / `warningCount` / `failedCount` / `runningCount` + `newestSuccessAt` / `oldestUnsuccessfulAt` (Alarm-Age) + `latestRuns` (max 20, newest-first). Plus **`missingJobs`** — die wichtigste Innovation: erkennt Job-Renames im Veeam-UI (jobs aus `customer.yaml` die nicht mehr im VBR-Response sind), die sonst silent als „alles fein" durchgehen würden.
  - **State-Bucketing** robust gegen Veeam-Version-Drift: `result` ODER `state`, beides case-insensitive, `result` kann String ODER `{result:"..."}` sein, `jobName` fällt auf `name` zurück.
  - **TLS-Default:** Veeam liefert per Default self-signed Cert. Bridge respektiert `CLAUDE_OS_VEEAM_INSECURE_TLS=1` (oder `--insecure-tls`) für diesen Fall; sonst hartes `unreachable` mit explizitem Hint.
  - **Error-Mapping:** zusätzlich zum Standard-Pattern: HTTP 400 mit „api-version not supported" Body → `misconfigured` mit Hint auf `CLAUDE_OS_VEEAM_API_VERSION`. TLS-Fehler (`UNABLE_TO_VERIFY_LEAF_SIGNATURE` etc.) → `unreachable` mit `INSECURE_TLS`-Hint.

- **Schema-Update für `bridges.veeam` (BREAKING gegenüber v1.8.1):**
  - `serverHostname` ist jetzt **Pflicht** (war optional)
  - `serverPort` neu, optional, default 9419
  - `jobNames` jetzt **optional** — leer/weggelassen = alle Jobs auf dem VBR
  
  Niemand produktiv, kein Migrationspfad nötig. Wer eine alte `customer.yaml` ohne `serverHostname` hat: bekommt eine klare Schema-Fehlermeldung mit Pointer auf ADR-0040.

- **CLI: `claude-os msp probe veeam <slug>`** — Smoke-Test gegen die Veeam-Bridge. Liest `bridges.veeam.*` aus `customer.yaml`, holt Creds aus Secrets-Backend, probt, pretty-print + `--json`. Optionen: `--api-version`, `--insecure-tls`, `--timeout-ms`.

- **Doctor-Check: `veeam-config`** — enumeriert Customer-Workspaces, sammelt distinct `serverHostname`-Werte, prüft pro Host ob beide Creds im Secrets-Backend liegen. **ok** bei keinem Veeam-Customer ODER alle Hosts haben Creds. **warn** bei N von M Hosts ohne Creds — listet welche im `detail`-Feld. Never fail.

### Docs

- **ADR-0040** — Veeam Read-Bridge (per-customer VBR, OAuth2 Auth, Status-Shape, State-Bucketing, Schema-Breaking)
- **`docs/veeam-bridge-guide.md`** — User-Setup in drei Schritten, Verification per Doctor + Smoke-Test, ausführliche Troubleshooting-Tabelle, Audit-Trail-Beispiel, Erklärung warum per-customer VBR

### Tests

- 67 neue Tests (23 mapper + 16 classify-error + 6 token-cache + 6 oauthLogin + 12 bridge + 6 audit-integration + 8 doctor-check) — alle grün
- runner.test.ts aktualisiert (10 → 11, 8 → 9). Schema-Tests aktualisiert für neues Veeam-Schema (4 neue Cases)
- Gesamt-Suite: **1810 passed / 8 skipped** — keine Regression

## [1.8.2] — 2026-05-29

### Added

- **TANSS Read-Bridge (Phase 7-B, ADR-0039):** Erste konkrete Read-Bridge, baut auf der Phase-7-A-Foundation (ADR-0038) auf.
  - **Per-Customer-Probe:** Ein `probe(customer)` macht **einen** Call: `GET {CLAUDE_OS_TANSS_SERVER_URL}/api/v1/tickets/company/{customer.bridges.tanss.customerId}`. Header `apiToken: <key>` (case-sensitive — PSTANSS-validiert, **nicht** `Authorization: Bearer`).
  - **`TanssStatus` (kompakt):** `openCount` + `totalCount` + `newestUpdateAt` + `sample` (id/subject/status des neuesten Tickets). `sample.subject` bleibt im Probe-Return-Value und geht **nicht** ins Audit (per SECURITY.md §4).
  - **Defensive Mapper:** Closed-Detection akzeptiert `closed === true` ODER `/closed|done|erledigt|geschlossen|completed|finished/i` in `status`/`statusName`. updateDate akzeptiert ISO-Strings + Epoch-Sekunden (< 1e12) + Epoch-Millis. Response-Unwrap funktioniert sowohl mit `{content:[...]}` als auch mit bare-Array.
  - **Hard-Contract per ADR-0038:** `probe()` wirft nie. `customer.bridges?.tanss` ist die Konfig-Probe (fehlt → `misconfigured`, kein HTTP-Call). `getApiToken()` wird pro Call frisch aus dem Secrets-Backend geholt (Token-Rotation klappt). `durationMs` wird real reportet.
  - **Error-Mapping vollständig:** 401/403 → `auth-failed`, 429 (+ Retry-After) → `rate-limited`, 404 → `misconfigured` (customerId falsch), 5xx → `unreachable`, AbortError/TypeError/ECONN* → `unreachable`, alles andere → `error`.

- **CLI: `claude-os msp probe tanss <slug>`** — User-facing Smoke-Test. Liest `CLAUDE_OS_TANSS_SERVER_URL` + apiToken aus dem Secrets-Backend, lädt den Customer aus dem Vault, probt und printet das Resultat. `--json` mirrors `BridgeProbe`. Exit 0 nur bei `result.kind === 'ok'`.

- **Doctor-Check: `tanss-config`** — `ok` wenn beide (URL + apiToken) gesetzt oder beide unset (TANSS optional); `warn` wenn nur eins von beiden — mit Hint auf den fehlenden Schritt. Läuft auch aus `docker/entrypoint.sh`-Pre-Flight.

### Docs

- **ADR-0039** — TANSS Read-Bridge (Endpoint-Wahl, Auth-Header, Status-Shape, Error-Mapping, Trade-offs)
- **`docs/tanss-bridge-guide.md`** — User-Setup in drei Schritten (env + `secrets set` + `customer.yaml`), Verification per Doctor + Smoke-Test, Troubleshooting-Tabelle, Audit-Trail-Beispiel.

### Tests

- 30 neue Unit-Tests (16 mapper + 13 classify-error + 14 bridge inkl. Audit-Integration) + 7 neue Doctor-Check-Tests. Gesamt-Suite: **1740 passed / 8 skipped** — keine Regression.

## [1.8.1] — 2026-05-29

### Added

- **MSP-Health-Foundation (Phase 7-A, ADR-0038):** Zwei neue Domains als Grundlage für die per-MSP-System Read-Bridges (TANSS, Veeam, Sophos, Securepoint, M365 in Phase 7-B/C/D).
  - **Customer-Repository (`src/domains/msp-customers/`):** Read-Through-Repo über `customer.yaml`-Files unter `<vaultRoot>/workspaces/msp-customers/<slug>/`. Strenges Schema (Slug-Regex `[a-z0-9][a-z0-9-]*`, max 64), Forward-Compat-Slot (`extras` für unbekannte Top-Level-Keys), frühe Tippfehler-Ablehnung bei unbekannten Bridge-Kinds. `findByBridgeId()` für Webhook-Reverse-Lookup. mtime-Cache pro Datei. 16 Unit-Tests grün.
  - **Bridge-Interface (`src/domains/msp-bridges/`):** Typed `ReadBridge<TStatus>`-Contract mit Hard-Regeln (nie werfen, `customer.bridges?.<kind>` ist Konfig-Probe, Tokens pro Call frisch holen, `durationMs` reporten). `BridgeRegistry` (`Map<kind, instance>`, Doppel-Register wirft). `withAuditTrail()`-Decorator schreibt pro `probe()` ein `bridge.read`-Event ins Audit-Log mit `outcome`-Mapping (`ok → ok`, `auth-failed → denied`, alles andere → `error`). `NullBridge` als Referenz-Implementation und Test-Double. 15 Unit-Tests grün.
  - **Privacy by Design:** Audit-Wrapper schreibt nur `customerSlug` + `bridgeKind` + `resultKind` + `durationMs` — keine Customer-PII, keine API-Bodies (per SECURITY.md §4). Tokens leben weiter im Secrets-Backend (Keyring/env), niemals in `customer.yaml`.
  - **Docs:** ADR-0038, `docs/customer-yaml-guide.md` (User-Schema), `src/domains/msp-bridges/README.md` (Implementierer-Leitfaden für Phase 7-B/C/D).

### Why this is foundation, not feature

Phase 7-A liefert keine neue UI und keinen User-Flow — sie liefert die zwei Verträge, die alle 7-B/C/D-Bridges nutzen werden. Konkrete Bridges (TANSS-Phase 7-B, Veeam 7-C, Sophos+Securepoint 7-D) sind danach nur noch Klasse `XBridge implements ReadBridge<XStatus>` + ein `registry.register(withAuditTrail(new XBridge(deps), audit))` im Bootstrap. Kein neuer Audit-Code, kein neues Schema, austauschbar/mockbar.

## [1.8.0] — 2026-05-29

### Added

- **Audit-Trail-Dashboard (Phase Audit-Trail-Dashboard, ADR-0037):** Read-only Web-UI über die existierenden audit-JSONL-Files. Admin-gated via `CLAUDE_OS_ADMIN_EMAILS`-Allowlist (selbes Pattern wie Web-7-7).
  - **Backend (Phase A):** Neue Domain `src/domains/audit-query/` mit `queryAudit()`/`auditStats()`/`exportAudit()`. Robust gegen partial-write tail-lines (concurrent-read-safe). Time-Range Filter über UTC-Day-Files mit `enumerateDays()`. CSV-Export RFC-4180-konform mit 50k Hard-Cap. 26 Unit-Tests grün.
  - **HTTP-Endpoints (Phase A.3):** `GET /api/audit/{list,stats,export}` mit inline `requireAdmin`-Gate. GET statt POST damit Filter-State im URL teilbar (DSGVO-Workflow). 8 Integration-Tests grün.
  - **Admin-Detection:** `/api/auth/me` returnt jetzt `user.isAdmin: boolean`. `AuthRoutesDeps` um `adminEmails`-Feld erweitert (mirror von `MultiUserConfig.adminEmails`).
  - **Frontend (Phase B):** `gui/src/pages/audit.tsx` Single-Page-Component mit Stats-Strip (Counts pro Kind), Filter-Bar (Range/Workspace/Tenant/Outcome/Action-substring), Expandable Kinds-Picker (17 Event-Kinds), Data-Table mit Outcome-Tints + Per-Row JSON-Expand, Pagination mit page-size-Selector, CSV/JSONL-Export via Blob-Download.
  - **Nav-Integration:** `NavEntry` erweitert um `adminOnly?: boolean`. Audit-Nav-Entry in SYSTEM-Section. Layout filtert NAV nach `isAdmin`-Prop. Route `/audit` wird conditional registriert.
  - **Styles:** ~150 LOC Operator-Console-Treatment für audit-spezifische Klassen (stats-strip, filter-bar, kinds-picker, outcome-tints, pagination).
  - **Docs:** ADR-0037 + `docs/audit-trail-guide.md` (DE).

### Subtle bug caught during implementation

ISO-8601 String-Lexicographic-Compare: `'2026-05-29T00:00:00.000Z' < '2026-05-29T00:00:00Z'` ist TRUE als String, aber gleicher Zeitpunkt. Fix in `query.ts` + `stats.ts`: alle Time-Vergleiche durch `Date.parse()` → numerische Millis statt String-Compare. Wurde durch ein "expected 10 to be 9" Pagination-Test gefangen.

## [1.7.8] — 2026-05-29

### Fixed

- **`/root/.claude.json` (Main-Config) wird beim Boot vom Backup restored.** Die `claude`-CLI nutzt zwei separate Files: `/root/.claude/.credentials.json` (in v1.7.7 via Volume-Mount gefixt) **und** `/root/.claude.json` (Main-Config: MCP-Clients, Project-History, Settings). Letzteres ist im RootFS und ging deshalb bei jedem Container-Restart verloren — User sah `Claude configuration file not found at: /root/.claude.json` + musste sich neu anmelden. Fix in `docker/entrypoint.sh`: bei Boot wird `/root/.claude.json` aus dem neuesten Backup in `/root/.claude/backups/` restored (claude-CLI macht diese Backups automatisch beim Write, und das Backups-Verzeichnis lebt im persistenten Volume).

## [1.7.7] — 2026-05-29

### Fixed

- **Credentials-Persistence richtig diesmal — `/root/.claude` als Volume.** v1.7.6's Symlink-Pattern (`/root/.claude/.credentials.json` → `${ANTHROPIC_CONFIG_DIR}/`) wurde von der `claude`-CLI bei jedem Login zerstört: die CLI nutzt atomic-rename (unlink+write) und überschreibt damit den Symlink mit einer echten Datei. Resultat: Login funktionierte, Credentials landeten aber wieder in `/root/.claude/.credentials.json` (RootFS, nicht persistent), Settings-Page blieb leer.

  **Korrekter Pfad in v1.7.7:** `/root/.claude/` wird als eigenes Docker-Volume gemountet (`claude-os-claude`). Die `.credentials.json` lebt damit **als echte Datei** im Volume. Der Convenience-Symlink geht umgekehrt — `${ANTHROPIC_CONFIG_DIR}/.credentials.json` → `/root/.claude/.credentials.json`. Settings-Page liest nur (kein unlink-Problem), claude-CLI schreibt direkt ins Volume.

  `docker/entrypoint.sh` enthält:
  - Forward-Migration von v1.7.5-Layout: wenn `${ANTHROPIC_CONFIG_DIR}/.credentials.json` als echte Datei existiert (alte Position), wird sie beim Boot nach `/root/.claude/` verschoben
  - Idempotenter Read-only-Symlink
  - WARNING wenn `/root/.claude` kein mountpoint ist (User hat alte compose.yml)

  **Operator-Aktion erforderlich:** `docker-compose.yml` um den neuen Volume-Mount erweitern:
  ```yaml
  volumes:
    - claude-os-data:/data
    - claude-os-claude:/root/.claude    # NEU
  volumes:
    claude-os-data:
    claude-os-claude:                   # NEU
  ```
  oder frisches Example aus dem Repo ziehen.

## [1.7.6] — 2026-05-29

### Fixed

- **`claude auth login` credentials werden jetzt im Volume persistiert.** Die `claude`-CLI hardcoded `~/.claude/.credentials.json` und ignoriert `$ANTHROPIC_CONFIG_DIR` für die Credentials-Datei. Resultat: nach `claude auth login` im Container landeten die Credentials im RootFS (verschwinden bei Container-Restart) und die Settings-Page zeigt "nicht vorhanden" obwohl Login durch war. Fix in `docker/entrypoint.sh`: symlinkt `/root/.claude/.credentials.json` zum Volume-Pfad `${ANTHROPIC_CONFIG_DIR}/.credentials.json` beim Container-Start. Idempotent + migrate-fähig (bestehende RootFS-Datei wird beim ersten Boot ins Volume verschoben).

## [1.7.5] — 2026-05-29

### Fixed

- **Sidebar-Brand zeigte hardcoded v1.7.3 trotz v1.7.4-Deployment.** `APP_VERSION` war als String-Konstante in `gui/src/App.tsx` gepflegt → wurde beim Version-Bump zu v1.7.4 vergessen. Fix: vite.config.ts liest jetzt `version` aus `gui/package.json` zur Build-Zeit und injectet sie als `__APP_VERSION__` define. `App.tsx` liest die Konstante mit `declare const`-Fallback auf `'?'` für vitest-Runs ohne Bundler. Drift-Trap geschlossen — alle künftigen Version-Bumps propagieren automatisch in die Brand.

## [1.7.4] — 2026-05-29

### Changed

- **Frontend "Operator Console" Aesthetic-System (PR #210):** Komplettes Re-Skin von generischem AI-Dashboard-Look (system-ui Font + blue-purple Accent) zu einem distinctive Operator-Console-Stil — inspired by Bloomberg Terminal × Linear × k9s. Funktionalität unverändert; nur Token-Layer + Sidebar-Struktur.
  - **Surfaces:** warm anthracite (`#16151a`) statt cool blue-grey + elev-1/2/inset Hierarchy
  - **Accent:** phosphor-cyan (`#5af6cd`) mit dim/glow Varianten; warn=hazard-amber, danger=signal-red, success=status-green — alle mit -dim begleitfarben für banner-Hintergründe
  - **Fonts:** JetBrains Mono (display + headings + buttons) + Geist (body) + Geist Mono (inline-code) via Google Fonts CDN. Tabular-nums + ss01/cv11 stylistic alts global.
  - **Sidebar:** Status-LEDs (●●●●) neben jedem Nav-Item via `data-led={idle|up|warn|down}` mit Pulse-Animation für warn. Active-Item bekommt 2px linke Edge-Marker + accent-glow auf der LED. Section-Labels (OVERVIEW/CONTENT/RUNTIME/SYSTEM). Brand zeigt Versions-Tag rechts oben.
  - **Data-Tables (Catalog/Vault/MCP/Secrets/Agent-Runs/Schedule):** Sticky display-font Header + Mono-Body mit tabular-nums + Hover-LED-Edge auf jedem TR.
  - **Skill-Review-Page (Phase 5c kritisch):** Diff-View komplett umgebaut — Sensitive-Banner als harter signal-red box mit `SEC`-Prefix (war pastel-rosa), Hunks als Terminal-Block mit 2px linker Edge-Marker pro Status (add=grün/del=rot/hunk=amber), Mono + tabular-nums + bold hunk-headers für besseres Scan-Verhalten.
  - **Modal-Panel-Bugfix:** referenzierte `var(--bg-panel)` (undefined token, fiel auf transparent zurück) — jetzt korrekt auf bg-elev-1 mit display-font H2 in Caps.
  - **Buttons:** btn-primary mit dark text auf phosphor-cyan (korrekter Kontrast statt weiß-auf-hell), glow-on-hover. Default-Buttons mit transparent-Rahmen + accent-on-hover.
  - **Form-Inputs:** bg-inset + 3px accent-focus-ring (statt harter border-change).
  - **Terminal-Host (Chat + Anthropic-Login-Modal):** pitch-black bg-inset + focus-glow (18px halo).

## [1.7.3] — 2026-05-28

### Fixed

- **PTY-WebSocket akzeptiert Cookie-Auth (PR #205):** Nach Stage-2-Rollout (ADR-0036) verlangte `/api/pty/ws` immer noch den Stage-1 Bearer-Token via `?token=…`. Browser im Cookie-Mode haben keinen Token zum Anhängen → Chat-Page + Anthropic-Login schlugen mit `pty-ws: unauthorized: invalid or missing token` fehl. Fix: `registerPtyWebSocket` akzeptiert optional `sessionRepo` + `userRepo` und prüft `claude_os_session`-Cookie auf dem WS-Upgrade. Fallback auf `?token=…` bleibt für Stage-1 erhalten.

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
