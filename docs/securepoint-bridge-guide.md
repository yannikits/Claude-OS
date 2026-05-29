# Securepoint USC Read-Bridge — Setup-Leitfaden

Stand: v1.9.2 (Phase 7-D.2, ADR-0043).

Die Securepoint Read-Bridge fragt **pro Customer** den Status der
zugehörigen UTM aus der zentralen Unified Security Console (USC,
portal.securepoint.cloud) ab: **ist die UTM online?** + **wie viele
Tage hat die Lizenz noch?**

## Voraussetzungen

- Securepoint USC-Account mit API-Key-Berechtigung (USC v2.14+)
- claude-os v1.9.2 oder neuer

## Setup in drei Schritten

### 1. API-Key im USC-Portal anlegen

1. portal.securepoint.cloud → API Keys
2. **API Key hinzufügen** mit:
   - Eindeutiger Name (z.B. "claude-os monitoring")
   - **Für alle Mandanten** aktivieren (sonst pro Customer einen Key)
   - Geltungsbereich: **Metriken / Lesen**
   - Ablaufdatum: nach Wunsch (claude-os warnt nicht automatisch vor Ablauf)
3. Den angezeigten API-Key **sofort kopieren** — er wird nur einmalig
   angezeigt und kann später nicht wieder eingesehen werden!

### 2. API-Key im Secrets-Backend ablegen

```bash
claude-os secrets set securepoint/apiKey <der-API-Key>
```

Ein einziger API-Key für alle Customer (anders als Veeam/Sophos wo es
pro Host eigene Creds gibt).

### 3. Customer-Workspaces mit `deviceId` ergänzen

Pro Customer den UTM-Bezeichner aus dem USC-Portal in die customer.yaml
eintragen:

`vault/workspaces/msp-customers/mueller-gmbh/customer.yaml`:

```yaml
slug: mueller-gmbh
displayName: Müller GmbH

bridges:
  securepoint:
    deviceId: UTM-MUELLER-01    # Der utm-Label-Wert aus den USC-Metriken
```

Wie finde ich die `deviceId`? Die ist das `utm=`-Label im
Prometheus-Output. Schnellster Weg:

```bash
curl -H "Authorization: Bearer <api-key>" \
  "https://portal.securepoint.cloud/sms-mgt-api/api/2.0/metrics?version=2.2" \
  | grep utm_usc_online_status
```

→ Listet alle UTMs mit ihrem `utm=` Label. Den Wert in `customer.yaml`
übernehmen.

## Verification

```bash
claude-os doctor
```

Erwartete Zeile:

```
[OK]   securepoint-config — Securepoint USC configured (3 customer device(s))
```

Smoke-Test:

```bash
claude-os msp probe securepoint mueller-gmbh
```

Erwartete Ausgabe:

```
[OK] securepoint.probe mueller-gmbh
  bridgeKind=securepoint  durationMs=347
  result.kind=ok
  deviceId=UTM-MUELLER-01  online=true
  license=valid  days=200
  +3 additional metric(s)
    utm_cpu_usage = 12
    utm_memory_usage = 47
    utm_connections_active = 1234
```

Im **MSP-Health Dashboard** (Sidebar → MSP Health) erscheint jetzt die
SECUREP.-Spalte:

```
ONLINE · license valid (200d)         (grün)
ONLINE · license expiring-soon (12d)  (gelb)
OFFLINE · license valid (200d)        (rot — UTM-Tile)
```

## Was kann schiefgehen?

| Symptom | Bedeutung | Fix |
|---------|-----------|-----|
| `result.kind=misconfigured` + „has no bridges.securepoint.deviceId" | customer.yaml fehlt `bridges.securepoint.deviceId` | deviceId ergänzen |
| `result.kind=misconfigured` + „deviceId ... not present in Securepoint metrics — typo" | deviceId stimmt nicht mit USC-utm-Label überein | Per `curl` UTMs auflisten, deviceId korrigieren |
| `result.kind=auth-failed` + „no API-key in secrets-backend" | Key nicht gesetzt | `claude-os secrets set securepoint/apiKey <key>` |
| `result.kind=auth-failed` + „HTTP 401 — API-Key invalid or expired" | Key falsch / abgelaufen | Neuen Key im USC-Portal anlegen + secrets set |
| `result.kind=misconfigured` + „HTTP 404 — metrics endpoint unknown" | API-Version stimmt nicht | `CLAUDE_OS_SECUREPOINT_API_VERSION` auf die aktuelle USC-Version setzen (Default 2.2) |
| `result.kind=unreachable` + „ECONNREFUSED" oder Timeout | portal.securepoint.cloud nicht erreichbar | Internet-Connectivity prüfen |

## Architektur-Notiz: Shared Metrics-Cache

Anders als TANSS/Veeam/Sophos, wo jede Customer-Probe einen eigenen
HTTP-Call macht, holt sich diese Bridge die Metriken **einmal pro 60s**
(default) und filtert pro Customer aus dem Cache.

→ 100 Customer auf einem MSP-Dashboard-Refresh = **EIN** HTTP-Call zu
Securepoint (statt 100).

Override per `CLAUDE_OS_SECUREPOINT_METRICS_TTL_SEC=120` etc.

## Audit-Trail

Pro Probe ein `bridge.read`-Event:

```json
{
  "kind": "bridge.read",
  "action": "bridge.securepoint.probe",
  "tenant": "mueller-gmbh",
  "outcome": "ok",
  "details": {
    "bridgeKind": "securepoint",
    "customerSlug": "mueller-gmbh",
    "resultKind": "ok",
    "durationMs": 347
  }
}
```

**Niemals** im Audit: API-Key, deviceId, Metric-Values. Counts + Slug + Kind
+ Duration only.

## Was als Nächstes kommt

- Phase 7-E.1 — Dashboard-Polish (Auto-Refresh, Pagination, Cell-Drill-Down zu Audit-Events)
- Optional Sophos-Central-Bridge (Cloud-Variante zu XG/XGS)
- Optional M365-Bridge (Tenant-Health)
