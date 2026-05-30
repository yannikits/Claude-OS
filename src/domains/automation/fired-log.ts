/**
 * Bounded in-memory log of recent rule firings. The engine emits FiredActions
 * transiently (SSE); the read-only dashboard polls, so it needs a small
 * server-side history that survives page reloads. Capacity-bounded ring buffer
 * — oldest entries drop once full.
 *
 * @module @domains/automation/fired-log
 */
import type { FiredAction } from './evaluator.js';

export interface LoggedFiring extends FiredAction {
  /** ISO-8601 UTC timestamp of when the action fired. */
  readonly firedAt: string;
}

export interface FiredActionLog {
  record(fired: FiredAction): void;
  /** Recent firings, newest-first. */
  recent(): LoggedFiring[];
}

export interface FiredActionLogOpts {
  /** Max retained firings (default 100). */
  readonly capacity?: number;
  /** Test-injection: clock. Default `() => new Date()`. */
  readonly now?: () => Date;
}

export function createFiredActionLog(opts: FiredActionLogOpts = {}): FiredActionLog {
  const capacity = opts.capacity ?? 100;
  const now = opts.now ?? (() => new Date());
  const buffer: LoggedFiring[] = []; // oldest-first

  return {
    record(fired) {
      buffer.push({ ...fired, firedAt: now().toISOString() });
      if (buffer.length > capacity) {
        buffer.splice(0, buffer.length - capacity);
      }
    },
    recent() {
      return [...buffer].reverse();
    },
  };
}
