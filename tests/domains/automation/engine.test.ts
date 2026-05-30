import { describe, expect, it } from 'vitest';
import type { FiredAction, Rule } from '../../../src/domains/automation/index.js';
import { startAutomationEngine } from '../../../src/domains/automation/index.js';
import type { AggregateSnapshot } from '../../../src/domains/msp-aggregate/types.js';

function snap(rows: Record<string, Record<string, string>>): AggregateSnapshot {
  return {
    snapshotAt: '2026-05-30T00:00:00Z',
    durationMs: 1,
    registeredBridges: [],
    rows: Object.entries(rows).map(([slug, cells]) => ({
      slug,
      displayName: slug,
      cells: Object.fromEntries(
        Object.entries(cells).map(([bridge, kind]) => [bridge, { kind, message: 'x' }]),
      ),
    })),
  } as unknown as AggregateSnapshot;
}

const sophosOffline: Rule = {
  id: 'sophos-offline',
  trigger: { bridge: 'sophos', customers: 'all' },
  condition: { statusIn: ['unreachable'] },
  actions: [{ type: 'dashboard-alert', message: 'Sophos down' }],
};

interface Harness {
  tickOnce: () => Promise<void>;
  emitted: FiredAction[];
  errors: unknown[];
  stop: () => void;
}

function makeEngine(snaps: AggregateSnapshot[], rules: readonly Rule[] = [sophosOffline]): Harness {
  let pending: (() => void | Promise<void>) | null = null;
  const emitted: FiredAction[] = [];
  const errors: unknown[] = [];
  let i = 0;
  const handle = startAutomationEngine({
    loadRules: () => rules,
    getSnapshot: async () => {
      const s = snaps[Math.min(i, snaps.length - 1)];
      i += 1;
      if (s === undefined) throw new Error('no snapshot queued');
      return s;
    },
    emit: (fired) => emitted.push(fired),
    onError: (err) => errors.push(err),
    setTimeoutFn: (cb) => {
      pending = cb;
      return 1;
    },
    clearTimeoutFn: () => {
      pending = null;
    },
  });
  return {
    emitted,
    errors,
    stop: handle.stop,
    tickOnce: async () => {
      const cb = pending;
      pending = null;
      await cb?.();
    },
  };
}

describe('startAutomationEngine', () => {
  it('establishes a baseline on the first tick and fires nothing', async () => {
    const h = makeEngine([snap({ acme: { sophos: 'unreachable' } })]);
    await h.tickOnce();
    expect(h.emitted).toEqual([]);
  });

  it('fires once when a transition appears between two ticks', async () => {
    const h = makeEngine([
      snap({ acme: { sophos: 'ok' } }),
      snap({ acme: { sophos: 'unreachable' } }),
    ]);
    await h.tickOnce(); // baseline ok
    await h.tickOnce(); // ok -> unreachable
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.ruleId).toBe('sophos-offline');
    expect(h.emitted[0]?.slug).toBe('acme');
  });

  it('does not re-fire while the status stays unchanged', async () => {
    const h = makeEngine([
      snap({ acme: { sophos: 'ok' } }),
      snap({ acme: { sophos: 'unreachable' } }),
      snap({ acme: { sophos: 'unreachable' } }),
    ]);
    await h.tickOnce();
    await h.tickOnce();
    await h.tickOnce();
    expect(h.emitted).toHaveLength(1);
  });

  it('survives a getSnapshot error and keeps ticking', async () => {
    let i = 0;
    const seq = [snap({ acme: { sophos: 'ok' } }), null, snap({ acme: { sophos: 'unreachable' } })];
    let pending: (() => void | Promise<void>) | null = null;
    const emitted: FiredAction[] = [];
    const errors: unknown[] = [];
    startAutomationEngine({
      loadRules: () => [sophosOffline],
      getSnapshot: async () => {
        const s = seq[i];
        i += 1;
        if (s === null || s === undefined) throw new Error('probe failed');
        return s;
      },
      emit: (f) => emitted.push(f),
      onError: (e) => errors.push(e),
      setTimeoutFn: (cb) => {
        pending = cb;
        return 1;
      },
      clearTimeoutFn: () => {
        pending = null;
      },
    });
    const tick = async (): Promise<void> => {
      const cb = pending;
      pending = null;
      await cb?.();
    };
    await tick(); // baseline ok
    await tick(); // throws -> onError, prev stays ok
    await tick(); // ok -> unreachable, fires
    expect(errors).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it('stops ticking after stop()', async () => {
    const h = makeEngine([
      snap({ acme: { sophos: 'ok' } }),
      snap({ acme: { sophos: 'unreachable' } }),
    ]);
    await h.tickOnce(); // baseline
    h.stop();
    await h.tickOnce(); // should be a no-op
    expect(h.emitted).toEqual([]);
  });

  it('does not emit when stop() fires while a tick is mid-getSnapshot', async () => {
    const ok = snap({ acme: { sophos: 'ok' } });
    const down = snap({ acme: { sophos: 'unreachable' } });
    let resolveSecond: (s: AggregateSnapshot) => void = () => {};
    let call = 0;
    let pending: (() => void | Promise<void>) | null = null;
    const emitted: FiredAction[] = [];
    const handle = startAutomationEngine({
      loadRules: () => [sophosOffline],
      getSnapshot: () => {
        call += 1;
        if (call === 1) return Promise.resolve(ok);
        return new Promise<AggregateSnapshot>((r) => {
          resolveSecond = r;
        });
      },
      emit: (f) => emitted.push(f),
      setTimeoutFn: (cb) => {
        pending = cb;
        return 1;
      },
      clearTimeoutFn: () => {
        pending = null;
      },
    });
    await pending?.(); // tick 1 — baseline (ok)
    const t2 = pending?.(); // tick 2 — starts, blocks on the pending getSnapshot
    handle.stop(); // stop() while tick 2 is mid-await
    resolveSecond(down); // ok -> unreachable would normally fire
    await t2;
    expect(emitted).toEqual([]); // re-check after await suppresses the emit
  });
});
