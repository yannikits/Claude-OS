# ADR-0009 — Artefakt-Quellen-Modell: Dual-Mode (Marketplace + GitHub-URL) mit Lock-File

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Bedingt durch:** Researcher-Spike auf Obsidian/BRAT-Pattern + Claude Code Plugin-Marketplaces

## Kontext

`claude-os` verwaltet drei Arten von Artefakten: **Skills**, **Plugins** und **MCP-Server**. Diese kommen aus unterschiedlichen Quellen:

- Offizielle Marketplaces (z. B. `anthropics/claude-plugins-official`)
- Beliebige GitHub-Repos ohne Marketplace-Indexing
- Lokale Dev-Versionen während der Entwicklung

Der ursprüngliche Plan war wenig spezifisch zur Quellverwaltung. Researcher-Spike hat zwei wichtige Pattern-Entscheidungen aufgezeigt:

1. **Obsidian-Community-Plugins vs. BRAT**: Obsidian hat einen kuratierten Marketplace plus das `BRAT`-Plugin, das beliebige GitHub-Repos als Plugin-Quelle erlaubt. Beide Modi nebeneinander, gleiche Install-Semantik.
2. **Reproducibility-Anforderung**: Der User arbeitet auf mehreren PCs. Ohne Lock-File divergieren die installierten Versionen.

## Entscheidung

### 1. Drei Source-Types

Jedes Catalog-Entry hat einen `source`-String in einem der drei Formate:

```
marketplace:<marketplace-name>:<artifact-name>
github:<owner>/<repo>@<tag-or-commit>
local:<absolute-path>
```

Beispiele:
- `marketplace:claude-plugins-official:thinking-partner`
- `github:heyitsnoah/claudesidian@v0.4.1`
- `local:/home/user/dev/my-skill`

### 2. Catalog-Schema

`config/catalog.json` (im Cloud-Mount, geteilt zwischen Maschinen):

```json
{
  "version": 1,
  "marketplaces": [
    { "name": "claude-plugins-official", "source": "github:anthropics/claude-plugins-official", "branch": "main" }
  ],
  "entries": [
    {
      "id": "thinking-partner",
      "kind": "skill",
      "source": "marketplace:claude-plugins-official:thinking-partner",
      "enabled": true,
      "scope": "user"
    },
    {
      "id": "obsidian-helper",
      "kind": "plugin",
      "source": "github:exampleuser/obsidian-helper@v1.2.3",
      "enabled": true,
      "scope": "project",
      "project": "main-vault"
    }
  ]
}
```

`config/catalog.lock.json` (im Cloud-Mount, **pinned** für Multi-PC-Reproducibility):

```json
{
  "version": 1,
  "lockedAt": "2026-05-15T14:30:00Z",
  "entries": [
    {
      "id": "thinking-partner",
      "resolved": "github:anthropics/claude-plugins-official@a3b8f9c",
      "sha256": "abc123def456...",
      "installedFrom": "tarball"
    },
    {
      "id": "obsidian-helper",
      "resolved": "github:exampleuser/obsidian-helper@v1.2.3",
      "sha256": "ef98cd76ba54...",
      "installedFrom": "tarball"
    }
  ]
}
```

### 3. Tarball-basierter Installer

Niemals `git clone` für Artefakt-Installation. Stattdessen:

1. Resolve Source-String → Tarball-URL (GitHub-Release-Asset oder generated `.tar.gz` aus Tag)
2. Download nach `%APPDATA%/claude-os/cache/<sha256>.tar.gz`
3. Hash-Check gegen Cache (idempotent: wenn vorhanden, skip Download)
4. Extract nach `<scope-path>/<kind>s/<id>/`
5. Schreibe Lock-File-Eintrag mit resolved-source + sha256

**Begründung**: kein `.git/`-Overhead pro Plugin (würde ADR-0002 widersprechen), atomare Operation, idempotent re-installable.

### 4. Scope-Hierarchie

- **User-Scope**: `~/.claude/<kind>s/<id>/` (gilt für alle Projekte/Vaults)
- **Project-Scope**: `<vault>/.claude/<kind>s/<id>/` (überschreibt User-Scope für dieses Projekt)
- Catalog mergt beide; Project gewinnt bei Konflikt

### 5. CLI

- `claude-os catalog list [--kind skill|plugin|mcp] [--scope user|project]`
- `claude-os catalog install <source-string> [--scope user|project] [--project <name>]`
- `claude-os catalog uninstall <id> [--scope user|project]`
- `claude-os catalog enable <id>` / `claude-os catalog disable <id>`
- `claude-os catalog update [<id>]` — Re-Resolve Tarball, Hash-Diff, Apply via ADR-0005 Selective-Merge
- `claude-os catalog lock` — schreibe aktuelle Resolved-Versions in `catalog.lock.json`
- `claude-os catalog sync` — installiere strikt nach `catalog.lock.json` (für neue PC-Setups)

## Konsequenzen

**Positiv**

- Klare Trennung zwischen offiziellen Marketplaces und experimentellen GitHub-Sources
- Multi-PC-Reproducibility via Lock-File (`claude-os catalog sync` auf neuer Maschine = identischer Stand)
- Keine `.git/`-Verzeichnisse pro Artefakt → Cloud-Mount-konform (ADR-0002)
- Idempotente Installs via Hash-Cache → keine wiederholten Downloads
- Tarball-Cache ist plattform-portable

**Negativ / Aufwand**

- Source-String-Parser muss alle drei Formate handhaben + Edge-Cases (URL mit Sub-Path, `@latest`, Default-Branch)
- Tarball-Generator für GitHub-Repos ohne Release: Fallback auf `GET /repos/{owner}/{repo}/tarball/{ref}`-API mit ETag-Caching
- Lock-File-Konflikte zwischen Maschinen: Cloud-Sync löst diese typischerweise durch File-Conflict-Copies; Doctor erkennt und fragt nach Resolution
- Cache-Cleanup nötig (Retention via Doctor: ältere als 30 Tage löschen)

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **Nur Marketplace, kein BRAT-Mode** | Verworfen | Verlangsamt Experimente, künstliches Gatekeeping für Solo-Dev |
| **`git clone` statt Tarball** | Verworfen | `.git/`-Overhead pro Plugin verstößt gegen ADR-0002, langsamer, mehr Disk-Usage |
| **`npm install` für Plugins** | Verworfen | Triggert peer-deps-Hölle (Memory 587-593) — Capability-Modell besser (siehe ADR-0010) |
| **Single-Source (nur GitHub-URLs)** | Verworfen | Marketplace-Indexing-Vorteil (Search, Curation, Trust) geht verloren |
| **Kein Lock-File** | Verworfen | Multi-PC-Setup divergiert, "works on my machine"-Bug-Klasse |

## Quellen

- [Claude Code Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- [TfTHacker/obsidian42-brat](https://github.com/TfTHacker/obsidian42-brat) — primäres Vorbild für BRAT-Mode
- [BRAT Developer Guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)
- [anthropics/claude-plugins-official marketplace.json](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json)
- VSCode Extension Manifest — User vs. Workspace Scope (`~/.vscode/extensions` + `.vscode/extensions.json`)

## Notiz

Catalog und Lock-File leben **im Cloud-Mount** (ADR-0002-konform, da Plain-Text-JSON). Der Tarball-Cache lebt **außerhalb** pro Maschine (kein Sync nötig, ist Read-Cache). Phase 5 in `tasks/todo.md` implementiert das vollständige Catalog-Modul.
