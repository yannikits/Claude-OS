# Phase 7-F+ — MSP-Operations-Cockpit (Plan)

Erstellt 2026-05-30 nach `/grill-me`-Interview (8 Architektur-Entscheidungen).
Status: **Plan, wartet auf Abnahme.** Noch kein Code.

Phasen-Plan im Muster von `tasks/phase-server-web.md`. Sub-Phasen sind mit `MC-x`
(MSP-Cockpit) bezeichnet, um die Kollision mit ROADMAP-Phase 8 (GUI-Polish, deprioritisiert)
zu vermeiden. Logisch ist das die Fortsetzung von ROADMAP Phase 7 (MSP-Bridges Write, ADR-0027).
Bei Abnahme werden die Sub-Phasen einzeln (stacked PRs) umgesetzt, jede mit DoD-Check.

## Kontext / Ausgangslage

Das MSP-Health-Dashboard existiert heute als **Read-only-Übersicht** (Phase 7-E, v1.9.4):
React-UI (`gui/src/pages/msp-health.tsx`), Aggregator (`src/domains/msp-aggregate/`),
4 Read-Bridges (`src/domains/msp-bridges/{tanss,veeam,sophos,securepoint}`),
Fastify-Server + Multi-User-Auth + Admin-Gate (`CLAUDE_OS_ADMIN_EMAILS`), Docker-Deployment.

Der Pivot ("zentrale Arbeitsumgebung für die Firma") ist daher **kein Greenfield**, sondern
zwei neue Capabilities auf der bestehenden Read-Basis plus eine fehlende Bridge:
1. **Automations-Engine** (Wenn-Dann, neu — der riskanteste Teil)
2. **Write-Actions** gegen Kundensysteme (TANSS-Tickets, Ninja-Scripts — Phase-7-Write per ADR-0027)
3. **NinjaOne-Read-Bridge** (fehlt komplett)

## Architektur-Entscheidungen (aus dem Interview)

| # | Zweig | Entscheidung |
|---|-------|-------------|
| 1 | Identität | Claude OS bleibt; MSP-Cockpit wird Flaggschiff-Modul, AI-/Memory-Schicht bleibt Kern |
| 2 | Nutzer | Echtes RBAC: **Viewer / Operator / Admin** (Abweichung von Empfehlung — bewusst gewählt) |
| 3 | Engine-Logik | Hybrid: deterministische Regeln + Claude nur Read/Suggest. **LLM löst NIE autonom eine Write-Action aus.** |
| 4 | Trigger | Polling gegen Read-Bridges zuerst; Inbound-Webhooks als späteres Ziel |
| 5a | Ausführung | Nur über Vendor-APIs (Ninja-Script-API etc.); claude-os shellt NIE selbst auf Kundengeräten |
| 5b | Freigabe | Default = Approval-Queue; Admin kann einzelne Regeln auf Auto scharfschalten (Allowlist pro Regel) |
| 6 | TANSS-Write | Kommentar zuerst → dann Status/Zuweisung; endgültiges Schließen bleibt Approval-pflichtig |
| 7 | NinjaOne | Engine zuerst gegen die 4 vorhandenen Bridges, Ninja danach als Datenquelle |
| 8 | Regeln | YAML im Vault (git-versioniert) zuerst; UI-Editor darüber als Ziel |

## Repo-Verortung (geklärt)

Monorepo `yannikits/Claude-OS`. Die Bridges sind direkt hier committed (Phase 7-C/D), **kein**
separates `claude-os-msp`. `ARCHITECTURE.md` §2 (Public/Private-Split, ADR-0030) ist insoweit
**veraltet**. Neuer Engine-/Write-Code kommt in dieses Repo unter `src/domains/`.

- [x] **Doc-Fix vorab (ARCHITECTURE.md):** §2 mit Drift-Hinweis "monorepo, Split nicht ausgeführt" versehen (erledigt 2026-05-30).
- [ ] **ADR-0030-Amendment:** formaler Superseding-/Status-Block im ADR selbst (separat, noch offen).

## Security-Leitplanken (gelten für ALLE Write-Phasen)

