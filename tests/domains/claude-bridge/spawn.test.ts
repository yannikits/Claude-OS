import { describe, it, expect } from 'vitest';
import { spawnClaudeBridge } from '../../../src/domains/claude-bridge/index.js';

/**
 * Integration tests for the streaming spawn wrapper. `binaryPath` is
 * overridden with `process.execPath` (the running Node binary) so the
 * tests don't depend on a real Anthropic claude install. Argument
 * scripts use `-e` so behavior is fully controlled.
 */
describe('spawnClaudeBridge', () => {
  it('resolves with exitCode 0 for a clean child exit', async () => {
    const result = await spawnClaudeBridge({
      binaryPath: process.execPath,
      args: ['-e', 'process.exit(0)'],
      heartbeatIntervalMs: 0,
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.binary.source).toBe('override');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('propagates non-zero exit codes', async () => {
    const result = await spawnClaudeBridge({
      binaryPath: process.execPath,
      args: ['-e', 'process.exit(42)'],
      heartbeatIntervalMs: 0,
    });
    expect(result.exitCode).toBe(42);
  });

  it('rejects with BinaryNotFoundError when binaryPath does not exist', async () => {
    await expect(
      spawnClaudeBridge({
        binaryPath: '/definitely/not/a/real/path/claude',
        args: [],
        heartbeatIntervalMs: 0,
      }),
    ).rejects.toThrow(/Explicit binary path/);
  });

  it('survives running with a non-zero heartbeat interval', async () => {
    const result = await spawnClaudeBridge({
      binaryPath: process.execPath,
      // Sleep ~200 ms so several 50 ms heartbeats land.
      args: ['-e', 'setTimeout(() => process.exit(0), 200)'],
      heartbeatIntervalMs: 50,
    });
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
  });
});
