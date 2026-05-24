# Vault-Migration: Single-Vault → Multi-Workspace

Schrittweise Anleitung zur Umstellung des bestehenden Obsidian-Vaults auf das Multi-Workspace-Layout aus [ADR-0031](architecture/adr/0031-vault-multi-workspace.md).

> **Status:** Migration ist optional, bis Memory-Phase 2 startet. Solange der Vault im flachen Single-Layout liegt, läuft alles wie bisher. Die Migration ist Voraussetzung für FTS5-Workspace-Filter (ADR-0025) und MSP-Tenant-Isolation (ADR-0027).

## Voraussetzungen

- `$CLAUDE_OS_ROOT` ist gesetzt UND zeigt auf einen Cloud-Mount mit `<root>/vault/`
- Genug freier Speicherplatz für ein vollständiges Vault-Backup (Pfad: `<root>/vault-backup-<timestamp>.zip`)
- Obsidian schließt vor der Migration (sonst File-Locks auf `.obsidian/workspace.json`)
- Kein laufender `vault snapshot` oder Sync-Vorgang (`claude-os vault status` prüfen)

## Zielstruktur

```
<vault-root>/                          (= <CLAUDE_OS_ROOT>/vault/)
├── .obsidian/                         (unverändert)
├── .git                               (unverändert — externes Gitfile)
├── .gitignore                         (unverändert)
└── Claude-OS/                         (neu)
    ├── workspaces/
    │   ├── personal/                  ← alles Vorhandene landet hier
    │   │   ├── README.md              ← Workspace-Beschreibung + Frontmatter-Format
    │   │   └── (deine bisherigen Notes, struktur-erhaltend kopiert)
    │   ├── msp-internal/              (leer, für ITeen-interne MSP-Doku)
    │   │   └── README.md
    │   └── msp-customers/             (leer, pro Customer ein Unterordner)
    │       └── README.md
    └── .claude-os/
        └── (Platzhalter für späteren FTS5-Index)
```

## Migration mit dem PowerShell-Helper

Das Repo enthält `scripts/migrate-vault.ps1`. Das Script ist **Dry-Run by default** — es zeigt erst, was es tun würde, und macht nichts, bis du `-Execute` setzt.

### Schritt 1 — Dry-Run

```powershell
pwsh ./scripts/migrate-vault.ps1
# oder explizit:
pwsh ./scripts/migrate-vault.ps1 -VaultPath $env:CLAUDE_OS_ROOT\vault
```

Output zeigt: Anzahl Files, Backup-Pfad, geplante Operationen. Nichts wird verändert.

### Schritt 2 — Mit Backup ausführen

```powershell
pwsh ./scripts/migrate-vault.ps1 -Execute
```

Dieser Lauf:
1. Erzeugt `<vault-parent>/vault-backup-<timestamp>.zip` mit dem kompletten Vault-Inhalt
2. Legt die `Claude-OS/workspaces/{personal,msp-internal,msp-customers}/` Struktur an
3. Verschiebt jeden Top-Level-Eintrag (außer `.obsidian`, `.git`, `.gitignore`, `.claude-os-root`, neu erzeugtes `Claude-OS/`) nach `Claude-OS/workspaces/personal/`
4. Schreibt `README.md` in jeden Workspace mit Frontmatter-Erwartungen
5. Gibt eine Zusammenfassung aus (verschoben/übersprungen/Fehler)

### Schritt 3 — Manuelle Nacharbeit

Das Script ist bewusst dumm: **alles** landet in `personal/`, weil eine automatische Klassifikation der bisherigen Notes nicht zuverlässig möglich ist.

Du musst manuell:

1. **MSP-bezogene Notizen** sichten und in `msp-internal/` verschieben (alles, was die ITeen-Schmiede intern betrifft, aber keinen Customer-Bezug hat)
2. **Customer-spezifische Notizen** in einen Unterordner unter `msp-customers/<customer-id>/` verschieben (Customer-IDs konsistent halten, idealerweise TANSS-/Ninja-ID)
3. **Frontmatter ergänzen** für Notes, die in MSP-Workspaces landen (siehe nächste Sektion)
4. **Obsidian-Vault-Settings prüfen** — Obsidian merkt sich Workspace-Layouts in `.obsidian/workspace.json`; gegebenenfalls neu öffnen lassen

### Schritt 4 — Rollback (falls etwas schiefläuft)

Das Backup enthält **nur die verschobenen Items** (nicht den ganzen Vault), weil Skip-Items am Vault-Root unverändert bleiben und nicht im Risiko stehen — und Runtime-State-Files wie `ruvector.db` sind oft von laufenden Prozessen gelockt (vollständiges `Compress-Archive *` würde dann crashen).

Rollback:

```powershell
# 1. Backup-Pfad aus dem Migration-Output
$bk = "<vault-parent>\vault-backup-<timestamp>.zip"

# 2. Extrahieren in temp-Ordner
Expand-Archive -Path $bk -DestinationPath "<vault-parent>\vault-restore" -Force

# 3. Verschobene Items zurück ins Vault-Root verschieben
#    (manuell prüfen, dann z.B.:)
Get-ChildItem "<vault-parent>\vault-restore" -Force |
  Move-Item -Destination "<vault-root>" -Force

# 4. Claude-OS/ wieder entfernen wenn nötig
Remove-Item "<vault-root>\Claude-OS" -Recurse -Force
```

