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

/**
 * m14 (2026-05-21 code-review): Whitelist von runtime-essentials die
 * an 3rd-party MCP-Server weitergegeben werden. ALLES andere
 * (CLAUDE_OS_SECRETS_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.) wird
 * blockiert sodass nur die `entry.env`-explizit-deklarierten keys + die
 * minimalen OS-essentials sichtbar sind.
 */
const MCP_ENV_PASSTHROUGH = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMSPEC',
]);

export function buildCuratedMcpEnv(
  parentEnv: NodeJS.ProcessEnv,
  entryEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (MCP_ENV_PASSTHROUGH.has(k) && v !== undefined) out[k] = v;
  }
  // Caller-supplied env (aus mcp.json) override / extend
  if (entryEnv !== undefined) {
    for (const [k, v] of Object.entries(entryEnv)) {
      out[k] = v;
    }
  }
  return out;
}

export type ProbeResult =
  | { kind: 'alive'; toolsCount: number; durationMs: number; protocolVersion: string }
  | { kind: 'init-timeout'; durationMs: number; message: string }
  | { kind: 'crashed'; durationMs: number; exitCode: number | null; stderr: string }
  | { kind: 'protocol-error'; durationMs: number; message: string }
  | { kind: 'spawn-failed'; durationMs: number; message: string }
  | { kind: 'trust-required'; durationMs: number; serverKey: string; message: string };

export interface ProbeOpts {
  /** Gesamt-Timeout in ms (Default 5000). */
  readonly timeoutMs?: number;
  /** Tests injecten spawn. */
  readonly spawnFn?: typeof spawn;
  /**
   * M3 (2026-05-21 code-review): optionaler trust-check. Wenn gesetzt,
   * wird `isTrusted(serverKey)` VOR dem spawn evaluiert. Liefert `false`
   * → ProbeResult.kind = 'trust-required' OHNE jemals den Server-Process
   * zu starten.
   *
   * `serverKey` ist der stable Identifier (typically `<host>:<entry.name>`)
   * den der Caller (z. B. watcher) als trust-key benutzt.
   */
  readonly isTrusted?: (serverKey: string) => boolean;
  /** Wenn `isTrusted` gesetzt ist, MUSS der Caller auch `serverKey` liefern. */
  readonly serverKey?: string;
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

  // M3 (2026-05-21 code-review): trust-check VOR dem spawn. Wenn die
  // serverKey nicht in der trust-list ist, KEIN spawn — wir wollen
  // arbitrary-binaries nicht ausfuehren bevor User explizit zugestimmt
  // hat. GUI zeigt dann ein "Trust this server?"-Modal und ruft
  // `mcp.trust.acknowledge(serverKey)` was den naechsten probe-Call
  // dann durchlaesst.
  if (opts.isTrusted !== undefined) {
    const serverKey = opts.serverKey;
    if (serverKey === undefined || serverKey.length === 0) {
      return {
        kind: 'spawn-failed',
        durationMs: Date.now() - start,
        message: 'M3: probeServer mit isTrusted aber ohne serverKey aufgerufen — internal-bug',
      };
    }
    if (!opts.isTrusted(serverKey)) {
      return {
        kind: 'trust-required',
        durationMs: Date.now() - start,
        serverKey,
        message: `MCP-Server "${serverKey}" ist nicht in der trust-list — User-Acknowledge erforderlich vor erstem probe`,
      };
    }
  }

  let child: ChildProcess;
  // m14 (2026-05-21 code-review): den probed MCP-Server NICHT mit full
  // sidecar-env starten — sonst sehen 3rd-party MCP-Server unsere
  // `CLAUDE_OS_SECRETS_KEY`, `ANTHROPIC_API_KEY`, GITHUB_TOKEN, etc.
  // Nur die runtime-essentials (PATH, locale, HOME) + die in
  // `entry.env` explizit deklarierten keys werden weitergegeben.
  const curatedEnv = buildCuratedMcpEnv(process.env, entry.env);
  try {
    child = spawnImpl(entry.command, [...entry.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: curatedEnv,
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
  // M31 (2026-05-21 code-review): protocolVersion in local closure-var
  // statt auf `entry` zu mutieren — caller bekommt sein Entry-Object
  // ohne Side-effect-Mutation zurueck.
  let probedProtocolVersion: string | undefined;
  // M32 (2026-05-21 code-review): per-stream line-buffer fuer split
  // JSON-RPC-Responses. Wenn der MCP-Server eine grosse `tools/list`-
  // Antwort emittiert, kann sie ueber mehrere stdout-`data`-Events
  // splitten — `tryParseJsonLine` failt dann auf beiden Halbteilen.
  // Wir buffern bis `\n` ankommt.
  let stdoutPartialLine = '';

  // Track REAL exit (nicht nur "signal gesendet") fuer den SIGKILL-Fallback.
  // `child.killed` ist nach erfolgreichem kill('SIGTERM') sofort true — das
  // sagt nichts darueber aus ob der Process tatsaechlich gestorben ist.
  // SIGTERM-resistante Server (z. B. Node-Prozesse die signal handler
  // installieren) wuerden ohne diesen flag nie SIGKILL bekommen.
  child.once('exit', () => {
    childExited = true;
  });

  return await new Promise<ProbeResult>((resolve) => {
    function finish(result: ProbeResult): void {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // child already exited
      }
      // n4 (2026-05-23 todo-audit): killFallbackTimer ist jetzt
      // function-lokal — closure-level let + `void`-Lint-Suppressor
      // war nicht noetig (Variable wird nur hier gelesen+geschrieben).
      const killFallbackTimer = setTimeout(() => {
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
      // M32 (2026-05-21 code-review): newline-Boundaries respektieren.
      // Wenn ein chunk mitten in einer JSON-Response endet, buffern wir
      // den Trail bis das naechste chunk den Rest plus \n liefert.
      stdoutPartialLine += chunk.toString('utf8');
      const parts = stdoutPartialLine.split('\n');
      stdoutPartialLine = parts.pop() ?? '';
      for (const rawLine of parts) {
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
            probedProtocolVersion = result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
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
            const protocolVersion = probedProtocolVersion ?? MCP_PROTOCOL_VERSION;
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
  opts: ProbeOpts & {
    concurrency?: number;
    /**
     * M3: derived serverKey-per-entry, fuer trust-check vor jedem
     * einzelnen spawn. Wenn nicht gesetzt, wird `entry.name` als
     * fallback verwendet.
     */
    serverKeyFor?: (entry: McpServerEntry) => string;
  } = {},
): Promise<ReadonlyArray<{ entry: McpServerEntry; result: ProbeResult }>> {
  const concurrency = opts.concurrency ?? 3;
  const queue = [...entries];
  const out: { entry: McpServerEntry; result: ProbeResult }[] = [];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) return;
      // M3: bei isTrusted-Mode den serverKey pro Entry berechnen
      const perEntryOpts: ProbeOpts =
        opts.isTrusted !== undefined
          ? {
              ...opts,
              serverKey: opts.serverKeyFor !== undefined ? opts.serverKeyFor(entry) : entry.name,
            }
          : opts;
      const result = await probeServer(entry, perEntryOpts);
      out.push({ entry, result });
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
