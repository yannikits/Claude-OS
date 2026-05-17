/**
 * Time-based heartbeat helper for long-running bridge sessions.
 *
 * Fires `tick(elapsedMs)` on a fixed interval so callers (pino logger,
 * GUI status bar) can observe child-process liveness without inspecting
 * stdio streams — which is required when running with `stdio: 'inherit'`.
 *
 * @module @domains/claude-bridge/heartbeat
 */

export interface Heartbeat {
  /** Stops the heartbeat. Idempotent. */
  stop(): void;
}

export function startHeartbeat(intervalMs: number, tick: (elapsedMs: number) => void): Heartbeat {
  if (intervalMs <= 0) return { stop: () => {} };
  const startedAt = Date.now();
  const handle = setInterval(() => {
    tick(Date.now() - startedAt);
  }, intervalMs);
  // Avoid keeping the event-loop alive solely because of the heartbeat.
  handle.unref?.();
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}