Die Migration ist nicht idempotent — ein zweiter `-Execute`-Lauf bricht ab, wenn `Claude-OS/` bereits existiert.

## Frontmatter (Pflicht pro Note in MSP-Workspaces)

Sobald Memory-Phase 3 (FTS5-Index, ADR-0025) startet, wird jeder Note das folgende Frontmatter erwartet:

```yaml
---
created: 2026-05-24T10:00:00Z          # ISO-8601
updated: 2026-05-24T10:00:00Z
tags: [customer-name, topic, ...]
type: session | skill-memory | person | project | note
workspace: personal                    # oder msp-internal | msp-customers/<customer-id>
tenant: <customer-id>                  # nur bei msp-customers Pflicht
classification: personal | operational | customer-confidential | secret | ephemeral
schema_version: 1
---
```

**Fail-safe:** Fehlt `classification`, wird die Note als `customer-confidential` behandelt (SECURITY.md §2). Lieber explizit `personal` setzen, wenn es harmlos ist.

**`workspace`-Feld** muss zum Ordner passen. Inkonsistente Notes werden später vom Doctor markiert.

## Was die Migration **nicht** macht

- **Sie schreibt kein Frontmatter** in deine bestehenden Notes. Das wäre invasiv. Ergänze manuell, wenn relevant.
- **Sie versucht keine Klassifikation.** Alles landet als `personal` — du sortierst.
- **Sie rührt `.obsidian/` nicht an.** Obsidian-Workspace-Layouts bleiben, wo sie sind.
- **Sie löscht nichts.** Originalstruktur ist im Backup-ZIP.
- **Sie indexiert nichts.** FTS5-Index (ADR-0025) kommt erst in einer separaten Phase.

## Skip-Liste (was niemals migriert wird)

Das Skript skipt am Vault-Root fünf Kategorien:

| Kategorie | Einträge |
|---|---|
| Obsidian/git-Metadaten | `.obsidian`, `.git`, `.gitignore`, `.gitattributes` |
| Migration-Marker | `.claude-os-root`, `Claude-OS` (das neue Ziel) |
| Tool-Runtime-State | `.claude`, `.claudian` |
| AgentDB / ruvector | `agentdb.rvf*`, `ruvector.db*` |
| Editor / OS junk | `*.swp`, `.DS_Store`, `Thumbs.db` |

**Stray-Files** (0 Byte, ohne Extension) am Vault-Root werden ebenfalls geskipt — das sind in der Regel PowerShell-Redirection-Unfälle (`> nul`, kaputte Encodings). Sie tauchen im Dry-Run-Output als `STRAY` auf, sodass du sie manuell prüfen und ggf. löschen kannst.

Falls dein Tool-Setup noch andere Runtime-State-Files am Vault-Root produziert (z. B. eine zukünftige `.foo-cache/`-Direction), diese in `scripts/migrate-vault.ps1` `$SkipExact` oder `$SkipPatterns` ergänzen.

## Verifikation nach der Migration

```powershell
# 1. Top-Level-Struktur prüfen
Get-ChildItem "$env:CLAUDE_OS_ROOT\vault" -Force | Select-Object Name, Mode

# 2. Personal-Workspace zählen
(Get-ChildItem "$env:CLAUDE_OS_ROOT\vault\Claude-OS\workspaces\personal" -Recurse -File).Count

# 3. Obsidian wieder öffnen, prüfen ob Notes sichtbar bleiben
# (Obsidian erkennt die neue Ordnerstruktur und indexiert neu)
```

Wenn alles aussieht wie erwartet: Backup-ZIP behalten, bis du nach einer Woche sicher bist, dass nichts fehlt.

## Wenn House-Watch im selben Vault liegt

House-Watch-Notes gehören laut [ADR-0030](architecture/adr/0030-repo-strategy-hybrid.md) **in ein eigenes Repo**. Nach der Migration:

1. House-Watch-Notes aus `personal/` extrahieren
2. In `~/house-watch/vault/` (oder wo House-Watch liegt) verschieben
3. Gegen ein Backup vergleichen, dass nichts verloren ging

## Verweise

- [ADR-0031 — Vault-Strategie Multi-Workspace](architecture/adr/0031-vault-multi-workspace.md) (Entscheidung)
- [ADR-0025 — Memory-Indexierung FTS5](architecture/adr/0025-memory-indexing-fts5.md) (Index mit `workspace`-Spalte)
- [ADR-0027 — MSP-Bridge Permission](architecture/adr/0027-msp-bridge-permission-model.md) (Tenant-Isolation per Workspace)
- [`SECURITY.md` §2](../SECURITY.md) (Data-Classification)
- [`SECURITY.md` §6.3](../SECURITY.md) (Tenant-Isolation-Detail)
