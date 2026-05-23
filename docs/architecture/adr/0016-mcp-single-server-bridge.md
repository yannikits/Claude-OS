# ADR-0016 — MCP-Single-Server-Bridge über Sidecar-RPC (v1.4)

**Status:** Akzeptiert
**Datum:** 2026-05-20
**Bedingt durch:** Phase v1.4-Spike PR #28; verfeinert [ADR-0007](0007-mcp-bundle-per-domain-deferred.md)

## Kontext

ADR-0007 skizzierte 2026-05-15 ein "MCP-Bundle pro Domain": pro Domain (`vault-sync`, `agent-runs`, `catalog`, `secrets`) ein eigener MCP-Endpoint mit eigenem Token-Scope. Geschätzte v1.1-Implementierung: 7+ Tickets + Security-Review.

Inzwischen war die Domain-Code-Reinheit-Constraint aus ADR-0007 §44 ohnehin etabliert (alle Domain-Methoden sind transport-agnostisch). Phase 6c ergänzte den `RpcDispatcher` als zentrale Method-Registry, die der Tauri-Sidecar via NDJSON-stdio bedient. Damit existierte plötzlich eine **fertige Method-Registry**, die nur einen anderen Transport-Adapter brauchte.

Bei der v1.4-Spike-Planung stellte sich die Frage: per-domain (ADR-0007 wie geplant) oder single-server-bridge (RpcDispatcher direkt vor MCP packen)?

| Aspekt | Per-Domain (ADR-0007) | Single-Server-Bridge (umgesetzt) |
|---|---|---|
| Code-Aufwand | 7+ Tickets, eigene Server pro Domain | 4 Files (~250 LOC), ein Server |
| Token-Management | Pro Domain ein Scope-Limit | Keine Token-Layer (spawning client trust) |
| Discovery | Client muss N Server registrieren | Ein Eintrag in `claude_desktop_config.json` |
| Scope-Isolation | Native (eigener Prozess pro Domain) | Logisch via `MCP_TOOLS`-Allowlist |
| Drift-Risiko zur Tauri-RPC | Hoch (zwei Registry-Quellen) | Null (gleiche `RpcDispatcher`-Instanz möglich) |
| Security-Surface | N Token, N Endpoints | Ein stdio-Subprocess unter Client-Kontrolle |

## Entscheidung

**Single-Server-Bridge in v1.4 — ADR-0007 für v1.x weiter deferred bis ein konkreter Multi-Tenant-Use-Case auftaucht.**

### Implementierungsdetails

1. **Shared Method-Registry:** `src/mcp/server.ts` konstruiert einen frischen `RpcDispatcher` und ruft `registerMethods()` aus `src/sidecar/methods.ts` — die identische Registry, die der Tauri-Sidecar nutzt. Beim Tool-Call wird `dispatcher.invoke(method, args)` aufgerufen. Domain-Code sieht nicht, woher der Call kommt.

2. **Tool-Manifest als Indirection-Layer:** `src/mcp/tools.ts` definiert `MCP_TOOLS` als statische Liste. Jedes Element mappt `name` (MCP-Client-sichtbar, kebab-dot-namespaced wie `claude-os.catalog.list`) auf `methodName` (Dispatcher-intern wie `catalog.list`) plus JSON-Schema für `inputSchema`. Diese Indirection erlaubt:
   - Renaming MCP-Tools ohne Dispatcher-Migrationen
   - Selektive Exposition (Dispatcher kann mehr Methoden haben, MCP nur die expliziten 6)
   - Per-Tool-Schema-Validation am MCP-SDK-Layer

3. **JSON-Schema statt TypeBox in der MCP-Schicht:** MCP-Spec erwartet rohes JSON-Schema in `inputSchema`. Im Sidecar nutzen wir TypeBox. Beim MCP-Wrapper schreiben wir das Schema von Hand (klein genug für 6 Tools); per-Tool eine `{type: 'object', properties, additionalProperties: false}`-Struktur. Falls die Tool-Anzahl wächst, kann ein TypeBox-zu-JSON-Schema-Converter generisch nachgereicht werden.

4. **stdio-Transport, kein HTTP/SSE:** Claude Desktop und Claude Code spawnen MCP-Server als Subprozess und kommunizieren über stdin/stdout. HTTP/SSE-Transport ist im MCP-SDK vorhanden, in v1.4 aber unbenutzt — kein konkreter Use-Case.

5. **6 initial exponierte Tools:**
   - `claude-os.catalog.list` (read-only)
   - `claude-os.vault.status` (read-only)
   - `claude-os.agent.list` (read-only, mit project/limit-Filter)
   - `claude-os.settings.read` (read-only Anthropic-Config + Secrets-Backend)
   - `claude-os.secrets.list` (read-only, **nur Keys** — Values niemals über MCP)
   - `claude-os.inbox.import` (**mutating** — kopiert Files nach `<root>/inbox/`)

