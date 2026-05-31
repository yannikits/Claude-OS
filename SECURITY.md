# Claude OS — Security & Trust

**Status:** Pflicht-Read vor jeder Arbeit an MSP-Bridges, Self-Improving-Skills oder Secrets-Handling. Verbindlich bei Konflikt mit `CLAUDE.md` / `ARCHITECTURE.md`, soweit Sicherheit betroffen.

## 1. Threat-Model

| Threat | Wer | Wo | Mitigation |
|---|---|---|---|
| Prompt-Injection über Vault-Notes | externer Inhalt im Vault | Memory-Retrieval | Frontmatter-`classification` respektieren, untrusted Inhalte markieren, niemals direkt als Instruction interpretieren |
| Prompt-Injection über MSP-API-Responses | Customer-System-Daten | MCP-Tool-Returns | API-Response als Daten, nie als Instruction; Schema-Validation Pflicht |
| Datenleck aus Customer-Daten in LLM-Provider | TANSS-Tickets, M365-Mails | Provider-Call | Klassifikation `customer-confidential` → Provider-Allowlist, Redaction-Hook vor Send |
| Self-improving Skill exfiltriert Daten | LLM-generierter Skill | Skill-Auto-Promotion | Sandbox vor Aktivierung, Yannik-Review-Gate, Code-Diff anzeigen |
| Compromised npm-Dependency | Supply-Chain | `npm install` | Lockfile-Pinning, `npm audit` in CI, Renovate für kontrollierte Updates |
| Vault-Datei korrumpiert | filesystem-Fehler / OneDrive-Sync-Konflikt | `vault-sync` | Frontmatter-Validation, Konflikt-Notes als `*.conflict.md` separieren, nicht überschreiben |
| MSP-Bridge zerstört Customer-Daten | versehentlicher Write | Phase 7 Write-Pfad | Approval-Gate, Rollback-Tokens, Dry-Run-Modus Default |
| Cross-Tenant-Leak | falscher Workspace-Context | Memory-Retrieval | Workspace-Filter in FTS-Query, `workspace`-Frontmatter Pflicht |

## 2. Data-Classification (Pflicht-Frontmatter `classification:`)

| Klasse | Beispiele | Im Provider-Call? | Logging |
|---|---|---|---|
| `public` | Open-Source-Snippets, Doku-Auszüge | ja | normal |
| `personal` | Yanniks Notizen, House-Watch | ja (Anthropic, nicht beliebige Free-Tier) | normal |
| `operational` | Repo-interne Configs, ADRs | ja | normal |
| `customer-confidential` | TANSS-Tickets, Kunden-Doku, NinjaOne-Inventar | **nein** ohne Redaction; nur über Provider-Allowlist + Redaction-Hook | mit Audit-Eintrag |
| `secret` | API-Keys, Passwords, Tokens | **nie** im Prompt | nur Hash im Log |
| `ephemeral` | Session-Transkripte, in-flight Daten | nein für Long-Term-Storage | rotierender Log |

**Fail-safe Default:** fehlende Klassifizierung → als `customer-confidential` behandeln bis explizit umgesetzt.

## 3. Secrets-Handling

### 3.1 Storage
- **Primary:** NAPI-RS Keyring (Windows Credential Manager, macOS Keychain)
- **Secondary (Dev only):** `.env`-Files, niemals committed (`.gitignore` enforce)
- **Niemals:** Plain-Text-Configs im Vault, im Code, in Logs

### 3.2 Scopes
- Anthropic-API-Key: 1 Key, full scope (kein Sub-Scope verfügbar)
- TANSS/NinjaOne/Veeam/M365: **separater Read-Only-User pro Service** bei Erstanlage; Write-User erst bei Phase 7
- M365: Application-Permissions minimal-scoped (z. B. `Mail.Read` statt `Mail.ReadWrite`)

