import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultScheduler } from '../../../src/domains/vault-sync/index.js';

/**
 * Tests use an injected fake chokidar so behaviour is deterministic and
 * does not depend on FS event timing. Real-FS roundtrip is covered by
 * Phase 2f integration tests.
 */

class FakeWatcher extends EventEmitter {
  closeCalls = 0;
  readonly path: string;
  readonly options: unknown;
  constructor(path: string, options: unknown) {
    super();
    this.path = path;
    this.options = options;
  }
  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

function makeScheduler(
  overrides: {
    idleMs?: number;
    onSnapshot?: (reason: string) => Promise<unknown>;
    workTree?: string;
    forceUsePolling?: boolean;
  } = {},
): {
  scheduler: VaultScheduler;
  capturedWatcher: () => FakeWatcher | null;
  watcherOptions: () => unknown;
} {
  let captured: FakeWatcher | null = null;
  const scheduler = new VaultScheduler({
    workTree: overrides.workTree ?? '/tmp/fake-vault',
    idleMs: overrides.idleMs ?? 50,
    onSnapshot: overrides.onSnapshot ?? (() => Promise.resolve()),
    ...(overrides.forceUsePolling === undefined
      ? {}
      : { forceUsePolling: overrides.forceUsePolling }),
    chokidarFactory: (path, options) => {
      captured = new FakeWatcher(path, options);
      return captured as unknown as ReturnType<typeof import('chokidar').watch>;
    },
  });
  return {
    scheduler,
    capturedWatcher: () => captured,
    watcherOptions: () => captured?.options,
  };
}

describe('VaultScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with running=false and no snapshot recorded', () => {
    const { scheduler } = makeScheduler();
    const status = scheduler.status();
    expect(status.running).toBe(false);
    expect(status.eventsSinceLastSnapshot).toBe(0);
    expect(status.pendingTimerSetAt).toBeNull();
    expect(status.lastSnapshotAt).toBeNull();
  });

  it('creates chokidar watcher on start with ignoreInitial + awaitWriteFinish set', () => {
    const { scheduler, capturedWatcher } = makeScheduler();
    scheduler.start();
    expect(scheduler.status().running).toBe(true);
    const watcher = capturedWatcher();
    expect(watcher).not.toBeNull();
    const opts = watcher?.options as Record<string, unknown>;
    expect(opts.ignoreInitial).toBe(true);
    expect(opts.awaitWriteFinish).toMatchObject({ stabilityThreshold: 2000 });
    expect(opts.atomic).toBe(100);
  });

  it('defaults to native events (usePolling=false) on non-cloud paths', () => {
    const { scheduler, watcherOptions } = makeScheduler({ workTree: '/var/local-disk/vault' });
    scheduler.start();
    expect(scheduler.status().usePolling).toBe(false);
    const opts = watcherOptions() as Record<string, unknown>;
    expect(opts.usePolling).toBe(false);
  });

  it('switches to polling on OneDrive paths', () => {
    const { scheduler, watcherOptions } = makeScheduler({
      workTree: 'C:\\Users\\me\\OneDrive\\Claude\\vault',
    });
    scheduler.start();
    expect(scheduler.status().usePolling).toBe(true);
    expect(scheduler.status().cloudProvider).toBe('onedrive');
    const opts = watcherOptions() as Record<string, unknown>;
    expect(opts.usePolling).toBe(true);
    expect(opts.interval).toBe(2000);
    expect(opts.binaryInterval).toBe(5000);
  });

  it('forceUsePolling overrides cloud auto-detect', () => {
    const { scheduler } = makeScheduler({
      workTree: '/var/local-disk/vault',
      forceUsePolling: true,
    });
    scheduler.start();
    expect(scheduler.status().usePolling).toBe(true);
  });