6. **Auth-Modell: Client-Trust:** Der spawning Client (Claude Desktop, Claude Code) startet den Server als Kindprozess. Kein Token-Handshake. Begründung: der Subprocess läuft mit User-Rechten und der Client kontrolliert ohnehin, was er aufruft. Token wären Theater wenn der Client schon Full-Privileges hat.

## Konsequenzen

### Positiv

- **Null API-Drift:** MCP und Tauri-Sidecar teilen sich Domain-Code AND Dispatcher-Registry. Wenn `catalog.list` sich ändert, sind beide Adapter automatisch up-to-date.
- **5× weniger Code als ADR-0007 v1.1-Plan:** ~250 LOC für die Bridge vs. geschätzt 1500+ LOC für per-Domain-Server + Token-Layer.
- **Einfache User-Setup-Story:** Ein Eintrag in `claude_desktop_config.json`, keine Token-Erzeugung pro Domain.
- **Forward-kompatibel:** Falls ADR-0007 später doch nötig wird, kann ein per-Domain-Layer ABOVE der Bridge gebaut werden, ohne Domain-Code zu fassen.

### Negativ / Akzeptierte Trade-offs

- **Keine Per-Tool-ACLs:** Wenn ein Client Zugriff bekommt, sieht er alle 6 Tools. Per-User-Scope-Limits (z.B. "diese Session darf catalog.list aber nicht inbox.import") sind nicht möglich.
  → Mitigation: `inbox.import` ist die einzige mutating-Operation und schreibt nur in ein vom User explizit überwachtes Verzeichnis. Risiko begrenzt.
- **Secrets-Values niemals exponiert:** `secrets.list` zeigt nur Keys + Backend. Set/Update bleibt CLI-only (Value-in-Renderer-RAM würde MCP-Replay-Logs vergiften).
- **stdio-only:** Multi-Client-Zugriff auf eine gemeinsame claude-os-Instanz braucht HTTP-Transport, ist v1.4 aber nicht da. Reicht: jeder Client spawnt eigenes Subprocess.

### Konstraints für Folge-Phasen

- **Neue Domain-RPC-Methods:** wenn sie via MCP sichtbar sein sollen, muss `MCP_TOOLS` händisch erweitert werden. Vergisst man das, ist die Method nur im Tauri-Sidecar erreichbar (graceful, kein Error).
- **Mutating-Tools:** jedes neue mutating MCP-Tool braucht **explizite Sicherheitsanalyse** im PR (Value-in-RAM-Risiko, Idempotenz, FS-Pfad-Sanitization). Default `additionalProperties: false` im inputSchema ist Pflicht.
- **Versions-Bump:** `serverVersion` in `createMcpServer` defaultet auf `resolveDefaultServerVersion()` (closes m1-followup 2026-05-23) — liest `package.json#version` zur Laufzeit ueber das gleiche `import.meta.url`+`readFileSync`-Pattern wie M40 in `cli/index.ts`. Kein manueller Sync pro Release mehr noetig. Caller kann via `opts.serverVersion` weiterhin uebersteuern (Tests + spezielle Tagging-Szenarien).

## Alternativen verworfen

**Per-Domain-Server (ADR-0007 wie ursprünglich):** Verworfen weil die Domain-Reinheit-Investition bereits durch den Sidecar-RpcDispatcher monetisiert ist. Ein zweiter Adapter mit gleicher Registry zu bauen ist 5× weniger Aufwand als N Adapter mit jeweils eigener Registry. Token-Scope-Isolation wäre ein Vorteil, aber wir haben aktuell weder Multi-User noch Multi-Tenant-Use-Cases.

**TypeBox-Auto-Schema-Generation:** Verworfen für v1.4 weil bei 6 Tools die JSON-Schema-Handschrift ~20 LOC kostet. Wenn die Tool-Anzahl ≥ 15 wird, lohnt sich ein `typeBoxToJsonSchema(...)`-Helper.

**HTTP-Transport zusätzlich zu stdio:** Verworfen weil weder Claude Desktop noch Claude Code aktuell HTTP-MCP-Server registrieren können. Wenn das kommt, einen `--transport=http --port=N`-Flag in `cli/commands/mcp.ts` ergänzen — Server-API ist transport-agnostisch.

## Referenzen

- ADR-0007 — Original-Pattern für Per-Domain-MCP (jetzt v2+ Material, falls je gebraucht)
- ADR-0006 — Tauri-Sidecar-Stdio-IPC (definiert den RpcDispatcher den wir wieder-verwenden)
- `docs/mcp-integration.md` — User-facing Setup-Guide für Claude Desktop / Claude Code
- `src/mcp/server.ts` — `createMcpServer` + `runMcpServer` Factories
- `src/mcp/tools.ts` — `MCP_TOOLS`-Registry mit JSON-Schemas
- `src/sidecar/rpc.ts` — Shared `RpcDispatcher`
- `src/sidecar/methods.ts` — Shared `registerMethods` Registration-Point
