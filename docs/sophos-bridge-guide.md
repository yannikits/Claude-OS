# Sophos XG/XGS Read-Bridge — Setup-Leitfaden

Stand: v1.9.1 (Phase 7-D, ADR-0042).

Die Sophos Read-Bridge fragt pro Customer-Firewall **firmware-version**
+ **license-summary** ab. Antwort auf: „ist die Firewall up-to-date,
und sind die Subscriptions noch lange genug gültig?"

Sie macht **nichts** schreibendes — startet keine Updates, ändert keine
Rules.

## Voraussetzungen

- Sophos XG/XGS Firewall (SFOS 19+ getestet)
- Sophos **XML-API enabled**: System > Backup & Firmware > API > **Allow API access**
- **claude-os Server-IP in der API Access List** (sonst Status 534)
- Service-User mit Read-Berechtigung (Profile: Audit Admin reicht für
  Firmware + LicenseInformation)
- claude-os v1.9.1 oder neuer

## Setup in drei Schritten

### 1. Customer-Workspace mit Sophos-Konfig anlegen

`vault/workspaces/msp-customers/mueller-gmbh/customer.yaml`:

```yaml
slug: mueller-gmbh
displayName: Müller GmbH

bridges:
  sophos:
    firewallHostname: fw.mueller.local    # Pflicht — der XG/XGS-Host
    firewallPort: 4444                    # optional — default 4444
```

Wer einen XG-Cluster mit HA fährt: einfach das Master-VIP als `firewallHostname`
nehmen.

### 2. Credentials im Secrets-Backend ablegen

Pro Firewall-Hostname:

```bash
claude-os secrets set sophos/fw.mueller.local/username svc-claude
claude-os secrets set sophos/fw.mueller.local/password <password>
```

Falls mehrere Customer dieselbe Firewall teilen (selten, aber möglich):
die Creds gelten pro Hostname, nicht pro Customer-Slug.

### 3. Optional: TLS-Verhalten

Sophos XG/XGS liefert per Default **self-signed Cert**. Drei Optionen:

**Option A (default):** Cert über interne CA signieren — claude-os
verifiziert sauber, nix zu tun.

**Option B (CLI-only):**

```bash
claude-os msp probe sophos mueller-gmbh --insecure-tls
```

**Option C (Server-wide, im Compose `.env`):**

```env
CLAUDE_OS_SOPHOS_INSECURE_TLS=1
```

→ setzt `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide. Affects ALL TLS
verifications on the server — nur in vertrauenswürdigen MSP-Netzen aktivieren.

## Verification

```bash
claude-os doctor
```

Erwartete Zeile (wenn 1 Sophos-Customer konfiguriert + Creds da):

```
[OK]   sophos-config — Sophos configured for 1 host(s)
```

Wenn Creds fehlen:

```
[WARN] sophos-config — Sophos credentials missing for 1 of 1 host(s)
       fw.mueller.local
       Hint: Run: claude-os secrets set sophos/<host>/username <user> AND
             sophos/<host>/password <pwd> for each
```

Smoke-Test:

```bash
claude-os msp probe sophos mueller-gmbh --insecure-tls
```

Erwartete Ausgabe:

```
[OK] sophos.probe mueller-gmbh
  bridgeKind=sophos  durationMs=247
  result.kind=ok
  firmware=SFOS 20.0.1 MR-1 (Default)
  license=active  earliest-expiry=247d
    [Subscribed] Network Protection  exp=2027-01-31 (247d)
    [Subscribed] Web Protection  exp=2027-01-31 (247d)
    [Subscribed] Email Protection  exp=2027-01-31 (247d)
```

Im **MSP-Health Dashboard** (Sidebar → MSP Health) erscheint jetzt eine
SOPHOS-Spalte mit:

```
SOPHOS
SFOS 20.0.1 MR-1 · active (247d)         (grün)
SFOS 19.5 MR-3 · expiring-soon (12d)     (gelb)
SFOS 19.0 · expired                       (rot)
```

## Was kann schiefgehen?

| Symptom | Bedeutung | Fix |
|---------|-----------|-----|
| `result.kind=misconfigured` + „has no bridges.sophos section" | customer.yaml fehlt `bridges.sophos` | `firewallHostname` ergänzen |
| `result.kind=auth-failed` + „no credentials in secrets-backend" | Creds nicht gesetzt | `claude-os secrets set sophos/<host>/{username,password}` |
| `result.kind=auth-failed` + „IP not allowed in API Access List" | claude-os Server-IP nicht freigeschaltet (Sophos Status 534) | XG-UI: System > Backup & Firmware > API → IP/Range hinzufügen |
| `result.kind=misconfigured` + „API not enabled" | XML-API in Sophos nicht aktiviert (Status 532) | XG-UI: System > Backup & Firmware > API → **Allow API access** an |
| `result.kind=auth-failed` + „Authentication Failure" | User/Passwort falsch | Im XG-UI prüfen, Creds re-setten |
| `result.kind=unreachable` + „UNABLE_TO_VERIFY_LEAF_SIGNATURE" | Self-signed Cert ohne Override | `CLAUDE_OS_SOPHOS_INSECURE_TLS=1` setzen oder `--insecure-tls` |
| `result.kind=unreachable` + „ECONNREFUSED" | XG nicht erreichbar (Firewall/VPN/Port) | Port 4444 + Erreichbarkeit prüfen |
| `result.kind=error` + „unparsable Sophos response" | XG hat HTML statt XML geschickt (zB Captive Portal) | URL prüfen, evtl. falscher Host |
| `result.data.licenseSummary=expired` | Subscriptions abgelaufen | Im Sophos Central renewen |
| `result.data.licenseSummary=expiring-soon (12d)` | Eine Subscription läuft in ≤ 30 Tagen ab | Renewal anstoßen |

## Audit-Trail

Pro Probe ein `bridge.read`-Event:

```json
{
  "kind": "bridge.read",
  "action": "bridge.sophos.probe",
  "tenant": "mueller-gmbh",
  "outcome": "ok",
  "details": {
    "bridgeKind": "sophos",
    "customerSlug": "mueller-gmbh",
    "resultKind": "ok",
    "durationMs": 247
  }
}
```

**Niemals** im Audit: Username, Password, Subscription-Namen, Firmware-Version.
Counts + Slug + Kind + Duration only — wie bei TANSS und Veeam.

## Was als Nächstes kommt

- Phase 7-D.2 — Securepoint Read-Bridge
- Phase 7-E.1 — Dashboard-Auto-Refresh, Pagination, Drill-Down zu Audit-Events
- Phase 7-D.X — Sophos Central-Bridge (falls relevant)
