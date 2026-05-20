# MCP-Integration — claude-os als Model Context Protocol Server

Ab v1.4 kann claude-os als **MCP-Server** registriert werden. Damit
können Claude Desktop / Claude Code (oder beliebige andere MCP-Clients)
die claude-os Domain-Funktionen als Tools nutzen — vault-status checken,
agent-runs listen, settings lesen, files in die inbox importieren, ohne
dass du dafür CLI-Befehle tippen musst.

Per [ADR-0016](architecture/adr/0016-mcp-single-server-bridge.md) (Single-Server-Bridge
über den Sidecar-`RpcDispatcher`, ADR-0007 für Per-Domain-Bundles bleibt v1.x-deferred)
ist der Domain-Code transport-agnostisch: dieselben Handler die der Tauri-Sidecar
über NDJSON-stdio serviert, sind auch via MCP-stdio erreichbar.

## Verfügbare Tools

| Tool | Mutating? | Beschreibung |
|---|---|---|
| `claude-os.catalog.list` | nein | Installierte Skills/Plugins/MCP-Einträge |
| `claude-os.vault.status` | nein | Vault-Sync-State (busy-flag, conflict-mode, schedule) |
| `claude-os.agent.list` | nein | Agent-Runs aus JSONL-Store (mit project/limit-Filter) |
| `claude-os.settings.read` | nein | Anthropic-Config + Secrets-Backend (read-only) |
| `claude-os.secrets.list` | nein | Secret-**Keys** (niemals Values) |
| `claude-os.inbox.import` | **ja** | Files in `<root>/inbox/` kopieren |

## Registrierung in Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) bzw. `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "claude-os": {
      "command": "node",
      "args": ["C:/path/to/claude-os/dist/cli/index.js", "mcp", "serve"],
      "env": {
        "CLAUDE_OS_ROOT": "C:/Users/<you>/OneDrive/Claude"
      }
    }
  }
}
```

POSIX-Pfade analog. `CLAUDE_OS_ROOT` ist Pflicht damit der Server den
Cloud-Mount findet (sonst Repo-Detect-Fallback der nur greift wenn das
Repo im CWD liegt).

## Registrierung in Claude Code

```bash
claude mcp add claude-os -- node /pfad/zu/claude-os/dist/cli/index.js mcp serve
```

Optional `--env CLAUDE_OS_ROOT=...` mitgeben falls nicht in der Shell.

## Verifikation

Nach Restart des Clients sollten in der Tool-Liste die 6 `claude-os.*`
Tools auftauchen. Quick-Probe in einer Claude-Session:

```
> Run the claude-os.vault.status tool
```

Erwartete Antwort: JSON mit `{vaultPath, busy: null|..., config: {...}}`.

## Architektur

```
Claude Desktop / Claude Code
       │ stdio (MCP NDJSON)
       ▼
 src/cli/commands/mcp.ts ──spawns──► src/mcp/server.ts
                                          │
                                          │ dispatcher.invoke(method, args)
                                          ▼
                                  src/sidecar/rpc.ts (RpcDispatcher)
                                          │
                                          │ register() von registerMethods()
                                          ▼
                                  src/sidecar/methods.ts
                                          │
                                          ▼
                               domains/{catalog,vault-sync,agent-runs,
                                       secrets,auth,environment}/*
```

Der gleiche `RpcDispatcher` wird vom Tauri-Sidecar genutzt — kein
Doppel-Pflege-Aufwand. MCP-Tool-Definitionen liegen in
`src/mcp/tools.ts`.

## Limits / v1.4-Spike-Scope

- **Stdio-Transport only** — HTTP/SSE-Transport deferred. Reicht für
  Claude Desktop/Code, weitere Clients ggf. Folge-Iteration.
- **Keine streaming-Tools** — `chat.spawn` (PTY-Streaming) ist nicht
  exposed weil das einen Tauri-Event-Channel braucht den MCP nicht hat.
- **Keine Auth/ACL** — der MCP-Server vertraut dem spawnenden Client.
  Wer den Sub-Prozess kontrolliert, kann alle Tools rufen. Da Claude
  Desktop/Code lokal laufen und MCP-Server explizit konfiguriert werden
  müssen, ist das v1-akzeptabel.
- **Mutating Tools begrenzt auf `inbox.import`** — keine
  `secrets.delete` Exposure, kein `vault.snapshot`-Trigger via MCP. Wer
  destruktive Aktionen will, nutzt CLI oder GUI.
