import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusyFlag, type BusyState } from '../../../src/domains/vault-sync/index.js';

describe('BusyFlag', () => {
  let tmpBase: string;
  let filePath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-busy-'));
    filePath = join(tmpBase, 'vault-sync-state.json');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeFlag(
    overrides: Partial<{
      hostname: string;
      pid: number;
      isPidAlive: (pid: number) => boolean;
      now: () => Date;
    }> = {},
  ): BusyFlag {
    return new BusyFlag({
      filePath,
      hostname: overrides.hostname ?? 'test-host',
      pid: overrides.pid ?? 1234,
      isPidAlive: overrides.isPidAlive ?? (() => true),
      now: overrides.now ?? (() => new Date('2026-05-17T10:00:00.000Z')),
    });
  }

  it('starts with no state file', () => {
    const flag = makeFlag();
    expect(flag.read()).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('acquire writes the envelope and read returns it', () => {
    const flag = makeFlag();
    expect(flag.acquire('snapshot')).toBe(true);
    const state = flag.read();
    expect(state).not.toBeNull();
    expect(state?.busy).toBe(true);
    expect(state?.reason).toBe('snapshot');
    expect(state?.pid).toBe(1234);
    expect(state?.hostname).toBe('test-host');
    expect(state?.acquiredAt).toBe('2026-05-17T10:00:00.000Z');
  });

  it('blocks a second acquire while the first PID is alive on the same host', () => {
    const owner = makeFlag({ pid: 100, isPidAlive: () => true });
    expect(owner.acquire('snapshot')).toBe(true);

    const challenger = makeFlag({ pid: 200, isPidAlive: () => true });
    expect(challenger.acquire('snapshot-2')).toBe(false);
  });

  it('treats same-host state as stale when the PID is dead', () => {
    const owner = makeFlag({ pid: 100, isPidAlive: () => true });
    owner.acquire('snapshot');

    const successor = makeFlag({
      pid: 200,
      isPidAlive: (pid) => pid !== 100,
    });
    expect(successor.acquire('snapshot-2')).toBe(true);
  });

  it('treats cross-host state as non-stale even if local PID-probe would say dead', () => {
    const flagA = makeFlag({ hostname: 'machine-A', pid: 100, isPidAlive: () => false });
    flagA.acquire('snapshot');

    const flagB = makeFlag({ hostname: 'machine-B', pid: 100, isPidAlive: () => false });
    expect(flagB.acquire('snapshot')).toBe(false);
  });

  it('release clears the state file', () => {
    const flag = makeFlag();
    flag.acquire('snapshot');
    flag.release();
    expect(flag.read()).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('release is a no-op when not held', () => {
    const flag = makeFlag();
    expect(() => flag.release()).not.toThrow();
  });

  it('forceReset clears state held by another host', () => {
    const flagA = makeFlag({ hostname: 'machine-A', pid: 99, isPidAlive: () => true });
    flagA.acquire('snapshot');

    const flagB = makeFlag({ hostname: 'machine-B', pid: 200 });
    flagB.forceReset();
    expect(flagB.read()).toBeNull();
  });

  it('returns null for corrupt JSON on disk', () => {
    writeFileSync(filePath, '{not real json');
    const flag = makeFlag();
    expect(flag.read()).toBeNull();
  });

  it('returns null for type-mismatched envelope', () => {
    const bogus = { busy: 'no', reason: 1, pid: 'p', hostname: null, acquiredAt: 5 };
    writeFileSync(filePath, JSON.stringify(bogus));
    const flag = makeFlag();
    expect(flag.read()).toBeNull();
  });

  it('persists ISO-8601 with millisecond precision via custom now()', () => {
    const fixed = new Date('2026-05-17T08:30:15.987Z');
    const flag = makeFlag({ now: () => fixed });
    flag.acquire('snapshot');
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BusyState;
    expect(parsed.acquiredAt).toBe('2026-05-17T08:30:15.987Z');
  });
});