- ADR-0027: MSP-Write nur mit Approval-Gate, Rollback-Pfad, Tenant-Isolation-Test grün.
- ARCH §7: MSP-API-Responses sind **untrusted** — vor jeder Regel-Auswertung validieren.
- Prompt-Injection-Schutz: ein von Claude (Suggest) erzeugter Output darf nie direkt eine
  Write-Action parametrisieren ohne deterministische Zwischenschicht + Audit.
- Jede Write-Action: Audit-Log-Eintrag (`src/core/audit/`) mit User-Identität, Tenant, Vorher/Nachher.

---

## Phase MC-A — RBAC-Fundament

Vorbedingung für alles Write/Arm. Erweitert die bestehende Multi-User-Auth um Rollen.

- [x] Rollen-Modell `viewer | operator | admin` im User-Domain (`src/domains/users/types.ts`) — PR #242 (`d83859c`)
- [x] Migration: bestehende `CLAUDE_OS_ADMIN_EMAILS` → Rolle `admin` (kein Bruch); additive Schema-v1→v2-Migration (`role`-Spalte) — PR #242
- [x] Route-Guard-Middleware: `requireRole(role)` im Fastify-Layer (`src/server/rbac.ts`, `effectiveRole = max(db-role, allowlist-admin)`) — PR #242 (`9d1c1f8`, `f456a3c`)
- [x] UI: Rolle im Session-State (`/auth/me` liefert `role`), gated Buttons — PR #242
- [x] Audit: Rollenänderung wird geloggt — `admin.user.role` mit `oldRole`/`newRole` (dieser Branch)
- [x] **Lücken-Fix (2026-05-31):** Rollen-*Vergabe* verdrahtet — `setRole()` war geshippt aber von keiner Route/CLI aufgerufen (operator-Rolle unerreichbar). Neu: `POST /api/admin/users/:idOrEmail/role` (admin-gated, before/after-Audit) + `claude-os users role <id|email> <role>` + Rolle in beiden Listen-Ausgaben (HTTP `safe()` + CLI). +8 Route-Tests, Suite 2079 grün.

**DoD:** Viewer kann nur lesen, Operator kann Write-Actions auslösen (in Approval-Queue),
nur Admin kann Regeln scharfschalten + Rollen vergeben. Tests grün, tsc+biome clean. **Status: erfüllt.**

**Offen (separater Task, NICHT MC-A):** Es gibt heute *keine* GUI-Admin-User-Management-Seite —
`create/disable/enable/reset-password/role` sind allesamt headless (HTTP + `claude-os users …` CLI).
Eine GUI-Seite nur für Rollen zu bauen wäre inkonsistent; das gesamte User-Management gehört in
eine eigene Admin-Seite (eigener Task, falls gewünscht).

## Phase MC-B — Engine-Core (read-only Aktionen)

Kann parallel zu MC-A starten (keine Write-Abhängigkeit). Das architektonische Herzstück.

- [x] `src/domains/automation/` Domain angelegt: Schema + Loader + State-Diff + Evaluator (Commits 448aa70, e3f0cc0, + dieser)
- [x] YAML-Rules-Schema (TypeBox): `trigger` (bridge+customers), `condition` (statusIn), `actions` (v1 non-write), `armed` — TDD, 8 Tests grün (2026-05-30)
- [x] Rules-Loader liest `rules/*.yaml`, parst + validiert, resilient (Issues sammeln statt werfen) — `loadRules(dir)` + 6 Tests grün. rulesDir server-seitig `<vault>/Claude-OS/automation/rules`.
- [x] Poll-Diff-Detektor: `diffSnapshots(prev, current)` (reine Funktion, baseline-safe, dynamische Bridge-Iteration) + 5 Tests grün.
- [x] Regel-Evaluator: `evaluateRules(rules, changes)` (reine Funktion: Trigger/Customer/Status-Match → FiredAction[]) + 6 Tests grün.
- [x] Engine-Runner `startAutomationEngine` (Tick-Loop, hält prev-Snapshot, reused Aggregator-Cache via `getSnapshot`, resilient) + 5 Tests; `dispatchFiredAction` routet nach Action-Typ + 3 Tests.
- [x] Nur ungefährliche Aktionen: Schema erlaubt v1 ausschließlich `dashboard-alert`, `notify`, `audit-log` (kein Write nach außen)
- [x] Verdrahtung: Server bootet Engine in `startBackgroundServices` (nur wenn Aggregator + Vault da); Sink: `automation://alert`-SSE bzw. Audit-Log. tsc/biome/Suite grün (2017 passed).
- [x] UI: read-only `AutomationPage` (`gui/src/pages/automation.tsx`) — Aktive Regeln + Letzte Auslösungen, admin-gated, Polling via useAutoRefresh; rpc-Helper + Nav/Route in App.tsx. tsc -b + vite-Build grün.
- [ ] Sidecar/Desktop-Boot der Engine (heute nur Server-Variante) — später

