# ADR-0013 — Strukturiertes Logging mit pino

**Status:** Akzeptiert
**Datum:** 2026-05-16
**Bedingt durch:** ADR-0006 (Tauri-Sidecar-IPC), ADR-0011 (Auth-Integration), ADR-0004 (Secrets) + Researcher-Spike

## Kontext

claude-os braucht strukturiertes Logging im Node-Sidecar und in der CLI. Anforderungen:

1. **Secret-Redaction** — `.credentials.json`-Tokens (ADR-0011), API-Keys (ADR-0004) und Git-PATs dürfen NIEMALS in Log-Files landen, auch nicht im Debug-Modus
2. **File-Rotation** pro Maschine — Disk-Limits, Retention-fähig
3. **Tauri-Stderr-Mirror** — Sidecar-Stderr muss nach Renderer-Konsole gespiegelt werden (ADR-0006), damit Debugging in GUI-Modus möglich ist
4. **Non-blocking** auf Event-Loop — Long-Sessions in GUI dürfen nicht durch Log-Writes pausieren
5. **Strukturiert** — maschinenlesbare JSON-Logs für spätere Analyse, kein Free-Text

Researcher-Spike vom 2026-05-15 hat drei Kandidaten verglichen:

| Kriterium | pino v9.x | winston v3.x | bunyan |
|---|---|---|---|
| Throughput | ~115 ms / 10k ops | ~270 ms / 10k ops (5–8× langsamer) | ~377 ms / 10k ops |
| Native Redaction | ja (fast-redact, JSONPath) | nein, manuelle Format-Funktion | nein |
| File-Rotation | `pino-roll` (Worker-Thread, non-blocking) | `winston-daily-rotate-file` (synchron) | veraltet |
| Tauri-Stderr-Mirror | `pino.destination(2)` direkt | Custom Transport nötig | komplex |
| Production-Reife | 9M dl/Woche, aktiv | 15M dl/Woche, aktiv | Wartungsmodus seit ~2022 |

## Entscheidung

**pino v9.x** als Logger für alle Node-Prozesse (CLI, Sidecar, Hook-Subprozesse).

### Konfiguration

```ts
import pino from 'pino';

const logger = pino({
  level: process.env.CLAUDE_OS_LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      '*.password',
      '*.token',
      '*.apiKey',
      '*.accessToken',
      '*.refreshToken',
      'credentials.*',
      'auth.*',
      'env.ANTHROPIC_API_KEY',
      'env.CLAUDE_CODE_OAUTH_TOKEN',
      'env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
      'env.GITHUB_TOKEN',
      'env.OPENAI_API_KEY',
      'env.GEMINI_API_KEY'
    ],
    censor: '[REDACTED]'
  },
  transport: {
    targets: [
      {
        target: 'pino-roll',
        options: { file: logPath, frequency: 'daily', size: '10m', limit: { count: 30 } },
        level: 'info'
      },
      {
        target: 'pino/file',
        options: { destination: 2 },  // stderr für Tauri-Mirror
        level: 'warn'
      }
    ]
  }
});
```

### Log-File-Pfade (per ADR-0002)

- Sidecar: `%APPDATA%/claude-os/logs/sidecar-YYYY-MM-DD.log`
- CLI: `%APPDATA%/claude-os/logs/cli-YYYY-MM-DD.log`
- Auf macOS/Linux entsprechend `~/.config/claude-os/logs/`

### Redaction-Path-Liste

Zentral verwaltet in `src/core/logging/redact-paths.ts`. **Pflicht-Code-Review** bei jeder Änderung. Neue Domain-Felder, die Secrets enthalten könnten, müssen vor Merge gegen die Liste geprüft werden.

## Konsequenzen

**Positiv**

- Native Redaction → kein Risiko durch vergessene Format-Funktionen
- Async-Transport blockiert Event-Loop nicht, auch nicht bei vielen Logs pro Sekunde
- Stderr-Destination passt direkt zu ADR-0006-Sidecar-Pipe — kein Custom-Transport
- 5–8× Throughput vs. winston bei vergleichbarer Funktionalität
- Daily-Rotation mit `count: 30` löst Retention automatisch

**Negativ**

- Pino-Output ist JSON — für menschliches Lesen `pino-pretty` als Dev-Dependency nötig (`npm run logs`)
- `pino-roll` läuft in Worker-Thread → leichte Memory-Overhead pro Prozess
- Neue Redaction-Paths müssen aktiv gepflegt werden — Lücke = Leak-Risiko

## Constraints

- Logger ist Singleton pro Process (Sidecar / CLI / Tauri-Main je eigene Instanz; kein Cross-Process-Sharing)
- Redaction-Path-Liste hat Code-Review-Gate (`CODEOWNERS` für `src/core/logging/redact-paths.ts`)
- Log-Level steuerbar via `$CLAUDE_OS_LOG_LEVEL` Env-Var; Default `info`, Doctor warnt bei `debug` in Production-Modus (verhindert versehentliches Debug-Logging mit reduzierter Redaction-Aufmerksamkeit)
- Doctor prüft Log-Verzeichnis-Existenz + Schreibrechte beim Start
- Test-Suite muss Redaction-Tests enthalten: künstliches Secret in Object → Log-Output enthält `[REDACTED]`, nicht das Secret

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|---|---|---|
| **winston** | Verworfen | 5–8× langsamer, manuelle Redaction (fehleranfällig), synchrone File-Rotation |
| **bunyan** | Verworfen | Wartungsmodus seit ~2022, keine native Redaction |
| **console.log** | Verworfen | Keine Strukturierung, keine Redaction, keine Rotation — unprofessionell für Production |
| **pino + log-rotate-system-cron** | Verworfen | OS-Abhängigkeit, kein Cross-Platform — `pino-roll` löst das nativ |

## Quellen

- [Pino vs Winston in 2026 — PkgPulse](https://www.pkgpulse.com/guides/pino-vs-winston-2026)
- [Pino vs Winston — Better Stack](https://betterstack.com/community/guides/scaling-nodejs/pino-vs-winston/)
- [Best Node.js Logging Libraries 2026 — PkgPulse](https://www.pkgpulse.com/blog/best-nodejs-logging-libraries-2026)
- [pino fast-redact Dokumentation](https://github.com/pinojs/pino/blob/main/docs/redaction.md)

## Notiz

Phase 1 in `tasks/todo.md` enthält den pino-Setup-Spike inkl. Redaction-Path-Liste. Alle weiteren Phasen nutzen das zentrale Logger-Singleton via Constructor-Injection (kein globaler Import — Test-bar).
