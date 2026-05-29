# ADR-0043 — Securepoint USC Read-Bridge (Phase 7-D.2)

**Status:** shipped (2026-05-30, v1.9.2)
**Bedingt durch:** ADR-0038/0039/0040/0041/0042

## Kontext

Drei Bridges (TANSS, Veeam, Sophos) liefern Customer-Health-Daten ans
Dashboard. Letzte verbleibende MSP-Komponente bei Yannik: **Securepoint
UTMs**, die er über die zentrale `portal.securepoint.cloud` (Unified
Security Console) verwaltet.

User-Frage pro Customer: „ist die UTM online + wie lange läuft die
Lizenz noch?"

## Entscheidung

### Architektur: Single Cloud-API, shared Metrics-Cache

Anders als TANSS/Veeam/Sophos liefert Securepoint einen **zentralen
Cloud-Endpoint**, der in einem Request **alle** UTMs aller Mandanten als
Prometheus-Text-Metriken returnt. Die Bridge:

1. Hat einen API-Key (`securepoint/apiKey`) im Secrets-Backend — nicht
   per-Customer
2. Fetched + parsed das `/metrics`-Endpoint einmal pro 60s (default-TTL)
3. Pro `probe(customer)` filtert sie die cached Map nach
   `customer.bridges.securepoint.deviceId`

**Stampede-Protection:** N concurrente Customer-Probes teilen sich EINEN
upstream HTTP-Call via in-flight-promise-Sharing (Pattern wie
AggregateCache aus Phase 7-E).

ADR-0038-Hard-Rule eingehalten: `getApiKey()` wird **pro Probe** frisch
aufgerufen (Token-Rotation klappt). Der Metrics-Cache überspringt nur
den upstream Fetch, nicht den Secret-Lookup.

### API-Fakten (wiki.securepoint.de/USC/Api-Keys-validiert)

```
GET https://portal.securepoint.cloud/sms-mgt-api/api/2.0/metrics?version=2.2
Headers: Authorization: Bearer <api-key>
         Accept: text/plain
```

- Response: **Prometheus-Text-Format**
- API-Key-Scope kann pro Mandant oder „Für alle Mandanten" sein
- Geltungsbereich „Metriken" ist read-only
- API-Key wird **einmalig** im USC-Portal angezeigt — nicht wieder anzeigbar

### Observed Metriken

```
utm_usc_online_total <value>                          # global aggregate
utm_usc_offline_total <value>                         # global aggregate
utm_usc_online_status{utm="<deviceId>",...} 1|0       # per-UTM online flag
utm_license_days_valid{utm="<deviceId>",...} <days>   # per-UTM license remaining
utm_<other>{utm="<deviceId>",...} <value>             # other utm_* metrics
```

Bridge surface die ersten beiden per-UTM-Metriken als
`SecurepointStatus.online` + `licenseDaysRemaining`. Alle weiteren
`utm_*`-Metriken mit matching device-label landen in `additionalMetrics`
für Diagnostics-Drill-Down (clip 20).

### `SecurepointStatus`

```ts
interface SecurepointStatus {
  online: boolean;                          // utm_usc_online_status==1
  licenseDaysRemaining: number | null;      // utm_license_days_valid
  licenseStatus: 'valid' | 'expiring-soon' | 'expired' | 'unknown';
  deviceId: string;                         // echo aus customer.yaml
  additionalMetrics: Array<{ name, value }>; // weitere utm_*-Treffer
}
```

**`licenseStatus`-Heuristik:** null → unknown, ≤ 0 → expired, ≤ 30 →
expiring-soon, > 30 → valid.

### Device-Label-Matching: forgiving

Die device-id-Label-Namen sind je nach Metric- bzw. Securepoint-Version
unterschiedlich. Der `findSamplesForDevice`-Helper matched gegen
mehrere bekannte Keys: `utm`, `device`, `name`, `serial`. Plus eine
explizite `isDeviceMissing()` die durch ALLE Samples scannt — wenn die
`deviceId` aus `customer.yaml` nirgends auftaucht, signalisiert die
Bridge `misconfigured` mit klarer Typo-Hint-Message statt silent
„alles null".

### Prometheus-Text-Parser (eigene Implementation)

Eine kleine, tolerante eigene Implementation in
`securepoint/prom-parser.ts` — kein externes Lib. Begründung:
- Wir brauchen nur basic key{labels} value Parsing
- prom-client (`prom-client`) ist ein Producer, nicht Parser
- Andere Parser sind nicht in der Größenordnung der LOC wert
- Hand-rollen läuft als O(n) line-by-line, mit defensive-tolerance
  gegen malformed-lines (skip statt throw) → robust gegen Version-Drift

