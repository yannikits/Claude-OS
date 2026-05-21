/**
 * Live-Probe für entdeckte MCP-Server — spawnt jeden konfigurierten
 * Server, sendet einen MCP-Initialize+ListTools-Roundtrip, killt den
 * Prozess wieder. Klassifiziert das Ergebnis (`alive` / `init-timeout`
 * / `crashed` / `protocol-error`).
 *
 * Klar abgegrenzt: das ist KEIN persistenter Health-Watcher. Live-
 * Probe ist read-only "spawn + check + kill". Der Watcher (laufende
 * Health-Checks alle N Sekunden) ist v1.7+-Material wenn die GUI das
 * braucht.
 *
 * Implementation:
 *  - `spawn(command, args, {env, stdio: ['pipe','pipe','pipe']})`
 *  - schreibt MCP-Initialize-JSON-RPC auf stdin
 *  - liest stdout zeilenweise; erste valide Response wird parsed
 *  - sendet `tools/list` request
 *  - wartet auf Response
 *  - kill (SIGTERM + 1s SIGKILL fallback)
 *  - cap: 5s Gesamt-Timeout pro Server
 *
 * MCP-Protokoll-Details: Spec v2024-11-05. Mindest-Felder fuer
 * Initialize: `{jsonrpc: "2.0", id: 1, method: "initialize", params:
 * {protocolVersion: "2024-11-05", capabilities: {}, clientInfo:
 * {name, version}}}`. Server muss capabilities zurueckgeben.
 *
 * @module @domains/mcp-clients/live-probe
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { McpServerEntry } from './types.js';

export type ProbeResult =
  | { kind: 'alive'; toolsCount: number; durationMs: number; protocolVersion: string }
  | { kind: 'init-timeout'; durationMs: number; message: string }
  | { kind: 'crashed'; durationMs: number; exitCode: number | null; stderr: string }
  | { kind: 'protocol-error'; durationMs: number; message: string }
  | { kind: 'spawn-failed'; durationMs: number; message: string };

export interface ProbeOpts {
  /** Gesamt-Timeout in ms (Default 5000). */
  readonly timeoutMs?: number;
  /** Tests injecten spawn. */
  readonly spawnFn?: typeof spawn;
}

const MCP_PROTOCOL_VERSION = '2024-11-05';

function buildInit(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'claude-os-probe', version: '1.6.0' },
    },
  });
}

function buildInitialized(): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
}

function buildListTools(id: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function tryParseJsonLine(line: string): JsonRpcResponse | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed) as JsonRpcResponse;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Probt einen einzelnen MCP-Server live. Resolved IMMER (kein Reject)
 * — Fehler landen als typed Result.
 */
