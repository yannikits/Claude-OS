# Phase 7-D.2 — Securepoint USC Read-Bridge

**Status:** Plan (Stand 2026-05-30)
**Ziel-Release:** v1.9.2
**Bedingt durch:** ADR-0038/0039/0040/0041/0042

## Was 7-D.2 liefert

`SecurepointBridge implements ReadBridge<SecurepointStatus>` für
**Securepoint USC** (Unified Security Console, cloud-mgmt).

User-Frage pro Customer: „ist die UTM online + wie lange läuft die
Lizenz noch?"

Diese Bridge ist topologisch ANDERS als die bisherigen — ein zentrales
Cloud-API (`portal.securepoint.cloud`) liefert in **einem** Request alle
UTMs aller Mandanten als Prometheus-Text-Metriken. Pro Customer-Probe
filtern wir das gemeinsame Result via `deviceId`-Label.

## API-Fakten (Wiki-validiert: wiki.securepoint.de/USC/Api-Keys)

- **URL:** `GET https://portal.securepoint.cloud/sms-mgt-api/api/2.0/metrics?version=2.2`
- **Auth:** `Authorization: Bearer <api-key>` (JWT-style Bearer-Token aus dem USC-Portal)
- **Format:** **Prometheus-Text-Format** (key{labels} value pro Zeile)
- **API-Key-Scope:** Per Mandant einschränkbar oder global "Für alle Mandanten"
- **Geltungsbereich „Metriken":** read-only

**Observed Metriken (aus Doku):**

```
utm_usc_online_total <value>                              # global aggregate
utm_usc_offline_total <value>                             # global aggregate
utm_usc_online_status{utm="...",mandant="..."} 1|0        # per-UTM online flag
utm_license_days_valid{utm="...",mandant="..."} <days>    # per-UTM license days remaining
```

(Andere `utm_*`-Metriken existieren — wir parsen alle, exponieren die
oben genannten.)

## Architektur: Single API-Key, gemeinsamer Fetch

- **Ein API-Key pro MSP-Instance** im Secrets-Backend: `securepoint/apiKey`
- Bridge-Instance hält **gemeinsamen Metrics-Cache** (TTL 60s default)
- Pro `probe(customer)`:
  1. Cache fresh? → use cached parsed metrics map
  2. Cache stale? → ein HTTP-Call, parse Prometheus-text, cache result
  3. Filter mapped metrics nach `customer.bridges.securepoint.deviceId` (UTM-Label)
- 100 Customer-Probes innerhalb 60s = EIN HTTP-Call. Performance.

Das bedeutet: die ADR-0038-Hard-Rule „getApiToken() pro Probe frisch"
gilt hier für den **API-Key-Lookup**, der bleibt pro-probe frisch. Der
Metrics-Cache ist derived-state-Optimierung wie der Veeam-OAuth-Token.

## Config

| Quelle | Schlüssel | Default | Wer setzt |
|--------|-----------|---------|-----------|
| Env | `CLAUDE_OS_SECUREPOINT_BASE_URL` | `https://portal.securepoint.cloud` | optional |
| Env | `CLAUDE_OS_SECUREPOINT_API_VERSION` | `2.2` | optional |
| Env | `CLAUDE_OS_SECUREPOINT_METRICS_TTL_SEC` | `60` | optional |
| Secrets-Backend | `securepoint/apiKey` | — | Admin via `secrets set` |
| customer.yaml | `bridges.securepoint.deviceId: string` | — (Pflicht) | Per Customer |

`deviceId` ist der UTM-Label-Wert aus dem Prometheus-Response
(`utm_usc_online_status{utm="<deviceId>"}`). Yannik findet den im USC-Portal.

## Module

### `src/domains/msp-bridges/securepoint/`

```
types.ts          — SecurepointStatus, SecurepointBridgeConfig, MetricsSample
prom-parser.ts    — pure: prometheus-text → Map<metricName, Array<{labels, value}>>
mapper.ts         — pure: parsed-metrics + deviceId → SecurepointStatus
metrics-cache.ts  — TTL cache for the parsed Prometheus map (shared across customers)
classify-error.ts — HTTP + thrown → BridgeResult.kind
bridge.ts         — SecurepointBridge implements ReadBridge<SecurepointStatus>
index.ts          — barrel
```

### `SecurepointStatus`

