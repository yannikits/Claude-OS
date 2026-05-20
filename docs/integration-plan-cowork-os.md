# Integrationsplan — "Claude Cowork OS"-Video

**Quelle:** `~/Downloads/My Claude Cowork OS Just Changed How I Work Forever....mp4` (~171 MB)
**Video-Author:** Brock Mesarich / "AI for Non-Techies"
**Analyse:** Gemini 2.5 (timestamped frame-by-frame), siehe [`three-brain-out/2026-05-20-cowork-os/gemini-analysis.md`](../three-brain-out/2026-05-20-cowork-os/gemini-analysis.md)
**Datum:** 2026-05-20

## Was wird im Video gezeigt?

Brock demonstriert ein Setup das er "Claude Cowork OS" nennt — Claude Desktop wird statt als Chatbot als persistentes Dashboard genutzt. Konkret:

- **[00:00–04:20]** Vision: "Stop Chatting, Start Operating" — Claude als zentrale Steuereinheit
- **[00:43]** Live-Dashboard mit 3 Sektionen: "Top 3 Signals" (Inbox-Alerts), "Revenue & Goals" (Stripe), "Content Pipeline" (Notion)
- **[04:20]** Architektur-Diagramm: "App Fatigue" / "Context Switch Penalty" als Grund-Motivation
- **[05:30]** 3-Layer-Modell: External APIs → MCP → Claude Cowork → Live HTML-Artifacts
- **[06:40]** Drei Schlüssel-Features genannt: Connectors (MCP), Live Artifacts, Scheduled Tasks
- **[13:30~]** Slash-Command-Demo: `/schedule "Every morning at 8 AM, scan my emails and update the dashboard"`
- **[19:10]** Mobile-Dispatch: QR-Code-Pairing, Sprachnachrichten von iPhone an Desktop-Operator
- **[20:01]** Fazit + Limitierungen (Token-Kosten, Desktop-App-Voraussetzung)

## Die 5 Hauptfeatures aus Sicht der Gemini-Analyse

1. **Natives MCP-Management (Connectors)** — direkte Verbindung zu lokalen Tools + Cloud
2. **Persistent Live Dashboards (HTML-Artifacts)** — visueller Status-Screen mit Background-Update
3. **Background Scheduler (`/schedule`)** — cron-artige proaktive Reports
4. **Remote Dispatch (Mobile-Desktop-Sync)** — Workflow-Trigger aus dem Mobile-Kontext
5. **Multi-Step Autonomous Operator** — agentic loop mit Programm-Öffnen, Datei-Lesen, Calendar-Setzen

## Integrationsbewertung für claude-os

Die Bewertung folgt der "Senior Developer"-Rolle: was ist Mehrwert × Aufwand sinnvoll für v1.x, was sollte v2+ bleiben.

### Feature 1 — Native MCP-Management (Connectors)

| Aspekt | Status |
|---|---|
| **Im Video** | UI in Claude Desktop wo MCP-Server angeklickt, aktiviert, konfiguriert werden |
| **Bei uns heute** | **claude-os IST bereits ein MCP-Server** (v1.4, ADR-0016). Die andere Richtung — claude-os als MCP-**Client** für externe MCP-Server — ist NICHT implementiert. Externe MCP-Server sind in `claude_desktop_config.json` (Anthropic) händisch eintragbar. |
| **Mehrwert für v1.5** | Hoch — passt zum bestehenden Catalog-System: `catalog install mcp:filesystem-mcp` + Settings-View könnte Live-Status der konfigurierten MCP-Server anzeigen |
| **Aufwand** | Mittel — neue Domain `mcp-clients/`, Health-Check-Loop, Settings-UI-Erweiterung. ~3-5 Tage |
| **Akzeptanzkriterien** | (a) `catalog install mcp:<name>` ergänzt MCP-Eintrag in `mcp.json`; (b) Settings-View listet alle registrierten MCPs mit Live-Status (running/exited/error); (c) Click auf "Restart" startet den Server neu |
| **Entscheidung** | **JA — v1.5 Track** wenn PR #32 (Phase 5o) gemerged ist. Baut auf MCP-Tool-Manifest + Catalog. Eigene Phase. |