export async function probeServer(
  entry: McpServerEntry,
  opts: ProbeOpts = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const spawnImpl = opts.spawnFn ?? spawn;
  const start = Date.now();
  let child: ChildProcess;
  try {
    child = spawnImpl(entry.command, [...entry.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(entry.env ?? {}) },
      shell:
        entry.command.toLowerCase().endsWith('.cmd') ||
        entry.command.toLowerCase().endsWith('.bat'),
      windowsHide: true,
    });
  } catch (err) {
    return {
      kind: 'spawn-failed',
      durationMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let resolved = false;
  let childExited = false;
  const stderrBuf: string[] = [];
  const stdoutLines: string[] = [];
  const pendingIds = new Set<number>([1, 2]);

  // Track REAL exit (nicht nur "signal gesendet") fuer den SIGKILL-Fallback.
  // `child.killed` ist nach erfolgreichem kill('SIGTERM') sofort true — das
  // sagt nichts darueber aus ob der Process tatsaechlich gestorben ist.
  // SIGTERM-resistante Server (z. B. Node-Prozesse die signal handler
  // installieren) wuerden ohne diesen flag nie SIGKILL bekommen.
  child.once('exit', () => {
    childExited = true;
  });

  return await new Promise<ProbeResult>((resolve) => {
    let killFallbackTimer: NodeJS.Timeout | null = null;
    function finish(result: ProbeResult): void {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // child already exited
      }
      killFallbackTimer = setTimeout(() => {
        if (!childExited) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore — process verschwand zwischen check und kill
          }
        }
        // Wenn der Process schon tot ist, ist das ein no-op — kein Cleanup
        // mehr noetig, weil wir die Promise bereits resolved haben.
      }, 1000);
      // Wenn Node beendet wird bevor der Fallback feuert, soll das den
      // Process nicht festhalten.
      killFallbackTimer.unref?.();
      resolve(result);
    }
    // Belegen damit lint zufrieden ist (killFallbackTimer wird oben gesetzt).
    void killFallbackTimer;

    const overallTimer = setTimeout(() => {
      finish({
        kind: 'init-timeout',
        durationMs: Date.now() - start,
        message: `Server hat nach ${timeoutMs}ms keine valide Initialize-Response gesendet`,
      });
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf.push(chunk.toString('utf8'));
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const rawLine of text.split('\n')) {
        if (rawLine === '') continue;
        stdoutLines.push(rawLine);
        const msg = tryParseJsonLine(rawLine);
        if (msg === null) continue;
        if (msg.error !== undefined) {
          clearTimeout(overallTimer);
          finish({
            kind: 'protocol-error',
            durationMs: Date.now() - start,
            message: `JSON-RPC error: ${msg.error.code} ${msg.error.message}`,
          });
          return;
        }
        if (typeof msg.id === 'number' && pendingIds.has(msg.id)) {
          pendingIds.delete(msg.id);
          if (msg.id === 1) {
            // Initialize geantwortet — sende initialized + tools/list
            const result = msg.result as { protocolVersion?: string } | undefined;
            (entry as { _probeProtocolVersion?: string })._probeProtocolVersion =
              result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
            try {
              child.stdin?.write(`${buildInitialized()}\n`);
              child.stdin?.write(`${buildListTools(2)}\n`);
            } catch (err) {
              clearTimeout(overallTimer);
              finish({
                kind: 'protocol-error',
                durationMs: Date.now() - start,
                message: `stdin-Write fuer initialized+tools/list scheiterte: ${err instanceof Error ? err.message : String(err)}`,
              });
              return;
            }
          } else if (msg.id === 2) {
            // tools/list geantwortet — Probe erfolgreich
            const result = msg.result as { tools?: unknown[] } | undefined;
            const toolsCount = Array.isArray(result?.tools) ? (result?.tools?.length ?? 0) : 0;
            const protocolVersion =
              (entry as { _probeProtocolVersion?: string })._probeProtocolVersion ??
              MCP_PROTOCOL_VERSION;
            clearTimeout(overallTimer);
            finish({
              kind: 'alive',
              durationMs: Date.now() - start,
              toolsCount,
              protocolVersion,
            });
            return;
          }
        }
      }
    });

    child.on('exit', (code) => {
      if (resolved) return;
      clearTimeout(overallTimer);
      finish({
        kind: 'crashed',
        durationMs: Date.now() - start,
        exitCode: code,
        stderr: stderrBuf.join(''),
      });
    });

    child.on('error', (err) => {
      if (resolved) return;
      clearTimeout(overallTimer);
      finish({
        kind: 'spawn-failed',
        durationMs: Date.now() - start,
        message: err.message,
      });
    });

    // Trigger: Initialize-Request senden
    try {
      child.stdin?.write(`${buildInit(1)}\n`);
    } catch (err) {
      clearTimeout(overallTimer);
      finish({
        kind: 'protocol-error',
        durationMs: Date.now() - start,
        message: `stdin-Write fuer initialize scheiterte: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }).then((result) => {
    // small grace period damit kill durchgeht
    return delay(50).then(() => result);
  });
}

/**
 * Probt mehrere Server parallel. Limit ist `concurrency` (Default 3)
 * damit wir nicht Dutzende Prozesse auf einmal spawnen.
 */
export async function probeServers(
  entries: readonly McpServerEntry[],
  opts: ProbeOpts & { concurrency?: number } = {},
): Promise<ReadonlyArray<{ entry: McpServerEntry; result: ProbeResult }>> {
  const concurrency = opts.concurrency ?? 3;
  const queue = [...entries];
  const out: { entry: McpServerEntry; result: ProbeResult }[] = [];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) return;
      const result = await probeServer(entry, opts);
      out.push({ entry, result });
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
