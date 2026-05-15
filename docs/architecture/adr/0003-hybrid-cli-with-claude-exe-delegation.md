# ADR-0003 — Hybrid-CLI mit Delegation an Anthropic-`claude.exe`

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Entscheidung getroffen durch:** /grill-me Session

## Kontext

Claude Develop Environment OS braucht eine CLI-Komponente, die zwei sehr unterschiedliche Aufgabenklassen abdeckt:

1. **Projekt-Management** — Skills/Plugins/MCPs/Vault aus dem Terminal verwalten, Update-Mechanismus, Doctor, Auth-Status. Das sind Filesystem-, Git-, und Config-Operationen.
2. **AI-Interaktion** — Chat-Sessions, Streaming-Output, Plan-Mode, Tool-Use, Slash-Commands. Das ist eine ausgereifte Implementierung in Anthropics `claude.exe`-Binary, die im Repo bereits vorliegt (`bin/claude.exe`, 227 MB, Stand /grill-me Session).

Eine Eigenentwicklung der AI-Interaktions-Schicht würde Stream-JSON, Tool-Use-Protokoll, Auth-Refresh, Session-Persistence, Plan-Mode und Slash-Command-Routing re-implementieren — alles Dinge, die Anthropic bereits liefert und pflegt.

## Entscheidung

**Hybrid-CLI** mit klarer Verantwortungs-Trennung:

- Eigene CLI `claude-os` (Node + TypeScript + Commander.js) für **Projekt-Management**:
  - `claude-os doctor` — Self-Diagnose (Mount, Git, Auth, Plugins)
  - `claude-os update [--env|--skills|--plugins|--all]` — Tiered Updates
  - `claude-os vault [status|snapshot|push|schedule]`
  - `claude-os catalog [list|scan|enable|disable]` für Skills/Plugins/MCPs
  - `claude-os secrets [get|set|list|delete]`
  - `claude-os agent [list|show|replay]` für Agent-Runs
  - `claude-os auth [status|refresh]`
- Für AI-Interaktion: **Delegation** an `bin/claude.exe`:
  - `claude-os ai [...args]` reicht alle Argumente an `claude.exe` weiter, propagiert Exit-Code
  - Default-Aufruf `claude-os` ohne Subcommand = interaktive `claude.exe`-Session mit korrektem Env
  - Single-Source-Adapter im Modul `claude-bridge` (siehe Architektur-Entwurf), kein duplizierter Spawn-Code

## Konsequenzen

**Positiv**

- Keine Re-Implementation der AI-Interaktions-Schicht (Stream-JSON, Tool-Use, Slash-Commands, Plan-Mode bleiben in Anthropics Hand)
- Clear Separation of Concerns: Domain-Code in `claude-os` testbar ohne AI-Aufrufe
- Anthropic-Updates der `claude.exe` werden automatisch wirksam (Binary austauschen, nichts an der eigenen CLI ändern)
- Zwei CLIs nebeneinander auf dem `$PATH`: `claude` für Direkt-AI, `claude-os` für Environment-Management

**Negativ / Aufwand**

- Subprozess-Spawn-Lifecycle muss robust sein. Memory-IDs 569/577/578 zeigen, dass `claude.exe` 120-s-Timeouts hat (bestätigt durch claude-code-Issues #24481, #20527, #25629)
- Migration: `claude-os ai` ist nicht beliebig ersetzbar — wir hängen von Anthropic-CLI-Stabilität und CLI-Argument-Kompatibilität ab
- Ohne `bin/claude.exe` ist `claude-os ai` nicht funktional → Doctor muss das prüfen

## Implementierungs-Constraints (`claude-bridge`-Modul)

- Spawn via `child_process.spawn` mit explizitem `stdio: ['pipe', 'pipe', 'pipe']`
- Harter Wrapper-Timeout (Default 180 s, konfigurierbar), bei Überschreitung SIGTERM und nach 5 s SIGKILL
- Heartbeat-Logging alle 10 s während laufender Session
- Bei interaktiven Sessions (Stdin nötig): Übergang auf `node-pty` als optionalen Pfad
- `--mcp-config` minimal beim Spawn, um MCP-Init-Hang zu vermeiden (Upstream-Bug-Cluster)

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **Vollständige Eigenentwicklung der AI-CLI** | Verworfen | Reimplementiert Sessions, Streaming, Tool-Use, Plan-Mode — Wartungslast für Solo-Dev unverhältnismäßig |
| **Reiner Wrapper ohne eigene Subcommands** | Verworfen | Liefert nicht, was der Plan explizit fordert (Skills/MCPs/Vault terminal-verwaltbar) |
| **Zwei separate Binaries (env-cli + ai-cli) ohne gemeinsamen Entry-Point** | Verworfen | UX-Reibung: Nutzer muss zwei Tools merken; ein `claude-os` als Einstieg ist Standard |

## Quellen

- [claude-code Issue #24481 — CLI hängt auf simple queries](https://github.com/anthropics/claude-code/issues/24481)
- [claude-code Issue #20527 — 60s latency `--print` mode](https://github.com/anthropics/claude-code/issues/20527)
- [claude-code Issue #25629 — hängt nach result event in stream-json](https://github.com/anthropics/claude-code/issues/25629)
- Memory-IDs 569, 577, 578 — eigene Erfahrung mit `claude -p` 120s-Timeouts

## Notiz

Diese Entscheidung entspricht der ursprünglichen Grill-Wahl B6 = C (Hybrid) ohne Änderungen.
