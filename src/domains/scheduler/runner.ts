/**
 * Scheduler-Runner — Tick-Loop, fuehrt faellige Schedule-Eintraege aus.
 *
 * Phase 2 zum CRUD-Foundation aus PR #37. Das v1.5-MVP:
 *
 *  - Pro Tick (Default 60s) `readSchedules()` neu lesen — User kann
 *    waehrend Runner-Laufzeit Eintraege add/remove/disable.
 *  - Fuer jeden enabled Entry: `parseCron + nextFire(letzte-tick-Zeit)`
 *    prufen. Liegt der next-fire VOR oder GLEICH dem aktuellen Tick,
 *    feuern.
 *  - Skip-on-Overlap: pro Entry-Id wird ein In-Flight-Flag gehalten.
 *    Ein neuer Fire wird uebersprungen wenn der vorherige Lauf noch
 *    nicht beendet ist.
 *  - Output landet zeilenweise als JSON-RPC-Notification ueber den
 *    injected `notify`-Callback (RPC-Wire kommt durch den Sidecar; das
 *    Domain hier ist transport-agnostisch).
 *
 * @module @domains/scheduler/runner
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { nextFire, type ParsedCron, parseCron } from './cron-parser.js';
import { readSchedules } from './store.js';
import type { ScheduleEntry } from './types.js';

export interface SchedulerEvent {
  readonly type: 'fire' | 'skip-overlap' | 'output' | 'exit' | 'parse-error';
  readonly entryId: string;
  readonly timestamp: string;
  readonly stream?: 'stdout' | 'stderr';
  readonly line?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly message?: string;
}

export interface RunnerOpts {
  /** dataDir der schedules.json. */
  readonly dataDir: string;
  /** Tick-Intervall in ms (Default 60_000). */
  readonly tickMs?: number;
  /** Wird pro Event aufgerufen (transport-agnostisch). */
  readonly emit: (event: SchedulerEvent) => void;
  /** Test-Injection: setTimeout-Replacement. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Test-Injection: clock. Default `() => new Date()`. */
  readonly now?: () => Date;
  /** Test-Injection: Process-Spawner. */
  readonly spawnFn?: typeof spawn;
}

/**
 * Startet den Scheduler-Runner. Gibt eine `stop()`-Funktion zurueck die
 * den Tick-Loop und alle laufenden Child-Processes terminiert.
 */
export function startScheduler(opts: RunnerOpts): { stop: () => Promise<void> } {
  const tickMs = opts.tickMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  const setTimer = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const spawnImpl = opts.spawnFn ?? spawn;

  // Pro Entry-Id: ob aktuell ein Child laeuft + Cache der parsedCron
  // damit wir nicht jeden Tick re-parsen.
  const inFlight = new Map<string, ChildProcess>();
  const parsedCache = new Map<string, { raw: string; parsed: ParsedCron }>();
  // lastTickAt initial leicht IN DIE VERGANGENHEIT setzen damit der
  // erste Tick faellige Eintraege aus dem gerade-zurueckliegenden
  // Intervall mitnimmt. Cron-Semantik: ein "* * * * *"-Entry der bei
  // 10:00:30 startet soll beim ersten Tick feuern.
  let lastTickAt = new Date(now().getTime() - tickMs);
  let stopped = false;
  let timerHandle: unknown = null;

  function getParsed(entry: ScheduleEntry): ParsedCron | null {
    const cached = parsedCache.get(entry.id);
    if (cached !== undefined && cached.raw === entry.cron) return cached.parsed;
    try {
      const parsed = parseCron(entry.cron);
      parsedCache.set(entry.id, { raw: entry.cron, parsed });
      return parsed;
    } catch (err) {
      opts.emit({
        type: 'parse-error',
        entryId: entry.id,
        timestamp: now().toISOString(),
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  function fireEntry(entry: ScheduleEntry): void {
    if (inFlight.has(entry.id)) {
      opts.emit({
        type: 'skip-overlap',
        entryId: entry.id,
        timestamp: now().toISOString(),
        message: 'vorheriger Lauf laeuft noch',
      });
      return;
    }
    opts.emit({ type: 'fire', entryId: entry.id, timestamp: now().toISOString() });
    const child = spawnImpl(entry.command, [], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    inFlight.set(entry.id, child);

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.length === 0) continue;
        opts.emit({
          type: 'output',
          entryId: entry.id,
          timestamp: now().toISOString(),
          stream: 'stdout',
          line,
        });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.length === 0) continue;
        opts.emit({
          type: 'output',
          entryId: entry.id,
          timestamp: now().toISOString(),
          stream: 'stderr',
          line,
        });
      }
    });
    child.on('exit', (code, signal) => {
      inFlight.delete(entry.id);
      opts.emit({
        type: 'exit',
        entryId: entry.id,
        timestamp: now().toISOString(),
        exitCode: code,
        signal,
      });
    });
    child.on('error', (err) => {
      inFlight.delete(entry.id);
      opts.emit({
        type: 'parse-error',
        entryId: entry.id,
        timestamp: now().toISOString(),
        message: `spawn-error: ${err.message}`,
      });
    });
  }

  function tick(): void {
    if (stopped) return;
    const tickAt = now();
    let store: ReturnType<typeof readSchedules>;
    try {
      store = readSchedules(opts.dataDir);
    } catch (err) {
      opts.emit({
        type: 'parse-error',
        entryId: '*',
        timestamp: tickAt.toISOString(),
        message: `readSchedules: ${err instanceof Error ? err.message : String(err)}`,
      });
      scheduleNext();
      return;
    }
    for (const entry of store.entries) {
      if (entry.enabled === false) continue;
      const parsed = getParsed(entry);
      if (parsed === null) continue;
      // Wenn next-fire zwischen lastTickAt und tickAt liegt, feuern.
      const next = nextFire(parsed, lastTickAt);
      if (next === null) continue;
      if (next.getTime() <= tickAt.getTime()) {
        fireEntry(entry);
      }
    }
    lastTickAt = tickAt;
    scheduleNext();
  }

  function scheduleNext(): void {
    if (stopped) return;
    timerHandle = setTimer(tick, tickMs);
  }

  // Ersten Tick mit kleinem Delay starten — gibt Caller Zeit eigene
  // Listener anzuhaengen bevor Events fliegen.
  timerHandle = setTimer(tick, 50);

  async function stop(): Promise<void> {
    stopped = true;
    if (timerHandle !== null) clearTimer(timerHandle);
    // Alle laufenden Children mit 2s-SIGKILL-Fallback terminieren.
    const kills = Array.from(inFlight.values()).map((child) => {
      return new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // process already exited
          }
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    });
    await Promise.all(kills);
    inFlight.clear();
  }

  return { stop };
}
