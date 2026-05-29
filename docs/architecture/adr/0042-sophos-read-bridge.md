# ADR-0042 — Sophos XG/XGS Read-Bridge (Phase 7-D)

**Status:** shipped (2026-05-30, v1.9.1)
**Bedingt durch:** ADR-0027 (Read-Only Phase 6), ADR-0038 (Foundation), ADR-0039 (TANSS Pattern), ADR-0040 (Veeam Pattern), ADR-0041 (Aggregat-Dashboard)

## Kontext

ADR-0038-Foundation + 0039/0040 Bridges + 0041 Dashboard sind shipped.
Yannik kann TANSS + Veeam pro Customer probed sehen. Was fehlt für eine
„komplette MSP-Health-Ansicht": **Firewall-Status**.

User-Frage: „ist die Firewall up-to-date + ist die Lizenz noch lange genug
gültig?"

Yannik nutzt **Sophos XG/XGS** auf-prem bei jedem Customer. Sophos Central
(Cloud-Mgmt) ist out-of-scope für 7-D — separate API, OAuth2, kommt
vielleicht als 7-D.2.

## Entscheidung

### Architektur: Per-Customer-Firewall

Gleiches Muster wie Veeam (ADR-0040): jeder Customer hat seinen eigenen
on-prem XG/XGS, claude-os erreicht ihn per VPN/MPLS.

Schema-Update am `SophosBridgeIds`:
- `firewallHostname: string` — **Pflicht** (war optional)
- `firewallPort?: number` — default 4444
- `centralCustomerId?: string` — reserved für Sophos-Central-Bridge (future)

Schema-Breaking gegen v1.9.0, aber niemand produktiv → akzeptiert wie bei Veeam.

### API: XML-API auf Port 4444

Hard-confirmed via `sophos/sophos-firewall-sdk` (Sophos-eigenes Python-Modul):

```
POST https://<host>:<port>/webconsole/APIController
Content-Type: application/x-www-form-urlencoded
Body: reqxml=<Request>
        <Login><Username>...</Username><Password>...</Password></Login>
        <Get><Firmware></Firmware></Get>
        <Get><LicenseInformation></LicenseInformation></Get>
      </Request>
```

**Schlüssel-Eigenschaften:**

- **Kein Token, keine Session.** Credentials sind in JEDEM Request inline im
  XML-Body. → exakt 1 HTTP-Call pro Probe.
- **Multiple `<Get>`-Blöcke pro Request sind erlaubt** → wir holen Firmware
  + LicenseInformation in einem Call statt zwei.
- **Response ist XML.** Erste neue XML-Dep im Projekt: `fast-xml-parser`
  (~10M weekly downloads, MIT, TypeScript-typed, 0 transitive deps).
  Gated in `src/domains/msp-bridges/sophos/xml-parser.ts` — der Rest des
  Codebases bleibt XML-agnostisch.
- **Sophos sneaks errors inside HTTP-200** via top-level `<Status code="...">`:
  - `534` — IP nicht in API Access List → `auth-failed` mit klarer Message
  - `532` — API nicht aktiviert → `misconfigured` mit Enable-Hint

### `SophosStatus` (Operator-Health-Focus)

```ts
interface SophosStatus {
  firmwareVersion: string;          // "SFOS 20.0.1 MR-1"
  firmwareType: string | null;      // "Default" / "MR"
  licenseSummary: 'active' | 'expiring-soon' | 'expired' | 'mixed' | 'unknown';
  daysToEarliestExpiry: number | null;
  subscriptions: Array<{
    name: string;
    status: string;                 // "Subscribed" / "Trial" / "Expired"
    expiresAt: string | null;       // ISO UTC midnight
    daysRemaining: number | null;
  }>;
}
```

**`licenseSummary`-Heuristik** (conservative-by-default):

- 0 Subscriptions → `unknown`
- alle expired/deactivated → `expired`
- some expired, some active → `mixed`
- alle active + min daysRemaining ≤ 30 → `expiring-soon`
- alle active + min daysRemaining > 30 → `active`

Edge-Cases die wir explicit handhaben:
- "Subscribed" mit `daysRemaining < 0` → als expired gewertet (Sophos lagged
  manchmal an der Sync zwischen Status und ExpiryDate)
- Unknown status strings ("Pending") → expired-side für conservative reporting

### Error-Classification (drei Layer)

