# ADR-0010 — Plugin-Dependency-Resolution via Capabilities (nicht npm-Peer-Deps)

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Bedingt durch:** Memory-IDs 587–593 (claude-flow Peer-Deps-Cluster) + ruflo Issues #174 und #1676

## Kontext

Plugins/Skills/MCP-Server in claude-os können voneinander abhängen. Beispiel: ein Plugin "git-workflow" braucht MCP-Filesystem-Zugriff und das Skill "pragmatic-review".

**Falscher Weg (was claude-flow/ruflo getan haben)**: npm-Peer-Dependencies zwischen Plugins. Plugin A deklariert `"peerDependencies": { "@org/plugin-b": "^1.0" }`. Das führte zu:

- **Memory-ID 587**: `@claude-flow/cli@3.7.0-alpha.37 installs with peer dependency conflicts`
- **Memory-IDs 588–593**: Daemon-Start-Bugs durch nested-installed peer-deps
- **ruflo #174**: `auto-memory-hook.mjs` kann `@claude-flow/memory` nicht resolven wenn nested
- **ruflo #1676**: Plugin-Install bricht bei Re-Run

Das ist ein bekanntes Strukturproblem: npm-peer-deps-Hoisting interagiert schlecht mit isolierten Plugin-Trees. Lösungen wie `--legacy-peer-deps` sind Symptom-Behandlung, nicht Heilung.

**Pattern aus VSCode**: jede Extension hat einen **isolierten Extension-Host-Prozess** mit eigenem Modul-Baum, keine npm-Deps zwischen Extensions. Extensions kommunizieren via API-Verträge, nicht via Code-Imports.

## Entscheidung

**Capability-basiertes Dependency-Modell statt npm-Peer-Deps.**

### 1. Plugin-Manifest deklariert `requires` als Capability-Strings

`plugin.json`:

```json
{
  "id": "git-workflow",
  "version": "1.2.3",
  "requires": [
    "mcp:filesystem",
    "mcp:github>=2.0",
    "skill:pragmatic-review"
  ],
  "provides": [
    "command:git-workflow:review",
    "command:git-workflow:autocommit"
  ]
}
```

Capability-Format: `<kind>:<name>[<version-constraint>]`

- `kind`: `mcp` | `skill` | `command` | `agent` | `hook`
- `name`: identifier des Capability-Providers
- `version-constraint` (optional): semver-Range `>=2.0`, `^1.0`, `~1.2.3`

### 2. Resolver matched gegen installierten Catalog

`claude-os catalog install <plugin>` führt aus:

1. Lade `requires[]` aus dem Plugin-Manifest
2. Für jedes `requires`-Element: query Catalog nach passendem `provides`
3. Wenn ein Requirement nicht erfüllt ist:
   - **strict mode**: Fail mit klarem Error ("Plugin git-workflow benötigt mcp:filesystem, aber kein installiertes Artefakt provided dies. Installiere zuerst: `claude-os catalog install marketplace:claude-plugins-official:filesystem`.")
   - **auto mode** (default `--auto-deps`): suche im konfigurierten Marketplace nach dem ersten Capability-Provider, installiere transitiv
4. Schreibe Resolution in Lock-File mit aufgelösten Capability-Bindings

### 3. Strikt isolierte Module-Trees

- Jedes Plugin installiert seine eigenen npm-Deps in seinem Verzeichnis (`<plugin>/node_modules/`)
- KEIN Hoisting in den Wurzel-`node_modules` von `claude-os`
- Plugins kommunizieren **nicht** via JS-Imports, sondern ausschließlich über deklarierte Capabilities

### 4. Capability-Namensraum

Reservierte Präfixe:

- `mcp:*` — MCP-Server (Provider muss MCP-Konfig im Catalog haben)
- `skill:*` — Skills (Provider muss SKILL.md mit Frontmatter-`id` haben)
- `command:*:*` — Slash-Commands (Format `<plugin>:<command>`)
- `agent:*` — Subagent-Types
- `hook:*` — Hook-Handlers für bestimmte Events (`pre-edit`, `post-commit`, etc.)

