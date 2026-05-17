import { describe, expect, it } from 'vitest';
import { spawnClaudeBridge } from '../../../src/domains/claude-bridge/index.js';

/**
 * Long-running regression guard against Memory 569 / 577 / 578 — the
 * original `claude.exe` bridge cut the child off at ~120 s because of
 * a full stdout buffer. With `stdio: 'inherit'` (Phase 3b) buffering
 * happens outside our process, so the bug cannot reproduce by design.
 *
 * This test validates that *nothing* in our wrapper (heartbeat timers,
 * signal handlers, kill grace, etc.) introduces an alternate timeout.
 * The child is a Node process that sleeps 180 s and exits cleanly.
 *
 * Skipped unless `$RUN_SLOW_TESTS=1` so `npm test` stays fast. To run:
 *   $env:RUN_SLOW_TESTS = "1"; npx vitest run tests/domains/claude-bridge/long-running.test.ts
 */
const RUN_SLOW = process.env.RUN_SLOW_TESTS === '1';

describe.skipIf(!RUN_SLOW)('claude-bridge long-running 180s', () => {
  it('survives a 180s child process without truncation or timeout', async () => {
    const result = await spawnClaudeBridge({
      binaryPath: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 180_000)'],
      heartbeatIntervalMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(180_000);
  }, 200_000);
});
