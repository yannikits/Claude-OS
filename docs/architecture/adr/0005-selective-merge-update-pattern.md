# ADR-0005 — Selective-Merge-Update-Pattern (claudesidian-inspiriert)

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Entscheidung getroffen durch:** Analyse des [claudesidian](https://github.com/heyitsnoah/claudesidian) Starter-Kits

## Kontext

Das Tiered-Update-Modell aus dem /grill-me (Entscheidung B10 = C) sagt: env-Repo und skills-Repo werden bei jedem Start automatisch gepullt; Plugins/npm nur explizit. Was in der Architektur-Skizze fehlt: **wie genau** wird ein Skill-Update durchgeführt, ohne lokale Modifikationen zu zerstören?

Die ursprüngliche Idee in `tasks/todo.md` war eine `.skill-lock`-Datei: gelockte Skills bleiben unangetastet. Das löst das Problem **partial** — es schützt vor Überschreiben, lässt aber keinen Weg, lokale Anpassungen mit Upstream-Verbesserungen zu kombinieren ("ich will den neuen Code, aber meine Customization behalten").

Claudesidian löst das gleiche Problem mit einem `/upgrade`-Pattern, das auf folgenden Prinzipien beruht:

1. **Timestamped Backup vor jeder Änderung** unter `.backup/upgrade-[timestamp]/`
2. **File-by-File Diff-Review** vor dem Übernehmen
3. **Trennung von System-Files** (commands, agents, scripts) **und Personal Content** (Notes, Vault-Folder) — nur System-Files werden gepatched
4. **Resumable Checklist** (`.upgrade-checklist.md`) — Update kann unterbrochen und fortgesetzt werden
5. **Rollback-Pfad** aus dem Backup

Das ist eine ausgereifte Lösung, die wir nicht neu erfinden müssen.

## Entscheidung

`claude-os update --skills` und `claude-os update --plugins` implementieren ein **Selective-Merge-Pattern** mit den fünf claudesidian-Prinzipien:

### 1. Backup vor Update

```
%APPDATA%/claude-os/backups/update-<ISO-Timestamp>/
  ├── skills/         Snapshot aller Skills vor dem Merge
  ├── plugins/        Snapshot aller Plugin-Manifeste
  └── manifest.json   Welche Files in welchem Zustand
```

Backup-Retention: 5 jüngste Updates, ältere automatisch entfernt.

### 2. Drei-Zonen-Klassifikation pro Datei

| Zone | Was | Update-Verhalten |
|------|-----|------------------|
| **System** | Skills/Plugins/Commands aus dem Upstream-Repo | Wird via Diff-Review gepatched |
| **Personal** | User-Modifikationen, lokale Skills, Vault-Content | Wird **nie** angetastet |
| **Locked** | Per `.skill-lock`-Eintrag markiert | Wird **nie** angetastet, auch wenn System |

`.skill-lock` ist eine YAML-Datei pro Skill-Pack: `locked: [skill-name-1, skill-name-2]`.

### 3. File-by-File Diff-Review

`claude-os update --skills` läuft im interaktiven Modus:

```
[1/12] thinking-partner.skill.md
  Status: locally modified
  Upstream changes: + 23 lines, - 8 lines
  Action: (k)eep mine | (u)pgrade | (m)erge interactively | (s)kip | (d)iff
```

Mit `--auto-accept` werden nur "clean" Diffs (keine lokale Modifikation) automatisch übernommen; Konflikt-Files landen in einem Review-Queue-File.

### 4. Resumable Checklist

Während des Updates wird `%APPDATA%/claude-os/data/upgrade-checklist.<timestamp>.md` geschrieben. Bei Abbruch (Ctrl+C, Crash) kann `claude-os update --resume` das Update fortsetzen.

### 5. Rollback

`claude-os update --rollback <timestamp>` stellt den Stand aus dem benannten Backup wieder her. Default `claude-os update --rollback` ohne Argument verwendet das jüngste Backup.

## Konsequenzen

**Positiv**

- Lokale Skill-Modifikationen können sicher mit Upstream-Verbesserungen kombiniert werden
- Crash- oder Konflikt-Recovery ist trivial (Backup zurückspielen)
- User behält volle Kontrolle: kein Update findet ohne explizite Bestätigung statt (außer im `--auto-accept`-Modus für clean diffs)
- Pattern ist von einer Production-Codebase (claudesidian) erprobt — kein Greenfield-Design

**Negativ / Aufwand**

- Diff-Review-UI braucht eine TTY-Renderer-Library (z. B. `diff-cli-table`, `enquirer`)
- Backup-Verzeichnis kann mit der Zeit wachsen — Retention-Cron nötig
- Resumable-State-File muss atomar geschrieben werden (tempfile + rename) damit ein Crash mitten im Update keinen kaputten Checklist-State erzeugt
- `--auto-accept` muss konservativ sein: nur bei *unverändertem* lokalen Stand wird automatisch übernommen, sonst zwingend interaktiv

## Implementierungs-Constraints (`update-orchestrator`-Modul)

- `BackupManager` mit `.snapshot(scope)` / `.restore(timestamp)` / `.prune(retention=5)`
- `DiffEngine` baut auf `diff` (npm) auf, zeigt unified-diff im Terminal
- `ZoneClassifier` liest `.skill-lock` und Workspace-Markers (z. B. Frontmatter `claudeos: locked`)
- `ResumableChecklist` mit atomarem Write
- `claude-os update --skills/--plugins` ist die einzige API; intern shared zwischen Skill- und Plugin-Path

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **`.skill-lock` ohne Merge-Pfad** (ursprünglicher Plan) | Verworfen | Lockt Skills entweder voll oder gar nicht — keine partielle Modernisierung möglich |
| **Brachiales `git pull --ff-only` ohne User-Interaktion** | Verworfen | Bei jeder lokalen Änderung Konflikt → Update-Mechanismus de facto unbenutzbar |
| **Vollautomatischer Three-Way-Merge (wie `git merge`)** | Verworfen | Ohne UI-Layer in TTY-Terminal unzumutbar für Solo-Dev |

## Quellen

- [Claudesidian README — `/upgrade` Sektion](https://github.com/heyitsnoah/claudesidian#staying-updated-with-upgrade) — primäres Vorbild
- [Claudesidian Repo Structure](https://github.com/heyitsnoah/claudesidian) — Inspektions-Ziel im Mai 2026
- `diff` und `enquirer` npm packages als Build-Blocks

## Notiz

Diese ADR erweitert ADR-0003 (Hybrid-CLI) und ist die konkrete Implementierungs-Vorgabe für **Phase 4** in `tasks/todo.md`. Sie löst das in `tasks/todo.md` als MEDIUM gelistete Risiko "`iteenschmiede/claude-config` Auto-Pull überschreibt lokale Skill-Modifikationen".
