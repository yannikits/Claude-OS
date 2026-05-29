# ADR-0039 — TANSS Read-Bridge

**Status:** shipped (2026-05-29, v1.8.2)
**Bedingt durch:** ADR-0027 (Read-Only-Phase), ADR-0038 (MSP-Health-Foundation)

## Kontext

ADR-0038 lieferte die zwei Verträge (`CustomerRepository` + `ReadBridge<T>`).
Phase 7-B macht den ersten konkreten Bridge — TANSS — und prüft damit
gleichzeitig, ob die Foundation trägt.

Use-Case (Yannik): „welche Tickets ich bearbeitet habe bzw. welche Tickets
bei uns auflaufen" — per Customer, im Aggregat-Dashboard (Phase 7-E).

## Entscheidung

### Endpoint

Eine `probe(customer)` macht **einen** Call:

```
GET {CLAUDE_OS_TANSS_SERVER_URL}/api/v1/tickets/company/{customer.bridges.tanss.customerId}
Header: apiToken: <key>
```

Begründung: TANSS hat 8+ Ticket-Listing-Endpoints (`/own`, `/general`,
`/technician`, …). Nur `/company/{id}` ist **per-Customer** und matched
1:1 das, was `customer.yaml` als Identifier hält. Globale „own"-Counter
sind ein Aggregat-Concern (Phase 7-E), nicht per-Customer.

### Auth

Header **`apiToken`** (case-sensitive). PSTANSS-validiert, **NICHT**
`Authorization: Bearer ...`. Token kommt pro Call aus dem Secrets-Backend
(`tanss/apiToken`) — kein Caching im Bridge-Singleton (ADR-0038 Hard-Rule).

Token-Refresh-Flow (TANSS bietet `refreshToken` aus dem Login-Call) ist
**bewusst out-of-scope** für 7-B. Annahme: der apiKey ist langlebig genug
für Read-only-Polling im Minuten/Stunden-Takt; wenn er kippt, re-set per
`claude-os secrets set tanss/apiToken <new-key>`. Wenn das in der Praxis
nervt, kommt Refresh-Logik in 7-B.1.

### Response-Shape

Defensive unwrap: TANSS liefert in den meisten Installationen
`{ content: TanssTicket[] }`, in einigen den bare-Array. Beides
funktioniert. Mapper liest defensiv — unbekannte Felder werden ignoriert,
fehlende `id` heißt `sample = null`. Closed-Detection akzeptiert
`closed === true` ODER `/closed|done|erledigt|geschlossen|completed|finished/i`
in `status` oder `statusName`.

### Status-Shape

Kompakt — nur was das Dashboard braucht:

```ts
interface TanssStatus {
  openCount: number;
  totalCount: number;
  newestUpdateAt: string | null;
  sample: { id: number; subject: string; status: string } | null;
}
```

`sample.subject` kann PII enthalten (Customer-Name, Hostname).
Es lebt **nur** im Probe-Return-Value für die laufende Session.
Es wird **nicht** ins Audit-Log geschrieben (per SECURITY.md §4 +
ADR-0038-Audit-Wrapper-Contract). Im Audit landen nur Counts/Slug/Kind.

### Error-Mapping

| Symptom | → `BridgeResult.kind` |
|---------|----------------------|
| HTTP 401 / 403 | `auth-failed` |
| HTTP 429 (+ optional `Retry-After`) | `rate-limited` |
| HTTP 404 für `/company/{id}` | `misconfigured` (customerId falsch in `customer.yaml`) |
| HTTP 5xx | `unreachable` |
| AbortError / TypeError / `ECONNREFUSED` etc. | `unreachable` |
| `getApiToken()` returns null | `auth-failed` (**kein** HTTP-Call) |
| `customer.bridges?.tanss` undefined | `misconfigured` (**kein** HTTP-Call) |
| Andere | `error` |

Audit-Outcome-Mapping bleibt das Standard-`withAuditTrail`-Schema:
`ok → ok`, `auth-failed → denied`, sonst `error`.

### Config

| Quelle | Schlüssel | Wer setzt |
|--------|-----------|-----------|
| Env | `CLAUDE_OS_TANSS_SERVER_URL` | Admin (`.env` / Compose) |
| Secrets-Backend | `tanss/apiToken` | Admin (`claude-os secrets set tanss/apiToken …`) |
| customer.yaml | `bridges.tanss.customerId: number` | Per Customer |

Pro MSP-Instance EIN Server, viele Customers. Kein per-Customer-Token.

### CLI-Smoke-Test

```bash
claude-os msp probe tanss <slug>          # human-readable
claude-os msp probe tanss <slug> --json   # BridgeProbe als JSON
```

Exit 0 wenn `result.kind === 'ok'`, sonst 1.

### Doctor-Check

`claude-os doctor` → neuer Check `tanss-config`:

- `ok` wenn beide gesetzt
- `ok` wenn beide unset (TANSS ist optional)
- `warn` wenn nur eins gesetzt — mit Hint auf den fehlenden Schritt

Läuft auch aus `docker/entrypoint.sh`-Pre-Flight (root-resolved-Pfad UND
root-unresolved-Pfad).

## Konsequenzen

**Positiv:**
- Erste konkrete Bridge ist da — Yannik kann TANSS testen, bevor Veeam/Sophos
  folgen
- Foundation hat sich bewährt: 0 LOC Audit-Code in der Bridge, 0 LOC
  Schema-Code im CLI-Smoke-Test — alles aus ADR-0038 wiederverwendet
- Pattern für Phase 7-C/D ist jetzt referenzierbar: Veeam/Sophos brauchen
  nur ihre eigenen `*-bridges/<vendor>/`-Module

**Negativ / Trade-offs:**
- `apiToken` muss manuell gepflegt werden, wenn er kippt. Akzeptiert für 7-B;
  Refresh-Logic in 7-B.1 wenn nötig.
- Per-Probe-Cost ist konstant 1 HTTP-Call — pro 100 Customers = 100 Calls.
  TANSS-Rate-Limit ist im Hause irrelevant, aber das Aggregat-Dashboard
  in 7-E muss das Konkurrenzverhalten (parallel-fan-out vs serial)
  bewusst designen.
- Mapper macht **eine** Schema-Annahme (Felder `status` / `statusName` /
  `updateDate` / `id` / `subject` / `closed`). Wenn TANSS irgendwann
  umbenennt, kippen wir auf `error` mit kurzer Message — kein silent
  data-loss.

## Folge-Schritte

- **Phase 7-B.1 (optional):** Refresh-Token-Rotation wenn `apiKey` zu kurz lebt.
- **Phase 7-C:** Veeam-Bridge nach demselben Pattern.
- **Phase 7-D:** Sophos + Securepoint.
- **Phase 7-E:** Aggregat-Dashboard, das `registry.kinds() × customerRepo.list()`
  iteriert und ein einziges Gesamtbild rendert.

## Referenzen
- ADR-0027 — MSP-Bridge Permission-Modell (Read-Only ist diese Phase)
- ADR-0038 — MSP-Health-Foundation (Foundation, der diese Bridge folgt)
- `docs/tanss-bridge-guide.md` — User-Setup (env + secrets + customer.yaml)
- `src/domains/msp-bridges/tanss/` — Implementation
- PSTANSS (AndiBellstedt/PSTANSS) — Referenz für Auth-Header + Endpoints