### 3.3 Rotation
- Jeder Provider/Bridge muss Token-Rotation ohne Service-Restart unterstützen
- Bei Compromise-Verdacht: sofort revoken, neuen Token via Keyring
- Audit-Log enthält Token-Hash (erste 8 Zeichen), nie den Token selbst

### 3.4 Redaction
Vor jedem Provider-Call läuft Redaction-Hook:
- Strings, die wie API-Keys aussehen (AWS-/Anthropic-/Stripe-/JWT-Patterns) → ersetzt durch `[REDACTED:type]`
- E-Mail-Adressen in `customer-confidential` → ersetzt durch `[REDACTED:email]`
- Logging immer redacted-Form, nie Original

## 4. Audit-Log

**Schema-Status:** finalisiert v1 (2026-05-27) per Phase-5-completion. Siehe `src/core/audit/types.ts AUDIT_SCHEMA_VERSION` für die kanonische Form. Forward-compat: Reader tolerieren höhere Versionen durch unknown-field-skip; Backwards-incompat-Änderungen bumpen die Version.

### 4.1 Loggen
- Provider-Call (Modell, Token-Counts, Tool-Calls, Approval-Status)
- MSP-Tool-Aufruf (Bridge, Endpoint, HTTP-Status, Customer-ID falls vorhanden)
- Skill-Loading (Skill-Name, Version, Source)
- Self-improving-Skill-Approval (Diff-Hash vorher/nachher, Yannik-Signatur)
- Secrets-Access (Service, Operation, NIE den Token)
- Vault-Mutation (path, classification, operation, workspace)
- Workspace-Switch

### 4.2 Format (JSONL — v1, finalisiert 2026-05-27)

Eine Zeile pro Event. Pflicht-Felder + freiform `details`:

```jsonl
{"schema_version":1,"at":"2026-05-27T10:00:00.000Z","kind":"note.write","action":"quick-capture","workspace":"msp-customers/acme","tenant":"acme","outcome":"ok","details":{"source":"anruf","category":"incident","titleLength":18,"bodyLength":234},"pid":12345,"hostname":"yannik-pc"}
```

Pflicht-Felder:
- `schema_version` — `AUDIT_SCHEMA_VERSION` (heute `1`)
- `at` — ISO-8601 UTC
- `kind` — discriminator (`bridge.read|bridge.write|workspace.switch|secret.read|secret.write|skill.promote|skill.invoke|note.write`)
- `action` — kurze Aktion (`tanss.tickets.list`, `quick-capture`, …)
- `workspace` — aktiver Workspace (ADR-0031)
- `outcome` — `ok|denied|error`
- `pid`, `hostname` — forensic correlation

Optionale Felder:
- `tenant` — bei `msp-customers/<id>` gesetzt (Customer-ID extrahiert)
- `details` — freeform sanitised payload (KEINE Secrets, Caller-Verantwortung)

### 4.3 Aufbewahrung
- Pfad: `<dataDir>/audit/audit-YYYY-MM-DD.jsonl` (UTC-day-Rotation, automatisch)
- Append-only — kein Edit, kein Delete (außer Retention-Cleanup via `pruneAuditFiles`)
- File-Mode `0o600` (per-machine, nicht world-readable)
- Retention: **90 Tage default** (per `DEFAULT_RETENTION_DAYS`), konfigurierbar bis **10 Jahre** (`§147 AO` Tax-Authorities, dominiert DSGVO MSP-Kontext 7y) via `$CLAUDE_OS_AUDIT_RETENTION_DAYS` env-var
- Retention-Cleanup: `pruneAuditFiles()` aus `@core/audit/retention` — idempotent, dry-run-Mode, filename-driven (löscht NUR `audit-YYYY-MM-DD.jsonl`, lässt `.gz`-Archives + stray files alleine)
- gzip-Archives: Phase-5-future (optional; aktuell wird `audit-YYYY-MM-DD.jsonl` nach Ablauf einfach gelöscht)