```ts
interface SecurepointStatus {
  /** True when utm_usc_online_status{utm=deviceId}==1. False when 0 or absent. */
  readonly online: boolean;
  /** Days from utm_license_days_valid{utm=deviceId}. */
  readonly licenseDaysRemaining: number | null;
  /** License-bucket for at-a-glance UI. */
  readonly licenseStatus: 'valid' | 'expiring-soon' | 'expired' | 'unknown';
  /** Matched device-id from customer.yaml (echoed). */
  readonly deviceId: string;
  /** Other utm_* metric names found for this device — diagnostics. */
  readonly additionalMetrics: readonly { readonly name: string; readonly value: number }[];
}
```

**`licenseStatus`-Heuristik:**
- `licenseDaysRemaining` null → `unknown`
- ≤ 0 → `expired`
- ≤ 30 → `expiring-soon`
- > 30 → `valid`

### Error-Classification

| Symptom | → `BridgeResult.kind` |
|---------|----------------------|
| HTTP 401/403 | `auth-failed` (API-Key falsch/expired) |
| HTTP 404 | `misconfigured` (URL falsch) |
| HTTP 5xx | `unreachable` |
| Network/AbortError/ECONN* | `unreachable` |
| Customer ohne `bridges.securepoint.deviceId` | `misconfigured` (**kein** HTTP-Call) |
| API-Key nicht im Secrets-Backend | `auth-failed` (**kein** HTTP-Call) |
| Metrics-Response parseable aber deviceId fehlt | `misconfigured` mit Hint („deviceId nicht in metrics — Tippfehler?") |
| Andere | `error` |

## Tests

- `prom-parser.test.ts` — happy + comments + labels + escaped values + invalid lines tolerant
- `mapper.test.ts` — license-status all buckets, missing-metric → null, online-flag, additionalMetrics dedup
- `metrics-cache.test.ts` — TTL boundary, stampede-protection wie AggregateCache
- `classify-error.test.ts` — analog Sophos
- `bridge.test.ts` — fetch-mock: happy, 401, no-creds-no-call, no-deviceId-no-call, cache-shared-across-customers, deviceId-not-in-metrics → misconfigured, audit-integration

## Phase-Aufteilung

### A — Pure Logik
- types/prom-parser/mapper/classify-error + Tests
- **Commit:** `feat(securepoint): prometheus parser + status mapper (Phase 7-D.2.A)`

### B — Bridge mit Metrics-Cache
- metrics-cache/bridge/index + Tests
- **Commit:** `feat(securepoint): SecurepointBridge with shared metrics cache (Phase 7-D.2.B)`

### C — CLI + Doctor + Bootstrap + Frontend
- CLI msp probe securepoint
- doctor check securepoint-config (env+apiKey wie tanss-config)
- Bootstrap-wiring iff customer.bridges.securepoint
- Frontend SecurepointCell
- **Commit:** `feat(securepoint): wire bridge into CLI + doctor + dashboard (Phase 7-D.2.C)`

### D — Docs + Release
- ADR-0043
- `docs/securepoint-bridge-guide.md`
- CHANGELOG v1.9.2
- 4 Manifest-Bumps
- **Commit:** `feat(securepoint): v1.9.2 — Securepoint USC Read-Bridge` + PR

## Out-of-Scope

- Schreibende Operationen (per ADR-0027)
- Per-Mandant-spezifische Endpoints (zumindest in MVP)
- On-prem direct-UTM-Zugriff
- Detail-Metriken-Anzeige im Dashboard (additionalMetrics nur im JSON-Drill-Down)

## Risiken

| Risiko | Mitigation |
|--------|------------|
| Metric-Label-Namen anders als angenommen (z.B. `utm=` vs `device=`) | Mapper akzeptiert mehrere Label-Keys (`utm`/`device`/`name`/`serial`), Test mit allen Varianten |
| Prometheus-Text-Format edge-cases (escaped strings, quoted-LF) | Defensive parser, Test gegen Spec-Examples |
| API-Key mit nur Read auf Metriken aber falscher Mandant-Scope → leere Daten | Mapper unterscheidet „kein Match" → misconfigured-Hint vs „API ok aber Liste leer" |
| Cache invalidierter zur falschen Zeit (race condition zwischen N Probe-Aufrufen) | Cache-Stampede-Protection wie AggregateCache (gemeinsames in-flight promise) |
| Sehr viele UTMs → Prometheus-Response groß | TTL-Cache mitigiert; sonst parser ist O(n) streaming-friendly |

## Verification

- [ ] alle Unit-Tests grün
- [ ] tsc/biome clean
- [ ] doctor-check
- [ ] CLI-Smoke gegen echten API-Key
- [ ] Dashboard rendert SecurepointCell
- [ ] Audit-Event mit nur customerSlug/durationMs/resultKind
- [ ] ADR + Guide + CHANGELOG
