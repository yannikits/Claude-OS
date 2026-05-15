# ADR-0002 — Cloud-Mount: nur Plain-Text, Git-Metadaten und SQLite extern

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Entscheidung getroffen durch:** /grill-me Session + Researcher-Validierung

## Kontext

Claude Develop Environment OS lebt aus einem provider-agnostischen Cloud-Mount, auflösbar via `$CLAUDE_OS_ROOT`-Env-Var (Default: OneDrive). Mehrere Maschinen sehen den selben Pfad, der Cloud-Sync-Client (OneDrive, rclone, Drive File Stream, Dropbox, …) hält ihn konsistent.

Ursprünglich (Grill B7 = D) sollte der Cloud-Mount alle Working-State-Daten enthalten — inklusive Obsidian-Vault mit eingebettetem Git-Working-Tree und einer SQLite-Datenbank für Agent-Runs.

Der Researcher-Spike hat zwei kritische Probleme aufgedeckt:

1. **`vault/.git/` in einem Cloud-Sync-Pfad führt zu Repo-Korruption.** Cloud-Sync arbeitet file-by-file und respektiert keine atomaren Git-Operationen. MS-eigene Community-Hub-Threads dokumentieren das Problem; Memory-ID S251 in unserem eigenen Verlauf bestätigt es (Branch-Mismatch-Bug nach Sync).
2. **SQLite im Cloud-Mount korrumpiert bei Multi-Machine-Zugriff.** SQLite-Locking nutzt POSIX advisory locks; Cloud-Sync-Clients ignorieren diese. Klassischer Fail-Modus: `disk image malformed`. Bestätigt in `abraunegg/onedrive#688`.

## Entscheidung

Wir teilen die Daten nach Sync-Sicherheit:

### Im Cloud-Mount (`$CLAUDE_OS_ROOT/`)

```
vault/**/*.md                                  Obsidian Markdown (plain text, append-only-friendly)
vault/agent-runs/<project>/<machineId>.jsonl   Agent-Run-Log als JSON-Lines, eine Datei pro Maschine
config/skills/                                 Skill-Definitionen (plain text)
config/plugins/                                Plugin-Manifeste (plain text)
config/mcp.json                                MCP-Server-Configs
config/cloud.json                              geteilte Anwendungskonfiguration
inbox/, outbox/                                Drop-Folder für Datenaustausch Host ↔ Umgebung
```

### Pro Maschine außerhalb des Mounts (`%APPDATA%/claude-os/` bzw. `~/.config/claude-os/`)

```
git-metadata/vault.git/                        Git-Metadaten via `git init --separate-git-dir`
data/agent-runs-index.sqlite                   Read-Cache, jederzeit aus den JSONL-Files rebuildable
logs/*.log                                     Strukturierte Logs (pino)
config/machine.json                            maschinen-spezifische Konfig
                                               Secrets liegen im OS-Keychain (siehe ADR-0004)
```

## Konsequenzen

**Positiv**

- Keine Git-Repo-Korruption im Cloud-Sync-Pfad
- Keine SQLite-`disk image malformed`-Fehler durch konkurrierenden Multi-Machine-Zugriff
- Append-only-JSON-Lines mit Datei-pro-Maschine eliminiert Sync-Konflikte vollständig (jede Maschine schreibt nur in ihre eigene Datei)
- Cross-Machine-Lesbarkeit bleibt erhalten: `AgentRunRepository.findByProject()` glob-scannt alle `<machineId>.jsonl`-Dateien
- Lokaler SQLite-Index ist ein reiner Read-Cache; bei Verlust einfach rebuildbar

**Negativ / Aufwand**

- `claude-os doctor` braucht einen `--migrate-git-metadata`-Schritt (Phase 1.5): existierende `vault/.git/` wird in den externen Pfad verschoben, Working-Tree bleibt im Mount
- Index-Rebuild-Logik muss in den Doctor-Run integriert werden
- Pro-Maschine-Pfade müssen plattform-bewusst aufgelöst werden (`envPaths`-Library)
- Bei `claude-os` Erst-Installation auf neuer Maschine: kein vorhandener Index, JSONL-Scan muss bei erstem Aufruf vollständig durchlaufen

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **Alles im Cloud-Mount** (urspr. Grill-Wahl) | Verworfen | Researcher: HIGH-Risk Git- und SQLite-Korruption mit unbestreitbarer Quellenlage |
| **Externe Postgres/Supabase für Agent-Runs** | Verworfen v1 | Zusätzlicher Service erhöht Setup-Komplexität für Solo-Dev erheblich; v1 muss vollständig offline-fähig sein |
| **Bidirektionaler Sync via CRDT-Layer** | Verworfen | Re-Implementierung, hohe Komplexität; löst das Git-Metadaten-Problem nicht |

## Quellen

- [Never put git working dir on OneDrive (plembo gist)](https://gist.github.com/plembo/ff6839d9593ec8afca0ba97d890cce58)
- [OneDrive corrupting Git repos (MS Community Hub)](https://techcommunity.microsoft.com/t5/onedrive/onedrive-is-corrupting-my-git-repositories/td-p/3898283)
- [SQLite corruption via OneDrive abraunegg/onedrive#688](https://github.com/abraunegg/onedrive/issues/688)
- Memory-ID S251 — eigene Erfahrung mit Vault-Branch-Mismatch nach Cloud-Sync
- `git init --separate-git-dir` — Git-Standard-Mechanismus für externe Metadaten

## Notiz

Diese Entscheidung modifiziert die ursprüngliche Grill-Wahl B7 = D, ohne das Grundprinzip "Cloud-Mount ist Source-of-Truth" zu verwerfen — die Source-of-Truth-Eigenschaft gilt weiterhin für Plain-Text-Daten (Markdown, Configs, JSON-Lines).