## 5. Self-Improving Skills (kritisch — ADR-0026)

Erlaubt erst nach ADR-0026-Implementation. Bis dahin: nicht aktivieren.

### 5.1 Lifecycle
```
draft → quarantined → reviewed → active → deprecated → disabled
```

- **draft:** Auto-generiert aus Lessons. Nicht ladbar.
- **quarantined:** Im Sandbox-Workspace. Read-only-Test ausführbar.
- **reviewed:** Yannik hat Diff gesehen und freigegeben.
- **active:** Im normalen Skill-Loader.
- **deprecated:** Warnung bei Nutzung, noch ladbar.
- **disabled:** Nicht ladbar, bleibt zur Forensik.

### 5.2 Review-Gate
- Diff vorher/nachher als Side-by-Side in der GUI
- Yannik-Signatur (lokaler Ed25519-Key in Keyring) → Audit-Log
- Bei `customer-confidential`-Touchpoint: zusätzlicher Confirm

### 5.3 Sandbox
- Quarantined-Skills laufen in eigenem Process mit:
  - kein Filesystem-Schreibzugriff außer `<sandbox>/`
  - keine Netzwerk-Calls außer explicit-allowlist
  - kein Zugriff auf `customer-confidential`-Notes
  - Timeout 30s pro Tool-Call

## 6. MSP-Bridges (im Monorepo unter `src/domains/msp-bridges/`)

> Der ADR-0030-Plan eines separaten privaten Repos `claude-os-msp` wurde nicht ausgeführt — alle Bridges leben im Monorepo (ADR-0030-Amendment offen).

### 6.1 Read-Only-Phase (Phase 6)
- Pro Bridge: dedizierter Read-Only-Service-Account
- Schema-Validation jeder API-Response (TypeBox)
- Audit-Log-Eintrag pro Call
- Rate-Limiting pro Bridge (Default: 60 Calls/min)
- **Kein Cache von Customer-Daten im Vault** — Bridge-Results sind ephemeral, nur in laufender Session

### 6.2 Write-Phase (Phase 7) — Approval-Gate
Vor jeder Write-Operation:
1. Dry-Run gegen API (wenn unterstützt) oder Schema-Validation
2. User-Approval-Prompt in GUI mit Diff-Anzeige
3. Approval-Token in Audit-Log + Yannik-Signatur
4. Erst dann tatsächlicher Write
5. Rollback-Token zurückgeben (TANSS: ja, NinjaOne: teilweise)

### 6.3 Tenant-Isolation (verzahnt mit Vault-Workspaces)
- Jeder Customer hat eigenen Workspace: `workspaces/msp-customers/<customer-id>/`
- Vault-Notes mit `tenant: <customer-id>`-Frontmatter (zusätzlich zu `workspace`)
- Bridge-Calls signen mit Tenant-Header
- Memory-Injection filtert per Workspace + Tenant — **niemals Cross-Tenant-Recall**
- FTS-Query enthält `WHERE workspace = ? AND tenant = ?` immer

### 6.4 DSGVO
- Recht auf Löschung: CLI-Command, der alle Notes mit `tenant: <customer-id>` löscht
- Datenschutz-Folgenabschätzung (DSFA) als Doku-Pflicht vor Phase 6-Go-Live
- Auftragsverarbeitungs-Vertrag (AVV) mit Anthropic prüfen (US-Provider, EU-DPF-Status)

### 6.5 Bekannte Trust-Boundaries & offene Härtungspunkte (Audit 2026-05-31)

