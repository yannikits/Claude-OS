/**
 * Automation engine runner — the stateful glue around the pure pieces.
 *
 * Each tick: pull a snapshot (cache-hit-friendly — the aggregator only
 * re-probes when its own TTL lapses, so a 60s tick does NOT add probe load),
 * diff it against the previously-seen snapshot, evaluate the freshly-loaded
 * rules against the resulting state-changes, and emit each FiredAction.
 *
 * Mirrors `startScheduler`'s shape: test-injectable timers, a transport-
 * agnostic `emit`, and a `stop()`. Rules are re-loaded every tick so edits to
 * the YAML take effect live. A `getSnapshot` failure is reported via `onError`
 * and never kills the loop (ARCHITECTURE.md §8) — `prev` is left untouched so
 * the next successful tick still detects the transition.
 *
 * @module @domains/automation/engine
 */
import type { AggregateSnapshot } from '../msp-aggregate/types.js';
import { evaluateRules, type FiredAction } from './evaluator.js';
import type { Rule } from './rule-schema.js';
import { diffSnapshots } from './state-diff.js';

export interface AutomationEngineOpts {
  /** Re-read every tick so YAML edits take effect live. */
  readonly loadRules: () => readonly Rule[];
  /** Cache-hit-friendly snapshot source (the MSP-health aggregator). */
  readonly getSnapshot: () => Promise<AggregateSnapshot>;
  /** Called once per fired action. Transport-agnostic. */
  readonly emit: (fired: FiredAction) => void;
  /** Tick interval in ms (default 60_000). */
  readonly tickMs?: number;
  /** Reported on a getSnapshot/evaluation failure; the loop keeps running. */
  readonly onError?: (err: unknown) => void;
  /** Test-injection: setTimeout replacement. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Test-injection: clearTimeout replacement. */
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

export function startAutomationEngine(opts: AutomationEngineOpts): { stop: () => void } {
  const tickMs = opts.tickMs ?? 60_000;
  const setTimer =
    opts.setTimeoutFn ??
    ((cb, ms) => {
      const handle = setTimeout(cb, ms);
      handle.unref();
      return handle;
    });
  const clearTimer = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  let prev: AggregateSnapshot | null = null;
  let stopped = false;
  let timerHandle: unknown = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const snapshot = await opts.getSnapshot();
      const changes = diffSnapshots(prev, snapshot);
      prev = snapshot;
      if (changes.length > 0) {
        for (const fired of evaluateRules(opts.loadRules(), changes)) {
          opts.emit(fired);
        }
      }
    } catch (err) {
      opts.onError?.(err);
    }
    scheduleNext();
  }

  function scheduleNext(): void {
    if (stopped) return;
    // `tick` returns a promise; setTimeout ignores it at runtime, and a
    // `() => Promise<void>` is assignable to the `() => void` timer param.
    // Passing it directly (not wrapped) lets test harnesses await one tick.
    timerHandle = setTimer(tick, tickMs);
  }

  timerHandle = setTimer(tick, 50);

  return {
    stop(): void {
      stopped = true;
      if (timerHandle !== null) clearTimer(timerHandle);
    },
  };
}