**MC-B abgeschlossen (2026-05-30):** Engine-Kern + Wiring + read-only UI + End-to-End-Integrationstest. Backend-Suite 2026 passed. Der Pipeline-Test (`tests/server/automation-pipeline.test.ts`) komponiert die echten Teile wie der Server (loadRules → Aggregator/Prober → diff → evaluate → dispatch → NotificationBus) und beweist deterministisch, dass eine echte Bridge-Transition ein `automation://alert` feuert. Offen nur Sidecar-Boot + spätere Phasen (MC-C ff.). Hinweis: gui-Vitest-Suite hat pre-existing Rot (30 unrelated Failures) — eigener Cleanup-Task.

**DoD:** Eine YAML-Regel "Sophos offline → dashboard-alert" feuert real bei Zustandswechsel,
sichtbar im UI, im Audit-Log. Tests decken Trigger/Condition/Dispatch + Failure-Modi ab.

## Phase MC-C — Erste Write-Action: TANSS-Kommentar

Validiert den kompletten Write+Approval+Audit-Pfad am sichersten Fall.
**Vorbedingung:** TANSS-Read muss stabil sein (`probe tanss` läuft sauber — aktuell noch offen).

- [ ] TANSS-Write-Client: `POST` Kommentar/Notiz an bestehendes Ticket (API verifizieren)
- [ ] Approval-Queue-Domain: Pending-Action → Operator/Admin gibt im UI frei → Ausführung
- [ ] Rollback/Idempotenz: Doppel-Submit-Schutz, Audit Vorher/Nachher
- [ ] Engine-Action `tanss-comment` (geht standardmäßig in Approval-Queue)
- [ ] UI: Approval-Queue-Ansicht mit Freigeben/Verwerfen

**DoD:** Eine Regel kann einen TANSS-Kommentar in die Queue legen, ein Operator gibt frei,
Kommentar erscheint im echten Ticket, Audit vollständig. Tenant-Isolation-Test grün.

## Phase MC-D — Claude-in-the-loop (Suggest)

Claude in Read/Suggest-Rolle — nie Write.

- [ ] Engine-Action `claude-analyze`: Alert/Ticket-Kontext → Claude-Bridge → Vorschlagstext
- [ ] Vorschlag landet als `tanss-comment` (über denselben Approval-Pfad aus MC-C)
- [ ] Harte Grenze im Code: `claude-analyze` darf ausschließlich Text produzieren, nie
      Action-Parameter für Write setzen (deterministische Zwischenschicht)
- [ ] Untrusted-Input-Handling: Ticket-Text wird vor Claude-Prompt als untrusted markiert

**DoD:** Regel "neues Ticket Prio hoch → Claude erstellt Triage-Vorschlag als Kommentar-Entwurf
in Approval-Queue". Kein Pfad, über den Claude-Output autonom schreibt. Tests beweisen die Grenze.

## Phase MC-E — Auto-Arm (Allowlist pro Regel)

- [ ] Regel-Feld `armed` durch Admin im UI scharfschaltbar (RBAC aus MC-A)
- [ ] Armed-Regeln überspringen die Approval-Queue, laufen direkt + Audit
- [ ] Arm-/Disarm-Vorgang wird geloggt (wer, wann, welche Regel)
- [ ] UI-Warnung beim Scharfschalten irreversibler Aktionen

