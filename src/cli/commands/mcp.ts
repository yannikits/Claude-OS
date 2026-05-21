/**
 * `claude-os mcp` — Model Context Protocol server subcommand (v1.4 spike).
 *
 * Wires the existing `RpcDispatcher`-based domain code (Phase 5+6)
 * into the MCP SDK's stdio transport so Claude Desktop / Claude Code
 * can call claude-os tools as part of their tool-use flow. Per ADR-0007.
 *
 * Subcommands:
 *   serve   start an MCP server on stdio (default — meant to be spawned
 *           by an MCP client; users don't typically invoke this directly)
 *
 * @module @cli/commands/mcp
 */

import type { Command } from 'commander';
import {
  checkServerStatus,
  discoverMcpClients,
  type McpServerStatus,
  probeServers,
  summariseStatuses,
} from '../../domains/mcp-clients/index.js';
import { runMcpServer } from '../../mcp/index.js';
import { type GlobalOpts, printJson, printLine } from '../output.js';

function renderStatus(s: McpServerStatus): string {
  const marker = s.kind === 'ok' ? '[OK]' : s.kind === 'disabled' ? '[OFF]' : '[!]';
  const host = s.entry.host;
  return `${marker} ${s.entry.name}  (${host})\n    cmd: ${s.entry.command} ${s.entry.args.join(' ')}\n    ${s.message}`;
}

export function registerMcpCommand(program: Command): void {
  const mcp = program.command('mcp').description('Model Context Protocol server (v1.4)');

  mcp
    .command('serve')
    .description('Start the MCP server on stdio (spawned by MCP clients)')
    .action(async () => {
      try {
        await runMcpServer();
      } catch (err) {
        console.error(`claude-os mcp serve failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  const clients = mcp
    .command('clients')
    .description('MCP-Server entdecken die in Claude Desktop / Claude Code konfiguriert sind');

  clients
    .command('list')
    .description('Alle entdeckten MCP-Server mit Static-Status-Check listen')
    .action(async (_opts, command) => {
      const globalOpts = command.optsWithGlobals() as GlobalOpts;
      const discovery = discoverMcpClients({ projectCwd: process.cwd() });
      const statuses = discovery.servers.map((entry) => checkServerStatus(entry));
      if (globalOpts.json === true) {
        printJson({
          discovery: {
            missingConfigPaths: discovery.missingConfigPaths,
            malformedConfigs: discovery.malformedConfigs,
          },
          servers: statuses,
          summary: summariseStatuses(statuses),
        });
        return;
      }
      if (statuses.length === 0) {
        printLine('(keine MCP-Server in den entdeckten Configs gefunden)');
        if (discovery.missingConfigPaths.length > 0) {
          printLine('');
          printLine('Geprüfte Pfade die nicht existierten:');
          for (const p of discovery.missingConfigPaths) printLine(`  - ${p}`);
        }
        if (discovery.malformedConfigs.length > 0) {
          printLine('');
          printLine('Malformed Configs:');
          for (const m of discovery.malformedConfigs) printLine(`  - ${m.path}: ${m.reason}`);
        }
        return;
      }
      const summary = summariseStatuses(statuses);
      printLine(
        `${statuses.length} MCP-Server entdeckt — ${summary.ok} ok, ${summary.disabled} off, ${
          summary['command-missing'] + summary['arg-path-missing'] + summary['env-missing']
        } mit Problemen.\n`,
      );
      for (const s of statuses) {
        printLine(renderStatus(s));
        printLine('');
      }
      if (discovery.malformedConfigs.length > 0) {
        printLine('Warnungen:');
        for (const m of discovery.malformedConfigs) printLine(`  - ${m.path}: ${m.reason}`);
      }
    });

  clients
    .command('probe')
    .description('Live-Probe: spawnt jeden Server, sendet MCP-initialize+tools/list, killt ihn')
    .option('--timeout <ms>', 'Probe-Timeout pro Server in ms (Default 5000)', '5000')
    .option('--concurrency <n>', 'Parallele Probes (Default 3)', '3')
    .action(async (opts: { timeout: string; concurrency: string }, command) => {
      const globalOpts = command.optsWithGlobals() as GlobalOpts;
      const discovery = discoverMcpClients({ projectCwd: process.cwd() });
      if (discovery.servers.length === 0) {
        if (globalOpts.json === true) printJson({ probes: [] });
        else printLine('(keine MCP-Server zum Proben gefunden)');
        return;
      }
      const timeoutMs = Number.parseInt(opts.timeout, 10);
      const concurrency = Number.parseInt(opts.concurrency, 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        console.error(`Fehler: --timeout muss eine positive Zahl sein, war "${opts.timeout}"`);
        process.exit(2);
      }
      const probes = await probeServers(discovery.servers, { timeoutMs, concurrency });
      if (globalOpts.json === true) {
        printJson({ probes });
        return;
      }
      const aliveCount = probes.filter((p) => p.result.kind === 'alive').length;
      printLine(
        `${probes.length} MCP-Server probed — ${aliveCount} alive, ${probes.length - aliveCount} mit Problemen.\n`,
      );
      for (const p of probes) {
        const marker = p.result.kind === 'alive' ? '[ALIVE]' : '[FAIL]';
        const extra =
          p.result.kind === 'alive'
            ? `${p.result.toolsCount} Tools, ${p.result.durationMs}ms, protocol ${p.result.protocolVersion}`
            : `${p.result.kind}: ${'message' in p.result ? p.result.message : 'siehe kind'}`;
        printLine(`${marker} ${p.entry.name}  (${p.entry.host})`);
        printLine(`    ${extra}`);
        if (p.result.kind === 'crashed' && p.result.stderr.length > 0) {
          const preview = p.result.stderr.slice(0, 200);
          printLine(`    stderr: ${preview}${p.result.stderr.length > 200 ? '...' : ''}`);
        }
        printLine('');
      }
    });
}
