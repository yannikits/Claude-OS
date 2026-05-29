# TANSS Read-Bridge — Setup-Leitfaden

Stand: v1.8.2 (Phase 7-B, ADR-0039).

Die TANSS Read-Bridge fragt pro Customer einen **lesenden** Snapshot von
TANSS ab: wie viele offene Tickets, neuester Update-Timestamp, ein
Sample-Ticket. Sie macht **nichts** schreibendes — schließt keine Tickets,
versendet keine Mails.

## Voraussetzungen

- TANSS-Server (Cloud oder on-prem), erreichbar von claude-os aus
- Ein API-User in TANSS mit Read-Only-Berechtigung auf Tickets
- claude-os v1.8.2 oder neuer

## Setup in drei Schritten

### 1. Server-URL setzen (Env-Var)

Im `.env` deines Compose-Setups oder als Shell-Env:

```env
CLAUDE_OS_TANSS_SERVER_URL=https://tanss.die-its.digital
```

**Ohne** trailing slash und **ohne** Pfad — nur das Origin. Die Bridge
hängt `/api/v1/tickets/company/<id>` selbst dran.

### 2. apiToken im Secrets-Backend ablegen

```bash
claude-os secrets set tanss/apiToken <der-token-aus-tanss>
```

Der Token kommt aus TANSS — entweder via Login-API
(`POST /api/v1/user/login`) oder über die TANSS-UI „API-Zugang".
Format ist ein opaker String.

> **WICHTIG:** der Token landet **nicht** in `customer.yaml` und **nicht**
> in Logs. Er lebt im OS-Keyring (Desktop) bzw. in `secrets.enc` (Headless
> Container, AES-GCM-verschlüsselt). Wenn du ihn rotieren musst, einfach
> nochmal `secrets set` aufrufen — die Bridge holt ihn pro Call frisch.

### 3. Customer-ID im `customer.yaml` ergänzen

Für jeden TANSS-Customer einen Workspace im Vault anlegen:

```
vault/workspaces/msp-customers/mueller-gmbh/customer.yaml
```

Mit Inhalt:

```yaml
slug: mueller-gmbh
displayName: Müller GmbH

bridges:
  tanss:
    customerId: 42        # die ID aus TANSS (zu sehen in der TANSS-UI)
```

Mehr ist nicht nötig — der Slug ist der Workspace-Name, `customerId`
die TANSS-interne ID. (Siehe `docs/customer-yaml-guide.md` für das volle
Schema mit `contact`, `tags`, `notes` etc.)

## Verification

```bash
claude-os doctor
```

Sollte enthalten:

```
[OK]   tanss-config — TANSS bridge configured (server=https://tanss.die-its.digital)
```

Dann der eigentliche Probe-Smoke-Test:

```bash
claude-os msp probe tanss mueller-gmbh
```

Erwartete Ausgabe:

```
[OK] tanss.probe mueller-gmbh
  bridgeKind=tanss  durationMs=147
  result.kind=ok
  openCount=3  totalCount=12
  newestUpdateAt=2026-05-28T14:23:11.000Z
  sample.id=1234  sample.status=in progress
  sample.subject="Drucker im Empfang offline"
```

Für Machine-Consumption: `--json` returnt das volle `BridgeProbe`-Objekt.

## Was kann schiefgehen?

| Symptom | Bedeutung | Fix |
|---------|-----------|-----|
| `result.kind=misconfigured` + Message „no bridges.tanss section" | `customer.yaml` hat kein `bridges.tanss` | `customerId` ergänzen |
| `result.kind=misconfigured` + Message „HTTP 404 — customerId unknown to TANSS" | Customer-ID in `customer.yaml` falsch | ID in der TANSS-UI prüfen |
| `result.kind=auth-failed` + Message „no apiToken in secrets-backend" | `tanss/apiToken` nicht gesetzt | `claude-os secrets set tanss/apiToken <key>` |
| `result.kind=auth-failed` + Message „HTTP 401" | Token expired/falsch | Token aus TANSS holen und re-setten |
| `result.kind=unreachable` + Message „request timed out" | TANSS antwortet nicht | Netzwerk, Firewall, TANSS-Status prüfen |
| `result.kind=rate-limited` mit `retryAfterSec` | TANSS bremst uns | Polling-Frequenz senken (relevant ab Phase 7-E) |

## Audit-Trail

Jeder Probe schreibt ein `bridge.read`-Event ins Audit-Log
(`<dataDir>/audit/audit-YYYY-MM-DD.jsonl`):

```json
{
  "kind": "bridge.read",
  "action": "bridge.tanss.probe",
  "tenant": "mueller-gmbh",
  "outcome": "ok",
  "details": {
    "bridgeKind": "tanss",
    "customerSlug": "mueller-gmbh",
    "resultKind": "ok",
    "durationMs": 147
  }
}
```

**Kein** Token, **kein** Ticket-Subject, **kein** Ticket-Body. Wer auditen
will, sieht *dass* eine Probe lief und *welcher Outcome*, nicht *was* das
Ticket enthielt.

## Was als Nächstes kommt

- **Phase 7-C** — Veeam-Bridge (gleiches Pattern, andere API)
- **Phase 7-D** — Sophos + Securepoint
- **Phase 7-E** — Aggregat-Dashboard das alle Bridges parallel über alle
  Customers probt und ein Gesamtbild rendert

Bis dahin kannst du die TANSS-Bridge per CLI-Smoke-Test ausprobieren —
und das Audit-Trail-Dashboard (v1.8.0) zeigt dir die Probe-Events bereits
strukturiert.