**DoD:** Admin armt "Veeam-Job failed → TANSS-Kommentar", die läuft danach ohne Klick;
Operator kann nicht armen; alles im Audit. Tests grün.

## Phase MC-F — NinjaOne-Bridge + Script-Action

- [ ] Ninja-Read-Bridge nach Muster Veeam (`src/domains/msp-bridges/ninja/`), ADR-0038-Contract
- [ ] Ins Dashboard + Aggregator integrieren (neue Spalte)
- [ ] Engine-Datenquelle: Ninja-Alerts pollbar
- [ ] Ninja-Write-Action `ninja-run-script`: triggert ein in Ninja hinterlegtes, freigegebenes
      Script via Ninja-API (claude-os shellt NICHT selbst)
- [ ] Action default in Approval-Queue; armbar per MC-E

**DoD:** "Ninja Disk > 90% auf Tag `server` → run-script `cleanup-temp`" funktioniert end-to-end
über die Ninja-API, mit Approval bzw. armed. Tests grün.

## Phase MC-G — TANSS-Write Stufe 2 (Status / Zuweisung)

- [ ] TANSS-Write-Client erweitern: Status setzen, Techniker zuweisen, Ticket erstellen
- [ ] Endgültiges Schließen bleibt **immer** approval-pflichtig (nicht armbar)
- [ ] Reversibilitäts-Hinweis im UI

**DoD:** Operator kann via UI/Regel Status ändern + zuweisen (Queue/armed je nach Regel),
Schließen erzwingt Approval. Tenant-Isolation grün.

## Phase MC-H — Inbound-Webhooks (Echtzeit, eigenes Security-Review)

- [ ] Endpoint `/api/hooks/{vendor}` mit Signatur-Verifikation pro Quelle
- [ ] Rate-Limit + Replay-Schutz (Nonce/Timestamp)
- [ ] Webhook-Event → selbe Engine wie Polling (kein Doppel-Pfad)
- [ ] Codex-Adversarial-Review des Endpoints (untrusted Inbound, three-brain)

**DoD:** Ninja-Webhook löst Regel in Echtzeit aus; ungültige Signatur wird abgewiesen + geloggt;
Security-Review dokumentiert.

## Phase MC-I — UI-Regel-Builder über YAML

- [ ] Formular-Editor (Trigger-Dropdown → Condition → Action → Arm) im Dashboard
- [ ] Schreibt einen klar abgegrenzten `# managed`-Block in die `rules/*.yaml` (round-trip-sicher)
- [ ] git-Versionierung bleibt Source-of-Truth; UI ist nur Editor
- [ ] RBAC: nur Admin/Operator je nach Aktion

**DoD:** Eine Regel ist komplett im UI erstellbar, landet als YAML im Vault, ist git-diffbar,
und die Engine lädt sie ohne Neustart.

---

## Reihenfolge & Abhängigkeiten

```
MC-A (RBAC) ─────────────┐
MC-B (Engine read-only) ─┼─> MC-C (TANSS-Kommentar) ─> MC-D (Claude-Suggest) ─> MC-E (Auto-Arm)
                         │                                                         │
                         └────────────────────────────────────────> MC-F (Ninja) ─┤
                                                                      MC-G (TANSS Stufe2) ─┤
                                                                      MC-H (Webhooks) ─> MC-I (UI-Builder)
```

MC-A und MC-B parallel möglich. MC-C gated auf stabilen TANSS-Read. Alles Write gated auf MC-A.

## Top-Risiken

1. **Prompt-Injection über Ticket-/Alert-Text** → Hard-Line "Claude schreibt nie autonom" (MC-D) + untrusted-Markierung.
2. **TANSS-API-Unklarheit** → MC-C blockiert bis Read stabil; Write-Endpoints real verifizieren, nicht annehmen.
3. **Webhook-Angriffsfläche** → bewusst nach hinten (MC-H) mit eigenem Security-Review.
4. **Scope-Creep RBAC** → 3 feste Rollen, kein generisches Permission-System (YAGNI).
5. **YAML-Round-Trip im UI** (MC-I) → nur `# managed`-Block schreiben, Rest unangetastet.

## Review-Sektion

(wird je Phase nach Abschluss ergänzt)
