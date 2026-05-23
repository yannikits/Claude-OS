/**
 * MCP-Watcher — periodischer Re-Probe aller entdeckten MCP-Server
 * (v1.7 Phase A, Cowork-OS-Integrationsplan Feature 1).
 *
 * Sequenz pro Tick (Default alle 60s):
 *  1. `discoverMcpClients()` neu — User-Aenderungen an Configs werden
 *     mit gepickt up.
 *  2. `probeServers(entries, {concurrency: 3})` — spawnt jeden Server
 *     kurz, MCP-initialize+tools/list-Roundtrip, kill.
 *  3. Status-Cache pro Server-Key aktualisieren.
 *  4. Pro Server-Status-Update wird ein WatcherEvent emittiert
 *     (transport-agnostisch via injectable `emit`-Callback).
 *
 * Skip-on-Overlap: wenn vorheriger Tick noch laeuft (z. B. weil
 * timeoutMs hoch ist und ein Server haengt), wird der naechste Tick
 * uebersprungen statt zu pile-up.
 *
 * Stop(): tickt nicht mehr, laufender Tick wird abgewartet.
 *
 * @module @domains/mcp-clients/watcher
 */

import { discoverMcpClients } from './discovery.js';
import { type ProbeResult, probeServers } from './live-probe.js';
import type { McpServerEntry } from './types.js';

export interface WatcherStatusEntry {
  readonly entry: McpServerEntry;
  readonly result: ProbeResult;
  /** Wann der Status zuletzt aktualisiert wurde (ISO 8601). */
  readonly probedAt: string;
}

export interface WatcherEvent {
  readonly type: 'tick-started' | 'tick-finished' | 'status-changed' | 'skip-overlap';
  readonly timestamp: string;
  /** Bei status-changed: der server-key (`<host>:<name>`). */
  readonly serverKey?: string;
  /** Bei status-changed: neuer ProbeResult-kind. */
  readonly kind?: ProbeResult['kind'];
  /** Bei tick-finished: Anzahl der probed servers. */
  readonly probedCount?: number;
  readonly message?: string;
}

export interface WatcherOpts {
  /** Tick-Intervall in ms (Default 60_000). */
  readonly tickMs?: number;
  /** Probe-Timeout pro Server in ms (Default 10_000). Heavy MCP-Server wie
   *  claude-flow brauchen >5s zum Initialisieren. */
  readonly probeTimeoutMs?: number;
  /** Concurrency-Cap fuer parallele Probes (Default 3). */
  readonly concurrency?: number;
  /** Wird pro Event aufgerufen (transport-agnostisch). */
  readonly emit: (event: WatcherEvent) => void;
  /** Tests: Override fuer setTimeout. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Tests: Override fuer clock. */
  readonly now?: () => Date;
  /** Tests: Override fuer discovery. */
  readonly discover?: () => { servers: readonly McpServerEntry[] };
  /** Tests: Override fuer probe-batch. */
  readonly probe?: (
    entries: readonly McpServerEntry[],
    opts: {
      timeoutMs: number;
      concurrency: number;
      isTrusted?: (serverKey: string) => boolean;
      serverKeyFor?: (entry: McpServerEntry) => string;
    },
  ) => Promise<ReadonlyArray<{ entry: McpServerEntry; result: ProbeResult }>>;
  /** Project-cwd fuer .claude/mcp.json-Discovery (default process.cwd()). */
  readonly projectCwd?: string;
  /**
   * M3 (2026-05-21 code-review): optionaler trust-check pro Server.
   * Wenn gesetzt, werden NICHT-acknowledged servers in der probe-batch
   * als `trust-required` markiert OHNE spawn. Default `undefined` →
   * back-compat (alle servers werden gespawnt). Sidecar wired das
   * automatisch mit dem persistenten `McpTrustStore`.
   */
  readonly isTrusted?: (serverKey: string) => boolean;
}

function serverKeyOf(entry: McpServerEntry): string {
  return `${entry.host}:${entry.name}`;
}

export interface WatcherHandle {
  /** Stoppt den Tick-Loop. Wartet auf einen laufenden Tick. */
  stop: () => Promise<void>;
  /** Aktueller Snapshot des Status-Cache (Server-Key -> Status). */
  snapshot: () => ReadonlyMap<string, WatcherStatusEntry>;
  /**
   * Triggered ein sofortiges Re-Probe fuer einen einzelnen Server statt
   * auf den naechsten Tick zu warten. Returnt den neuen StatusEntry
   * (oder null wenn der serverKey nicht im aktuellen Cache ist).
   */
  reprobe: (serverKey: string) => Promise<WatcherStatusEntry | null>;
}

