/**
 * MCP server factory — exposes claude-os domain RPCs as Model Context Protocol tools.
 *
 * Per ADR-0007: the same domain code that the Tauri sidecar serves via
 * NDJSON stdio is also reachable by any MCP client (Claude Desktop,
 * Claude Code, custom agents). The `RpcDispatcher` from
 * `src/sidecar/rpc.ts` is the shared handler registry; this module is a
 * thin transport adapter that converts MCP CallToolRequest into
 * `dispatcher.invoke()` calls.
 *
 * The server uses the official MCP SDK's stdio transport because that's
 * what Claude Desktop / Claude Code expect (they spawn the server as a
 * subprocess and communicate over stdin/stdout). HTTP transport is
 * deferred — kein konkreter Bedarf in v1.4.
 *
 * @module mcp/server
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RpcDispatcher } from '../sidecar/rpc.js';
import { findToolByName, MCP_TOOLS } from './tools.js';

/**
 * m1 (2026-05-23 todo-audit, closes ADR-0016 §Konstraints embedded TODO):
 * resolveVersion liest package.json zur Laufzeit, sodass `serverVersion`
 * nicht jeden Release manuell synchronisiert werden muss. Spiegelt das
 * M40-Pattern aus `cli/index.ts`. Bei Build-Layout-Aenderung (dist/mcp/
 * → woanders) muss der `../../package.json`-Pfad angepasst werden.
 */
function resolveDefaultServerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    /* fall through to fallback */
  }
  return 'unknown';
}

export interface CreateMcpServerOpts {
  /** Optional injection of the dispatcher (tests). Defaults to a fresh dispatcher with all sidecar methods registered. */
  readonly dispatcher?: RpcDispatcher;
  /** Server name shown in MCP client UIs. */
  readonly serverName?: string;
  /** Server semver shown in MCP client UIs. */
  readonly serverVersion?: string;
}

/**
 * Build the MCP server instance with the claude-os tool surface bound
 * to the given (or auto-created) dispatcher. Caller still needs to
 * `.connect(transport)` it.
 */
export async function createMcpServer(opts: CreateMcpServerOpts = {}): Promise<Server> {
  let dispatcher = opts.dispatcher;
  if (dispatcher === undefined) {
    const { registerMethods } = await import('../sidecar/methods.js');
    dispatcher = new RpcDispatcher();
    registerMethods(dispatcher);
  }
  const activeDispatcher = dispatcher;

  const server = new Server(
    {
      name: opts.serverName ?? 'claude-os',
      version: opts.serverVersion ?? resolveDefaultServerVersion(),
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = findToolByName(req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await activeDispatcher.invoke(tool.methodName, req.params.arguments ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Tool ${req.params.name} failed: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * One-shot entry point: build the server, connect stdio transport, run
 * until stdin closes. Intended for the `claude-os mcp serve` subcommand
 * and for direct `node dist/mcp/index.js` invocation by MCP clients.
 */
export async function runMcpServer(opts: CreateMcpServerOpts = {}): Promise<void> {
  const server = await createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The MCP SDK keeps stdin open; resolve via the transport's close signal
  // when the parent process terminates the subprocess.
}
