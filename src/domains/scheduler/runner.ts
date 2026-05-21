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

export class CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandParseError';
  }
}

/**
 * Token-split a command string into `[cmd, ...args]` for spawn without
 * shell. Quoting via `"` or `'`. Backslash is NOT an escape char —
 * Windows paths like `C:\Program Files\app.exe` must survive intact.
 * Users wanting a literal `"` inside an arg should wrap the arg in
 * single-quotes (or vice-versa).
 *
 * Throws CommandParseError on unterminated quotes — silently accepting
 * them would let malformed schedules execute instead of failing fast.
 */
export function parseCommandTokens(input: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        inToken = true; // empty quoted string still produces a token
        continue;
      }
      current += ch;
      inToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote !== null) {
    throw new CommandParseError(`unterminated ${quote}-quoted string in command "${input}"`);
  }
  if (inToken) tokens.push(current);
  return tokens;
}

// Shell-metachar set that would re-introduce injection if `cmd` itself
// (not args) is passed through `shell: true`. Node 20+ escapes args, but
// not the command path. We refuse shell-mode if cmd contains any of these.
// Backslash ist KEIN Metachar — Windows-Pfade `C:\Tools\app.exe` muessen
// shell-mode (.cmd/.bat oder extensionless) durchlaufen koennen. Aber
// `%` (cmd.exe env-expansion) und `!` (DelayedExpansion) MUESSEN dabei
// blockiert werden — Codex-Round-2 finding.
const SHELL_METACHARS = /[&|<>"^();`$%!]/;

/**
 * Pick spawn-mode for a parsed command. Windows shells (`.cmd`/`.bat`)
 * require `shell: true` so cmd.exe handles arg-escaping (CVE-2024-27980
 * fix). Extensionless tokens on Windows also need shell-mode because
 * Node's `spawn` won't apply PATHEXT — `node` won't find `node.exe`.
 * On all other platforms or with an explicit executable extension,
 * shell:false is safe.
 */
export function chooseShellMode(cmd: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  if (/\.(cmd|bat)$/i.test(cmd)) return true;
  // Extensionless on Windows → needs PATHEXT resolution via shell.
  if (!/\.[a-z0-9]+$/i.test(cmd)) return true;
  return false;
}

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
  /** Test-Injection: platform (default `process.platform`). Influences spawn shell-mode. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Startet den Scheduler-Runner. Gibt eine `stop()`-Funktion zurueck die
 * den Tick-Loop und alle laufenden Child-Processes terminiert.
 */
export function startScheduler(opts: RunnerOpts): { stop: () => Promise<void> } {
  const tickMs = opts.tickMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  // M25 (2026-05-21 code-review): default-setTimer muss `.unref()` damit
  // der Scheduler-tick-loop den Node-Prozess NICHT lebendig haelt wenn
  // sonst nichts mehr offen ist. Test-Injection laesst .unref weg —
  // FakeTimers brauchen es nicht.
  const setTimer =
    opts.setTimeoutFn ??
    ((cb, ms) => {
      const handle = setTimeout(cb, ms);
      handle.unref();
      return handle;
    });
  const clearTimer = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const spawnImpl = opts.spawnFn ?? spawn;
  const platform = opts.platform ?? process.platform;

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
    // C1 (2026-05-21 code-review): parse command in argv-tokens und
    // spawne OHNE shell. Verhindert shell-injection via `; & | $()` in
    // FREEFORM-input. Auf Windows bleibt shell:true noetig fuer .cmd/.bat
    // sowie extensionlose Tokens (PATHEXT-Resolution). Node 20+ escapt
    // dann die Args (CVE-2024-27980-Fix); zusaetzlich validieren wir
    // dass `cmd` selbst metachar-frei ist (cmd.exe parsed den Pfad).
    let tokens: readonly string[];
    try {
      tokens = parseCommandTokens(entry.command);
    } catch (err) {
      opts.emit({
        type: 'parse-error',
        entryId: entry.id,
        timestamp: now().toISOString(),
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const cmd = tokens[0];
    if (cmd === undefined || cmd.length === 0) {
      opts.emit({
        type: 'parse-error',
        entryId: entry.id,
        timestamp: now().toISOString(),
        message: `command parse: empty token list from "${entry.command}"`,
      });
      return;
    }
    const args = tokens.slice(1);
    const useShell = chooseShellMode(cmd, platform);
    if (useShell && SHELL_METACHARS.test(cmd)) {
      opts.emit({
        type: 'parse-error',
        entryId: entry.id,
        timestamp: now().toISOString(),
        message: `command parse: refusing shell-mode for cmd containing shell metacharacters: "${cmd}"`,
      });
      return;
    }
    opts.emit({ type: 'fire', entryId: entry.id, timestamp: now().toISOString() });
    const child = spawnImpl(cmd, args, {
      shell: useShell,
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
