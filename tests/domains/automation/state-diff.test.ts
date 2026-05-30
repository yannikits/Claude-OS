import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../../src/domains/automation/index.js';
import type { AggregateSnapshot } from '../../../src/domains/msp-aggregate/types.js';

/** Build a minimal AggregateSnapshot from {slug: {bridge: statusKind}}. */
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

describe('diffSnapshots', () => {
  it('emits no changes when prev is null (baseline tick)', () => {
    expect(diffSnapshots(null, snap({ acme: { sophos: 'unreachable' } }))).toEqual([]);
  });

  it('emits no changes when nothing changed', () => {
    expect(
      diffSnapshots(snap({ acme: { sophos: 'ok' } }), snap({ acme: { sophos: 'ok' } })),
    ).toEqual([]);
  });

  it('emits a change when a cell kind transitions', () => {
    const prev = snap({ acme: { sophos: 'ok' } });
    const cur = snap({ acme: { sophos: 'unreachable' } });
    expect(diffSnapshots(prev, cur)).toEqual([
      { slug: 'acme', bridge: 'sophos', from: 'ok', to: 'unreachable' },
    ]);
  });

  it('emits one change per transitioned cell across rows and bridges', () => {
    const prev = snap({ acme: { sophos: 'ok', veeam: 'ok' }, beta: { tanss: 'ok' } });
    const cur = snap({
      acme: { sophos: 'unreachable', veeam: 'ok' },
      beta: { tanss: 'auth-failed' },
    });
    const changes = diffSnapshots(prev, cur);
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({
      slug: 'acme',
      bridge: 'sophos',
      from: 'ok',
      to: 'unreachable',
    });
    expect(changes).toContainEqual({
      slug: 'beta',
      bridge: 'tanss',
      from: 'ok',
      to: 'auth-failed',
    });
  });

  it('ignores newly-appeared cells/rows (no prior state to diff against)', () => {
    const prev = snap({ acme: { sophos: 'ok' } });
    const cur = snap({ acme: { sophos: 'ok' }, beta: { tanss: 'unreachable' } });
    expect(diffSnapshots(prev, cur)).toEqual([]);
  });
});