Tests decken: labeled/unlabeled metrics, escaped strings (`\"`, `\\`, `\n`),
floats + Scientific, comments + blanks, NaN-rejection, malformed-tolerance.

### Error-Classification

| Symptom | → `BridgeResult.kind` |
|---------|----------------------|
| HTTP 401/403 | `auth-failed` (API-Key invalid) |
| HTTP 429 + Retry-After | `rate-limited` |
| HTTP 404 | `misconfigured` mit API-Version-Hint |
| HTTP 5xx, Network, Abort | `unreachable` |
| `customer.bridges?.securepoint` undefined | `misconfigured` (kein HTTP) |
| Kein API-Key in Secrets-Backend | `auth-failed` (kein HTTP) |
| `deviceId` nicht in metrics-response | `misconfigured` mit Typo-Hint |
| Andere | `error` |

### Config

| Quelle | Schlüssel | Default | Wer setzt |
|--------|-----------|---------|-----------|
| Env | `CLAUDE_OS_SECUREPOINT_BASE_URL` | `https://portal.securepoint.cloud` | optional |
| Env | `CLAUDE_OS_SECUREPOINT_API_VERSION` | `2.2` | optional |
| Env | `CLAUDE_OS_SECUREPOINT_METRICS_TTL_SEC` | `60` | optional |
| Secrets-Backend | `securepoint/apiKey` | — | Admin via `secrets set` |
| customer.yaml | `bridges.securepoint.deviceId` | — (Pflicht) | Per Customer |

### Bootstrap

`serve.ts` registriert SecurepointBridge wrapped mit `withAuditTrail` iff
irgendein Customer `bridges.securepoint` hat. Single API-Key für die
ganze Instance.

### Doctor

`securepoint-config`-Check: enumeriert Customer-Workspaces, zählt
configured. Wenn 0 → ok (skipped). Wenn ≥1 UND `securepoint/apiKey`
im Secrets-Backend → ok. Wenn ≥1 ohne Key → warn mit Hint. Never fail.

### CLI

```bash
claude-os msp probe securepoint <slug> [--base-url <url>] [--api-version <ver>] [--timeout-ms <ms>]
```

Pretty-print: `online=true|false  license=<status> [days=N]` + die
ersten 5 additional metrics.

### Dashboard

Neue Spalte SECUREP. mit Cell-Rendering `ONLINE|OFFLINE · license <status> [(N d)]`
color-coded analog Sophos.

## Konsequenzen

**Positiv:**
- Vier Bridges live im Dashboard — komplette Customer-Health-Übersicht
- Pattern variant „shared cache" ist erfolgreich validiert; künftige
  cloud-zentrale Bridges (M365, Sophos Central) folgen demselben Muster
- Eigener Prom-Parser ist klein (~80 LOC) und tolerant — keine externe Dep
- `deviceId`-Schema-Field war seit Phase 7-A im Schema (no schema break)

**Negativ / Trade-offs:**
- Sehr viele UTMs → großer Prometheus-Response. TTL-Cache mitigiert.
  Bei >1000 UTMs evtl. partial-load oder streaming-parse erforderlich.
- Wir machen KEINE Authentifizierungs-Prevalidation — wir vertrauen dem
  401, statt vorher per-Customer-Permissions zu prüfen.
- `licenseStatus` basiert nur auf der `utm_license_days_valid`-Metric —
  wenn Securepoint die umbenennt, fallback auf `unknown`. Test-Coverage
  dokumentiert das.
- API-Key-Rotation muss durch `claude-os secrets set` passieren.
  Token-Cache aus dem Bridge-Instance-State ist nur die parsed metrics —
  daher kein Stale-Token-Risiko.

**Folge-Schritte:**
- Phase 7-E.1 Dashboard-Polish (Auto-Refresh, Drill-Down, Pagination)
- Optional Phase 7-D.3 Sophos Central (OAuth2, JSON-API, separate ADR)
- Optional M365 Bridge (Phase 7-D.4)

## Referenzen
- ADR-0038/0039/0040/0041/0042 — Pattern-Foundation
- `docs/securepoint-bridge-guide.md` — User-Setup
- wiki.securepoint.de/USC/Api-Keys — API-Doku
- `src/domains/msp-bridges/securepoint/` — Implementation
