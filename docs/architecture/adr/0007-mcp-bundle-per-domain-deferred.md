# ADR-0007 — MCP-Bundle pro Domain (Deferred to v2+)

**Status:** Akzeptiert (Deferred). v1.4 hat stattdessen den Single-Server-Bridge-Ansatz gewählt — siehe [ADR-0016](0016-mcp-single-server-bridge.md). Per-Domain-Bundles bleiben Material für v2+ falls ein konkreter Multi-Tenant- oder Per-Domain-Scope-Use-Case auftaucht.
**Datum:** 2026-05-15
**Bedingt durch:** Pattern-Beobachtung in `levnikolaevich/claude-code-skills`

## Kontext

`levnikolaevich/claude-code-skills` zeigt ein elegantes Pattern: jede Skill-Sammlung liefert ihren eigenen MCP-Server mit (z. B. `hex-line` für hash-verifiziertes Edit-Tooling, `hex-graph` für Code-Knowledge-Graph). Andere AI-Tools (Claude Code, Codex, Gemini-CLI) können diese MCP-Server als Datenquelle anbinden.

Übertragen auf `claude-os`: jede Domain (`vault-sync`, `agent-runs`, `catalog`, `secrets`) könnte einen MCP-Endpoint exponen. Externe AI-Sessions könnten dann z. B. `vault-sync.search`, `agent-runs.recent`, `catalog.list` als MCP-Tools nutzen, statt das Filesystem direkt zu lesen.

## Entscheidung

**Akzeptiert als v1.1-Plan, deferred aus v1.**

In **v1** ist die einzige Anforderung an die Domain-Architektur, dass die Public-Interfaces **transport-agnostisch** bleiben. Konkret:

- Domain-Code darf nicht von CLI-Presenters, Tauri-IPC-Typen oder MCP-Schemas importieren
- Public-Methoden geben rohe Domain-Typen zurück (`AgentRun`, `CatalogEntry`, `VaultSyncSnapshot`)
- Serialisierung passiert in Adapter-Schichten (`cli/presenters/`, `cli/rpc-server.ts`, in v1.1: `mcp/adapter/`)

In **v1.1** wird ein optionaler MCP-Adapter-Layer hinzugefügt:

- Pro Domain ein MCP-Endpoint (z. B. `claude-os mcp serve --domain vault-sync`)
- Schema-Definition pro Methode (JSON-Schema, abgeleitet aus den TS-Interfaces via `ts-json-schema-generator`)
- Auth: lokaler Bearer-Token in OS-Keychain (per ADR-0004), generiert via `claude-os mcp grant`
- Scope-Limits pro Token (read-only-Vault, full-catalog, no-secrets etc.)

## Konsequenzen

**Positiv (v1.1)**

- Cross-Tool-Interop: Codex oder Gemini-CLI können `claude-os` als Datenquelle anbinden
- Saubere API-Surface statt File-Scraping durch externe Tools
- Pattern-Konsistenz mit `levnikolaevich/claude-code-skills` und anderen MCP-First-Tools

**Negativ (Grund für v1-Defer)**

- Verdoppelte API-Pflege (CLI + MCP) erhöht Wartungslast für Solo-Dev
- Security-Surface: jeder MCP-Endpoint ist ein potenzieller Angriffsvektor (Token-Leakage, Scope-Misconfig)
- v1-Scope-Explosion: 7+ zusätzliche Tickets + Security-Review nötig

**Constraints für v1 (damit v1.1 günstig wird)**

- Domain-Code in `src/domains/*/` darf nur `domain-types.ts` und gemeinsame `shared/`-Typen importieren
- Keine direkten Aufrufe von `electron`/`tauri`/`cli`-Paketen aus Domain-Code
- Code-Review-Checkliste: "Pure-Function-Test — kann diese Domain-Methode in einem Unit-Test ohne Adapter laufen? Wenn nein, Refactor."

## Konkrete v1.1-Ticket-Liste (für späteren Verbrauch)

- [ ] `src/mcp/adapter/` — Schema-Generator aus TS-Interfaces (via `ts-json-schema-generator`)
- [ ] `src/mcp/server/` — JSON-RPC-Server-Wrapper, ein Endpoint pro Domain
- [ ] `cli/commands/mcp.ts` — `claude-os mcp serve|grant|revoke|list-tokens`
- [ ] Token-Storage in OS-Keychain (per ADR-0004) statt File
- [ ] Doctor-Check: alle aktiven MCP-Tokens listen, abgelaufene markieren
- [ ] Security-Review: Scope-Limit-Enforcement, Token-Rotation
- [ ] Docs: `docs/mcp-integration.md`

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **MCP-Bundles in v1** | Verworfen | Scope-Explosion + Security-Surface in einem v1, das primär Cloud-Mount-Stabilität liefern soll |
| **Nie MCP-Bundles** | Verworfen | Würde die Domain-Interfaces nicht zwingen, transport-agnostisch zu bleiben — späteres Refactoring teurer |
| **Single-MCP-Endpoint statt Pro-Domain** | Vertagt nach v1.1-Implementierung | Pro-Domain ist sauberer für Scope-Limits, aber ein einzelner Multiplex-Endpoint ist möglich |

## Quellen

- [levnikolaevich/claude-code-skills](https://github.com/levnikolaevich/claude-code-skills) — primäres Vorbild
- [the911fund/skill-of-skills](https://github.com/the911fund/skill-of-skills) — Multi-CLI-Discovery-Pattern (sekundär)

## Notiz

Diese ADR ist primär ein **Constraint für v1**, nicht eine Implementierungs-Anweisung. Der Hauptzweck ist: die v1-Codebase so designen, dass v1.1 günstig wird. Die referenzierten v1.1-Tickets gehören in `docs/future.md`, nicht in `tasks/todo.md`.