| Layer | Symptom | → `BridgeResult.kind` |
|-------|---------|----------------------|
| HTTP | 401/403 | `auth-failed` |
| HTTP | 429 | `rate-limited` |
| HTTP | 404 | `misconfigured` |
| HTTP | 5xx | `unreachable` |
| Network | AbortError, ECONN*, TLS-Codes | `unreachable` mit TLS-Hint |
| XML `<Status code>` | 534 (IP-ACL) | `auth-failed` |
| XML `<Status code>` | 532 (API not enabled) | `misconfigured` mit Enable-Hint |
| XML `<Login>` | "Authentication Failure" | `auth-failed` |
| Config | `customer.bridges?.sophos` undefined | `misconfigured` (**kein** HTTP-Call) |
| Config | keine Creds für Host im Secrets-Backend | `auth-failed` (**kein** HTTP-Call) |
| Andere | — | `error` |

### Config

| Quelle | Schlüssel | Default | Wer setzt |
|--------|-----------|---------|-----------|
| Env | `CLAUDE_OS_SOPHOS_INSECURE_TLS` | `0` | Admin (opt-in für self-signed XG-Default) |
| Secrets-Backend | `sophos/<host>/username` | — | Admin via `secrets set` |
| Secrets-Backend | `sophos/<host>/password` | — | Admin via `secrets set` |
| customer.yaml | `bridges.sophos.firewallHostname` | — (Pflicht) | Per Customer |
| customer.yaml | `bridges.sophos.firewallPort` | `4444` | Per Customer (optional) |

### Bootstrap-Wiring

`serve.ts` registriert SophosBridge wrapped mit `withAuditTrail` iff
irgendein Customer `bridges.sophos` hat. TLS-Insecure greift process-wide
identisch zu Veeam.

### CLI

```bash
claude-os msp probe sophos <slug> [--insecure-tls] [--timeout-ms <ms>]
```

Pretty-print: `firmware` + `license=<summary>` + die ersten 6 Subscriptions.

### Doctor

`sophos-config`-Check enumeriert Customer-Workspaces, sammelt distinct
`firewallHostname`-Werte, prüft pro Host ob `sophos/<host>/{username,password}`
im Secrets-Backend. ok bei kein-Sophos ODER alle-Hosts-Creds-da; warn bei
N von M Hosts ohne Creds (Hostnamen im `detail`). Never fail.

### Dashboard-Integration

Neue Spalte SOPHOS in `gui/src/pages/msp-health.tsx`. Cell-Rendering:
- `firmware · license-summary [· N days]` — color-coded:
  - `active` → tone-ok
  - `expiring-soon` / `mixed` → tone-warn
  - `expired` / `unknown` → tone-error

Backend-Aggregator (`runProbes`) **unverändert** — Foundation pays off.

## Konsequenzen

**Positiv:**
- Drei Bridges + ein Dashboard live; MSP-Health bietet jetzt Operations
  (TANSS), Backups (Veeam) UND Security/Compliance (Sophos) in einem Blick.
- Foundation hat sich erneut bewährt: Backend-Aggregator nullte Änderungen.
  Phase 7-D.2 (Securepoint) ist nur noch das gleiche Pattern.
- XML-Bridge Pattern existiert jetzt — falls Securepoint/M365 auch XML
  sprechen, ist `xml-parser.ts` wiederverwendbar.

**Negativ / Trade-offs:**
- Neue Dep `fast-xml-parser` (~80 KB). Akzeptiert für vendor-XML-APIs.
  Gated in `sophos/` so dass der Rest XML-agnostisch bleibt.
- Sophos hat KEIN Session-Modell — jede Probe ist ein OAuth-loser, voller
  Login-Round-Trip. Schneller (1 statt 2 calls bei Veeam) aber teurer falls
  Sophos eine Rate-Limit hat (nicht beobachtet, Doku schweigt).
- Sophos sub-second probe duration noch nicht im Production-Test verifiziert
  — bei großen Customers (Hunderte Firewall-Rules etc.) kann der Response
  schwerer werden, aber `<Get><Firmware/></Get>` ist klein.
- `licenseSummary` ist eine Heuristik, kein direkt-aus-API-Feld. Bei un-
  bekannten Sophos-Status-Strings fällt sie konservativ auf expired-side.

**Folge-Schritte:**
- Phase 7-D.2 Securepoint (wenn Yannik API-Doku gibt)
- Phase 7-E.1 Dashboard-Polish (Auto-Refresh, Pagination, Drill-Down)
- Sophos Central-Bridge falls Yannik das auch nutzt (OAuth2, JSON, separate ADR)

## Referenzen
- ADR-0027 MSP-Bridge Permission-Modell
- ADR-0038 MSP-Health-Foundation
- ADR-0039 TANSS Read-Bridge
- ADR-0040 Veeam Read-Bridge
- ADR-0041 MSP-Health Aggregat-Dashboard
- `docs/sophos-bridge-guide.md` — User-Setup
- `src/domains/msp-bridges/sophos/` — Implementation
- `sophos/sophos-firewall-sdk` (GitHub) — Auth + endpoint reference