  it('triggers onSnapshot after idle window with no further events', async () => {
    const onSnapshot = vi.fn().mockResolvedValue(undefined);
    const { scheduler } = makeScheduler({ idleMs: 100, onSnapshot });
    scheduler.start();
    scheduler.notifyEventForTest();
    expect(scheduler.status().eventsSinceLastSnapshot).toBe(1);
    expect(onSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]?.[0]).toMatch(/^idle-\d+-events$/);
  });

  it('resets the idle timer on each event', async () => {
    const onSnapshot = vi.fn().mockResolvedValue(undefined);
    const { scheduler } = makeScheduler({ idleMs: 100, onSnapshot });
    scheduler.start();
    scheduler.notifyEventForTest();
    await vi.advanceTimersByTimeAsync(60);
    scheduler.notifyEventForTest();
    await vi.advanceTimersByTimeAsync(60);
    expect(onSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it('blockt second concurrent fire waehrend snapshot in-flight ist', async () => {
    let resolveSnapshot: (() => void) | null = null;
    const snapshotPromise = new Promise<void>((resolve) => {
      resolveSnapshot = resolve;
    });
    const onSnapshot = vi.fn().mockReturnValue(snapshotPromise);
    const { scheduler } = makeScheduler({ idleMs: 50, onSnapshot });
    scheduler.start();
    scheduler.notifyEventForTest();
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(scheduler.status().inFlight).toBe(true);

    // Burst von events WAEHREND in-flight — der timer feuert nochmal,
    // aber inFlight ist gesetzt, also wird die Snapshot-Anfrage als
    // pendingFire gemerkt (NICHT silent verworfen wie vor C4-Fix).
    scheduler.notifyEventForTest();
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(scheduler.status().inFlight).toBe(true);

    // Erste snapshot abschliessen. finally-Hook sieht pendingFire=true
    // UND events>0 → triggert sofort einen zweiten snapshot.
    resolveSnapshot?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it('C4-Fix: events waehrend in-flight werden in der naechsten Snapshot-Runde gedraint, NICHT orphaned', async () => {
    // Reproducer fuer die race: ohne C4-Fix wuerde der zweite Snapshot
    // silent verworfen weil fireSnapshot beim inFlight-Check NUR return
    // hat. Mit Fix: pendingFire merkt sich es, finally-Hook re-fired.
    let resolveSnapshot: (() => void) | null = null;
    const firstSnap = new Promise<void>((resolve) => {
      resolveSnapshot = resolve;
    });
    const onSnapshot = vi.fn().mockReturnValueOnce(firstSnap).mockResolvedValue(undefined);

    const { scheduler } = makeScheduler({ idleMs: 50, onSnapshot });
    scheduler.start();

    // t=0: event arrives, timer T1 at t=50
    scheduler.notifyEventForTest();
    // t=50: T1 fires → fireSnapshot → inFlight=true, events=0, onSnapshot called
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(scheduler.status().inFlight).toBe(true);

    // t=50+ε: event arrives mid-flight, increments events, timer T2 at t=100
    scheduler.notifyEventForTest();
    expect(scheduler.status().eventsSinceLastSnapshot).toBe(1);

    // t=100: T2 fires → fireSnapshot finds inFlight=true → pendingFire=true, return
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    await Promise.resolve();
    // Snapshot count noch 1 (zweiter wurde geblockt)
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(scheduler.status().eventsSinceLastSnapshot).toBe(1); // events nicht reset

    // Erste snapshot abschliessen
    resolveSnapshot?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Jetzt MUSS der zweite Snapshot triggered worden sein (C4 fix);
    // ohne Fix wuerde count bei 1 bleiben.
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    // Events fuer die zweite Runde geclaimt
    expect(scheduler.status().eventsSinceLastSnapshot).toBe(0);
  });

  it('stop clears the timer and closes the watcher', async () => {
    const { scheduler, capturedWatcher } = makeScheduler({ idleMs: 100 });
    scheduler.start();
    scheduler.notifyEventForTest();
    expect(scheduler.status().pendingTimerSetAt).not.toBeNull();
    await scheduler.stop();
    expect(scheduler.status().running).toBe(false);
    expect(scheduler.status().pendingTimerSetAt).toBeNull();
    expect(capturedWatcher()?.closeCalls).toBe(1);
  });
});