## Konsequenzen

**Positiv**

- Direkte Antwort auf die in Memory dokumentierte Peer-Deps-Pain (587–593, ruflo #174, #1676)
- Plugins sind echt isoliert — Update eines Plugins bricht andere nicht
- Klarere Mental-Model: Plugin-Autor denkt in Capabilities, nicht in transitiven Code-Bäumen
- Resolver-Logik testbar gegen Reproducer-Cases aus den genannten Issues
- Cross-Marketplace-Capability-Resolution möglich ohne `allowCrossMarketplaceDependenciesOn`-Boilerplate

**Negativ / Aufwand**

- Plugin-Autoren müssen neuen Manifest-Stil lernen (statt `package.json`-peer-deps)
- Resolver braucht eigenen Test-Suite gegen Fehlszenarien (Cyclic-Deps, Conflict-Provides, Version-Mismatch)
- Tools wie `npm audit` greifen nicht — Security-Audit muss anders gelöst werden (z. B. Hash-Pin via ADR-0009 Lock-File)
- Erst-Migration: Existierende claude-flow/ruflo-Plugins haben keine `requires`-Capability-Manifeste — Adapter-Schicht oder manuelle Migration nötig

## Implementierungs-Constraints (`catalog`-Modul, Phase 5)

- `CapabilityResolver` mit `.resolve(plugin: PluginManifest, catalog: Catalog): ResolutionResult | ResolutionError[]`
- `ResolutionError`-Typen: `MissingProvider`, `VersionConflict`, `CyclicDependency`, `AmbiguousProvider`
- Resolver ist **deterministisch**: gleicher Input → gleicher Output (für reproducible Lock-Files)
- Test-Suite **muss** Tests gegen die in Memory dokumentierten Fail-Modi enthalten (ruflo #1676 als Reproducer)
- CLI: `claude-os catalog resolve <plugin>` zeigt Resolution-Plan trocken ohne Installation

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **npm-Peer-Deps (status quo)** | Verworfen | Direkt verantwortlich für Memory 587–593, ruflo #174/#1676 — bekanntes Bug-Cluster |
| **Vendoring aller Deps pro Plugin** | Verworfen | Massiver Disk-Overhead, kein Sharing von Common-MCPs |
| **Monorepo mit `pnpm workspaces`** | Verworfen | Funktioniert nur in einem Single-Source-Repo; widerspricht ADR-0009 Dual-Mode (BRAT-style external Plugins) |
| **Pyramid-Style mit Single-Root-Tree** (`npm install --legacy-peer-deps`) | Verworfen | Symptom-Behandlung, nicht Heilung; bricht bei jedem Plugin-Update wieder |

## Quellen

- Memory-IDs 587–593 — eigene Erfahrung mit `@claude-flow/cli` Peer-Deps-Pain
- [ruflo Issue #174 — missing dependencies](https://github.com/ruvnet/ruflo/issues/174)
- [ruflo Issue #1676 — plugin install broken](https://github.com/ruvnet/ruflo/issues/1676)
- [Claude Code Plugin Dependencies Reference](https://code.claude.com/docs/en/plugin-dependencies) — `allowCrossMarketplaceDependenciesOn`
- VSCode Extension-Host-Isolation (Microsoft Engineering Blog, mehrere Sources) — bewährter Industriestandard

## Notiz

Diese ADR ist eng gekoppelt an ADR-0009 (Source-Modell). Zusammen definieren sie das vollständige Plugin-Lifecycle-Modell: ADR-0009 löst "wo kommt das Plugin her und wie wird es installiert", ADR-0010 löst "wie hängen Plugins voneinander ab". Phase 5 in `tasks/todo.md` implementiert beide.