### Feature 2 — Persistent Live Dashboards (HTML-Artifacts)

| Aspekt | Status |
|---|---|
| **Im Video** | Claude rendert HTML-Karten mit live-aktualisierten KPIs (Umsatz, Termine, Content-Status); Background-Update über MCP-Konnektoren |
| **Bei uns heute** | Dashboard.tsx zeigt `ping/catalog-count/vault-config/agent-count` — **read-only Snapshot**. Keine Custom-HTML-Artifacts, kein Live-Update. |
| **Mehrwert für v1.5** | Mittel-Hoch — vereinfacht den "Wo stehe ich gerade?"-Use-Case enorm. Aber tiefe Integration verlangt MCP-Client-Infrastruktur (Feature 1) als Prereq |
| **Aufwand** | Mittel — `sidecar/artifacts.ts` Domain für persistente HTML-Snippets, RPC `artifacts.list/get/update/delete`, GUI-Renderer mit iframe-Sandbox. ~4-6 Tage |
| **Akzeptanzkriterien** | (a) User definiert ein "Dashboard-Artifact" via CLI (HTML + Update-Interval); (b) Sidecar erneuert es alle N Sekunden via konfigurierten MCP-Client; (c) GUI rendert es im Dashboard-Tab unter dem heutigen Status-Karten-Block |
| **Entscheidung** | **TEILWEISE — v1.6 Track**. Kleines Subset für v1.5 wäre: ein Status-Card-Widget-System (statisch-konfigurierbare Karten unter den bestehenden 4 Cards), kein full-HTML-Artifact-Rendering. Volles Feature ist v2-Material wegen iframe-Sandboxing-Security |

### Feature 3 — Background Scheduler (`/schedule`)

| Aspekt | Status |
|---|---|
| **Im Video** | Slash-Command in Claude Desktop: `/schedule "<natural-language-task>"` parses + plant das + speichert es im OS |
| **Bei uns heute** | Vault-Scheduler (Phase 2d) hat idle-detection via chokidar. Cron-style time-based Scheduling existiert nicht. |
| **Mehrwert für v1.5** | Hoch — proaktive Tasks (nightly memory-sync, weekly-vault-snapshot) wären sehr nützlich. Cron-Verwandter Code ist klein. |
| **Aufwand** | Klein-Mittel — `domains/scheduler/` mit cron-Parsing + tickloop. CLI `claude-os schedule add/list/remove`. ~2-3 Tage |
| **Akzeptanzkriterien** | (a) `claude-os schedule add --cron "0 8 * * *" --command "memory sync"` → persistent in `<dataDir>/schedules.json`; (b) Sidecar führt fällige Tasks aus; (c) `schedule list` zeigt nächste Ausführung; (d) Fehlerprotokollierung wenn Task fehlschlägt; (e) Tests für Cron-Parser, Idempotenz, Skip-bei-Doppelläufen |
| **Entscheidung** | **JA — v1.6 Track** als eigene Phase. Pre-Spike: cron-Library evaluieren (`cron-parser` ist mature, MIT) |

### Feature 4 — Remote Dispatch (Mobile-Desktop-Sync)