**(a) `customer.yaml` ist ein operator-vertrautes Artefakt — SSRF-Grenze.**
Die Bridges bauen ausgehende Requests aus `customer.yaml`-/ENV-Werten (Sophos `firewallHostname`, Veeam `serverHostname`, TANSS `serverUrl`, NinjaOne `baseUrl`). Das Schema validiert Port + non-empty, aber **nicht den Host** (keine Allowlist, kein Block von Link-Local/Metadata/RFC1918-IPs). Heute unkritisch: wer `customer.yaml` editieren darf, kontrolliert ohnehin den Host-Prozess — keine Trust-Grenze wird überschritten. **Sobald** `customer.yaml`-Authorship an weniger vertraute Tenants delegiert wird (Admin-/API-Surface), MUSS Host-Validierung in `msp-customers/schema.ts` (`readVeeam`/`readSophos`/…) ergänzt werden: IP-Literale in `169.254/16`, `127/8`, `::1`, `10/8`, `172.16-31`, `192.168/16` ablehnen, außer explizit allowlisted. Bis dahin gilt: **`customer.yaml` = trusted operator artifact.**

**(b) Bearer-Token via Query-String für SSE/WS — Log-Leak-Fläche.**
`/api/events` (SSE) und `/api/pty/ws` (WebSocket) akzeptieren das Bearer-Token via `?token=`, weil Browser-`EventSource`/`WebSocket` keine Auth-Header setzen können. Query-Strings landen in Reverse-Proxy-/Access-Logs, Browser-History und `Referer`. Mitigation: Token sind session-scoped + rotierbar (Env-Restart); `?token=` in nginx/Cloudflare aus Access-Logs scrubben. **Ziel-Härtung:** kurzlebiges Single-Use Connect-Ticket (per header-authentifiziertem POST gemintet) statt des echten Bearers im Query. **Funktionslücke (zu tracken):** der Cookie-Auth-Hook (Multi-User Stage 2) implementiert den Query-Token-Fallback NICHT — unter Cookie-Modus wird eine `?token=`-SSE/WS-Verbindung ohne gültige Session-Cookie abgewiesen; im Cookie-Modus muss die Session-Cookie getragen werden.

## 7. Workspace-Skills-Schutz

User-Skills in `workspace/skills/` sind **heilig**:
- Kein Auto-Update ohne explizite User-Approval
- Kein Auto-Delete
- Bei Konflikt-Update: zweite Variante anlegen (`<name>-v2/`), nicht überschreiben
- Backup-Pfad in `<vault>/.claude-os/skills-backup/`

## 8. Verify-Bei-Bedrohung-Checkliste

Bei jedem PR mit Berührung dieser Pfade läuft der Check:
- [ ] `src/domains/*-bridge/` → Audit-Log-Eintrag erzeugt?
- [ ] `src/sidecar/`, `src/mcp/` → Tool-Call-Schema validiert?
- [ ] `vault-sync/` → Classification respektiert? Redaction-Hook getriggert?
- [ ] Workspace-Filter in jeder FTS-Query? (Cross-Tenant-Guard)
- [ ] `skills/` → Sandbox-Lifecycle korrekt?
- [ ] Provider-Calls → Modell-ID config-driven (nicht hardcoded)?

## 9. Incident-Response

- **Suspected secret leak:** Token im OS-Keyring revoken, neuer Token, Audit-Log auf Zugriff prüfen, Yannik-Notify
- **Suspected prompt injection:** Quelle (Note/API-Response) klassifizieren, Skill quarantänisieren, Lessons-Eintrag
- **Suspected MSP-write fail:** Rollback-Token verwenden, Customer notify (bei tatsächlichem Daten-Impact)
- **Suspected cross-tenant leak:** sofort Workspace-Filter prüfen, betroffene Memory-Notes auf `quarantined`-Status, Yannik-Notify

Jeder Incident: Eintrag in `tasks/incidents/YYYY-MM-DD-<slug>.md`.

## 10. Was hier nicht steht (aber wichtig)

- Penetration-Testing-Plan
- Backup-Recovery-Drills
- Onboarding/Offboarding-Checkliste (wenn Claude OS jemals jenseits von Yannik genutzt wird)

Diese werden bei Bedarf in `tasks/adr/` als ADR ergänzt.