export function startMcpWatcher(opts: WatcherOpts): WatcherHandle {
  const tickMs = opts.tickMs ?? 60_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;
  const concurrency = opts.concurrency ?? 3;
  const now = opts.now ?? (() => new Date());
  const setTimer = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const discoverImpl =
    opts.discover ?? (() => discoverMcpClients({ projectCwd: opts.projectCwd ?? process.cwd() }));
  const probeImpl = opts.probe ?? probeServers;

  const cache = new Map<string, WatcherStatusEntry>();
  let stopped = false;
  let tickInFlight = false;
  let timerHandle: unknown = null;
  let inFlightSettled: Promise<void> = Promise.resolve();

  async function runTick(): Promise<void> {
    if (stopped) return;
    if (tickInFlight) {
      opts.emit({
        type: 'skip-overlap',
        timestamp: now().toISOString(),
        message: 'vorheriger Tick laeuft noch',
      });
      return;
    }
    tickInFlight = true;
    opts.emit({ type: 'tick-started', timestamp: now().toISOString() });
    let resolveInflight: () => void = () => {};
    inFlightSettled = new Promise<void>((res) => {
      resolveInflight = res;
    });
    try {
      const discovery = discoverImpl();
      const results = await probeImpl(discovery.servers, {
        timeoutMs: probeTimeoutMs,
        concurrency,
        // M3: per-Tick fresh trust-check (User koennte zwischen Ticks
        // einen Server acknowledged/revoked haben).
        ...(opts.isTrusted === undefined
          ? {}
          : {
              isTrusted: opts.isTrusted,
              serverKeyFor: serverKeyOf,
            }),
      });
      for (const { entry, result } of results) {
        const key = serverKeyOf(entry);
        const prev = cache.get(key);
        const nextEntry: WatcherStatusEntry = {
          entry,
          result,
          probedAt: now().toISOString(),
        };
        cache.set(key, nextEntry);
        if (prev === undefined || prev.result.kind !== result.kind) {
          opts.emit({
            type: 'status-changed',
            timestamp: nextEntry.probedAt,
            serverKey: key,
            kind: result.kind,
          });
        }
      }
      // Server die nicht mehr entdeckt werden — aus dem Cache loeschen
      const discoveredKeys = new Set(discovery.servers.map(serverKeyOf));
      for (const oldKey of [...cache.keys()]) {
        if (!discoveredKeys.has(oldKey)) cache.delete(oldKey);
      }
      opts.emit({
        type: 'tick-finished',
        timestamp: now().toISOString(),
        probedCount: results.length,
      });
    } finally {
      tickInFlight = false;
      resolveInflight();
      scheduleNext();
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timerHandle = setTimer(() => {
      void runTick();
    }, tickMs);
  }

  // Erster Tick mit kleinem Delay damit Caller seine Listener anhaengen kann
  timerHandle = setTimer(() => {
    void runTick();
  }, 50);

  async function stop(): Promise<void> {
    stopped = true;
    if (timerHandle !== null) clearTimer(timerHandle);
    await inFlightSettled;
  }

  async function reprobe(serverKey: string): Promise<WatcherStatusEntry | null> {
    const prev = cache.get(serverKey);
    if (prev === undefined) return null;
    // M3 hardening (Codex review 2026-05-24, BUG-Fix): reprobe MUSS
    // den isTrusted-Gate auch durchsetzen — sonst kann ein Caller
    // (z. B. via `mcp.clients.reprobe`-RPC) den Trust-Gate
    // umgehen indem er einen unacknowledged-server reprobet.
    // Spiegelt das gleiche Pattern wie runTick() (s. o.).
    const results = await probeImpl([prev.entry], {
      timeoutMs: probeTimeoutMs,
      concurrency: 1,
      ...(opts.isTrusted === undefined
        ? {}
        : {
            isTrusted: opts.isTrusted,
            serverKeyFor: serverKeyOf,
          }),
    });
    const first = results[0];
    if (first === undefined) return null;
    const nextEntry: WatcherStatusEntry = {
      entry: first.entry,
      result: first.result,
      probedAt: now().toISOString(),
    };
    cache.set(serverKey, nextEntry);
    if (prev.result.kind !== first.result.kind) {
      opts.emit({
        type: 'status-changed',
        timestamp: nextEntry.probedAt,
        serverKey,
        kind: first.result.kind,
      });
    }
    return nextEntry;
  }

  return {
    stop,
    snapshot: () => new Map(cache),
    reprobe,
  };
}