| Aspekt | Status |
|---|---|
| **Im Video** | iPhone scannt QR-Code → mobile Claude-App pairt mit Desktop-Operator → Sprachnachrichten triggern Workflows remote |
| **Bei uns heute** | Kein HTTP/SSE-Transport am Sidecar. Stdio-only. Kein Mobile-Pairing. |
| **Mehrwert für v1.5** | Niedrig-Mittel — sehr nützlich, aber Solo-Dev und v1-Cloud-Mount-Setup deckt das Mobile-Bedürfnis primär über OneDrive-Sync ab |
| **Aufwand** | **Hoch** — HTTP-Transport im MCP-Server (geplant deferred per ADR-0016), Token-Pairing-Layer, Mobile-Companion-App (eigenes Tauri-Projekt oder Native iOS/Android). ≥ 4 Wochen |
| **Akzeptanzkriterien** | (-) |
| **Entscheidung** | **NEIN — v2+ Track**. Begründung: hoher Aufwand, niedrige Solo-User-Priorität, externe Dependencies (Mobile-Distribution, Apple-Dev-Account-bereits-für-v1.3-blockiert). Notiert in `tasks/todo.md` v2-Section |

### Feature 5 — Multi-Step Autonomous Operator

| Aspekt | Status |
|---|---|
| **Im Video** | Claude öffnet selbständig Programme, liest E-Mails, setzt Kalendereinträge — multi-step agentic loop |
| **Bei uns heute** | Chat-View kann `claude.exe` spawnen, aber kein dedizierter "Operator-Mode". Anthropic's Claude Code ist selbst der Operator. |
| **Mehrwert für v1.5** | Mittel — das ist eher Anthropic's Job (Claude Code Agent-Mode) als unser. Wir orchestrieren weniger, sondern stellen das OS unter ihm. |
| **Aufwand** | **Sehr Hoch** — eigene Agent-Loop-Engine wäre Reinventing-the-Wheel gegen Claude Code |
| **Akzeptanzkriterien** | (-) |
| **Entscheidung** | **NEIN — permanent out-of-scope**. claude-os bleibt das Substrate (Catalog, Vault, MCP, Settings) unter dem Claude Code als Operator läuft. Kein eigener Agent-Loop. |

## Was wird in v1.5 sofort umgesetzt?

**Nichts in dieser Session** — aus Disziplin. Alle Features brauchen eigene Branches, eigene Tests, eigene ADRs. Diese Session shipt nur die **Roadmap-Aufnahme**:

- [x] `docs/integration-plan-cowork-os.md` (diese Datei) — Plan steht
- [ ] Feature 1 (MCP-Client + UI) → wird neue Phase nach PR #32 Merge
- [ ] Feature 3 (Background Scheduler) → wird neue Phase parallel zu Feature 1 möglich
- [ ] `tasks/todo.md` v1.5+-Section aktualisieren mit den zwei neuen Phasen
- [ ] Feature 2 → v1.6 mit Mini-Vorstufe (Custom Status Cards) als Ausschnitt
- [ ] Feature 4 → v2-Roadmap
- [ ] Feature 5 → permanent out-of-scope

## Honest Disclosure

Die Video-Analyse selbst hatte Rate-Limit-Issues mit dem Gemini-API (gemini-3-flash-preview "No capacity") und brauchte ~15 Retry-Loops. Der finale Output ist trotzdem hochwertig und transcript-frei (Gemini hat das Video direkt gesehen, nicht nur die Tonspur).

Was diese Auswertung NICHT enthält:

- Exakte Code-Snippets aus dem Video (nicht gezeigt im Output — nur UI/Workflow)
- Spezifische MCP-Server-Namen die Brock konfiguriert hat (nicht erwähnt im Output)
- Tonalität / Pacing des Videos (Gemini fokussierte auf Features, nicht auf Style)

Bei Bedarf einer detaillierteren Analyse: lokales ffmpeg installieren, Audio extrahieren, separater Whisper-Run für vollständiges Transkript. Aktuell verschoben weil Mehrwert nicht klar.

## Referenzen

- Video-Analyse: [`three-brain-out/2026-05-20-cowork-os/gemini-analysis.md`](../three-brain-out/2026-05-20-cowork-os/gemini-analysis.md)
- ADR-0016 — v1.4 MCP-Single-Server-Bridge (relevant für Feature 1)
- `tasks/todo.md` v1.5+-Roadmap (wird ergänzt um die neuen Features)
