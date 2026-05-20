import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type McpServerEntry,
  type ProbeResult,
  startMcpWatcher,
  type WatcherEvent,
} from '../../../src/domains/mcp-clients/index.js';

let events: WatcherEvent[] = [];

class TimerHarness {
  private cb: (() => void) | null = null;
  setTimeoutFn = (cb: () => void, _ms: number): unknown => {
    this.cb = cb;
    return Symbol('h');
  };
  clearTimeoutFn = (_h: unknown): void => {
    this.cb = null;
  };
  async fire(): Promise<void> {
    const cb = this.cb;
    this.cb = null;
    if (cb !== null) {
      cb();
      // Tick ist async — warte einen Microtask-Cycle
      await new Promise((r) => setImmediate(r));
    }
  }
}

function makeEntry(name: string): McpServerEntry {
  return {
    name,
    host: 'claude-desktop',
    sourcePath: `/fake/${name}.json`,
    command: 'node',
    args: [],
    enabled: true,
  };
}

beforeEach(() => {
  events = [];
});

afterEach(() => {
  // nothing — TimerHarness ist per-test
});

describe('startMcpWatcher', () => {
  it('emittiert tick-started + tick-finished beim ersten Tick', async () => {
    const harness = new TimerHarness();
    const discover = vi.fn(() => ({ servers: [makeEntry('alpha')] }));
    const probe = vi.fn(async (entries: readonly McpServerEntry[]) =>
      entries.map((e) => ({
        entry: e,
        result: {
          kind: 'alive' as const,
          toolsCount: 1,
          durationMs: 10,
          protocolVersion: '2024-11-05',
        },
      })),
    );
    const handle = startMcpWatcher({
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      discover,
      probe,
    });
    await harness.fire();
    expect(events.map((e) => e.type)).toContain('tick-started');
    expect(events.map((e) => e.type)).toContain('tick-finished');
    expect(events.find((e) => e.type === 'tick-finished')?.probedCount).toBe(1);
    await handle.stop();
  });

  it('snapshot enthaelt probed servers', async () => {
    const harness = new TimerHarness();
    const probe = vi.fn(async () => [
      {
        entry: makeEntry('beta'),
        result: {
          kind: 'alive',
          toolsCount: 2,
          durationMs: 5,
          protocolVersion: 'X',
        } satisfies ProbeResult,
      },
    ]);
    const handle = startMcpWatcher({
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      discover: () => ({ servers: [makeEntry('beta')] }),
      probe,
    });
    await harness.fire();
    const snap = handle.snapshot();
    expect(snap.size).toBe(1);
    const entry = snap.get('claude-desktop:beta');
    expect(entry?.result.kind).toBe('alive');
    expect(entry?.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await handle.stop();
  });

  it('emittiert status-changed nur wenn kind sich aendert', async () => {
    const harness = new TimerHarness();
    let probeKind: ProbeResult['kind'] = 'alive';
    const probe = vi.fn(async () => [
      {
        entry: makeEntry('gamma'),
        result:
          probeKind === 'alive'
            ? ({ kind: 'alive', toolsCount: 1, durationMs: 5, protocolVersion: 'X' } as ProbeResult)
            : ({ kind: 'crashed', durationMs: 5, exitCode: 1, stderr: 'boom' } as ProbeResult),
      },
    ]);
    const handle = startMcpWatcher({
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      discover: () => ({ servers: [makeEntry('gamma')] }),
      probe,
    });
    await harness.fire(); // erster Tick — neuer Server (alive) → status-changed
    const firstChanged = events.filter((e) => e.type === 'status-changed').length;
    expect(firstChanged).toBe(1);
    expect(events.find((e) => e.type === 'status-changed')?.kind).toBe('alive');

    // gleicher kind → KEIN neues status-changed
    await harness.fire();
    expect(events.filter((e) => e.type === 'status-changed').length).toBe(1);

    // jetzt kind aendern
    probeKind = 'crashed';
    await harness.fire();
    const allChanges = events.filter((e) => e.type === 'status-changed');
    expect(allChanges.length).toBe(2);
    expect(allChanges[1]?.kind).toBe('crashed');
    await handle.stop();
  });

  it('reprobe(serverKey) triggered Re-Probe und emittiert status-changed wenn kind sich aendert', async () => {
    const harness = new TimerHarness();
    let probeKind: ProbeResult['kind'] = 'alive';
    const probe = vi.fn(async (entries: readonly McpServerEntry[]) =>
      entries.map((e) => ({
        entry: e,
        result:
          probeKind === 'alive'
            ? ({ kind: 'alive', toolsCount: 1, durationMs: 5, protocolVersion: 'X' } as ProbeResult)
            : ({ kind: 'crashed', durationMs: 5, exitCode: 2, stderr: 'oops' } as ProbeResult),
      })),
    );
    const handle = startMcpWatcher({
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      discover: () => ({ servers: [makeEntry('delta')] }),
      probe,
    });
    await harness.fire(); // Initial-Tick populated den Cache mit 'alive'
    const key = 'claude-desktop:delta';
    probeKind = 'crashed';
    const result = await handle.reprobe(key);
    expect(result?.result.kind).toBe('crashed');
    expect(events.filter((e) => e.type === 'status-changed').length).toBe(2);
    await handle.stop();
  });

  it('reprobe(unknownKey) liefert null statt zu throwen', async () => {
    const harness = new TimerHarness();
    const handle = startMcpWatcher({
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      discover: () => ({ servers: [] }),
      probe: async () => [],
    });
    await harness.fire();
    const result = await handle.reprobe('not-in-cache');
    expect(result).toBeNull();
    await handle.stop();
  });

  it('entfernt Server aus Cache wenn sie nicht mehr entdeckt werden', async () => {
    const harness = new TimerHarness();
    let discovered = [makeEntry('to-be-removed')];
    const probe = vi.fn(async (entries: readonly McpServerEntry[]) =>
      entries.map((e) => ({
        entry: e,
        result: {
          kind: 'alive',
          toolsCount: 1,
          durationMs: 5,
          protocolVersion: 'X',
        } as ProbeResult,
      })),
    );
    const handle = startMcpWatcher({
      emit: (e) => events.push(e),
      setTimeoutFn: harness.setTimeoutFn,
      clearTimeoutFn: harness.clearTimeoutFn,
      discover: () => ({ servers: discovered }),
      probe,
    });
    await harness.fire();
    expect(handle.snapshot().size).toBe(1);
    discovered = [];
    await harness.fire();
    expect(handle.snapshot().size).toBe(0);
    await handle.stop();
  });
});
