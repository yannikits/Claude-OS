import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getIndexStats,
  type MemoryWatcherHandle,
  openIndex,
  startMemoryIndexWatcher,
} from '../../../src/domains/memory-index/index.js';
import { type NoteFrontmatter, writeNote } from '../../../src/domains/notes/index.js';

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
    this.closeCalls++;
    return Promise.resolve();
  }
}

const fm = (overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
  ...overrides,
});

interface Captured {
  timers: { setTimeoutCalls: Array<() => void>; clearedCount: number };
  watcher: FakeWatcher | null;
  handle: MemoryWatcherHandle;
}

async function setup(
  vault: string,
  overrides: { saveDebounceMs?: number; forceUsePolling?: boolean } = {},
): Promise<{
  opened: Awaited<ReturnType<typeof openIndex>>;
  captured: Captured;
}> {
  const opened = await openIndex({ vaultRoot: vault });
  let captured: FakeWatcher | null = null;
  const timers = {
    setTimeoutCalls: [] as Array<() => void>,
    clearedCount: 0,
  };
  const fakeSetTimeout = ((cb: () => void) => {
    timers.setTimeoutCalls.push(cb);
    return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const fakeClearTimeout = (() => {
    timers.clearedCount++;
  }) as unknown as typeof clearTimeout;

  const handle = startMemoryIndexWatcher({
    vaultRoot: vault,
    db: opened.db,
    dbPath: opened.dbPath,
    saveDebounceMs: overrides.saveDebounceMs ?? 100,
    ...(overrides.forceUsePolling === undefined
      ? {}
      : { forceUsePolling: overrides.forceUsePolling }),
    chokidarFactory: (path, options) => {
      captured = new FakeWatcher(path, options);
      return captured as unknown as ReturnType<typeof import('chokidar').watch>;
    },
    timers: { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout },
  });

  return {
    opened,
    captured: { timers, watcher: captured, handle },
  };
}

describe('startMemoryIndexWatcher', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'mi-watch-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('creates a watcher targeting the workspaces dir with ignoreInitial + awaitWriteFinish', async () => {
    const { opened, captured } = await setup(vault);
    expect(captured.watcher).not.toBeNull();
    const opts = captured.watcher?.options as {
      ignoreInitial: boolean;
      awaitWriteFinish: { stabilityThreshold: number };
      ignored: string[];
    };
    expect(opts.ignoreInitial).toBe(true);
    expect(opts.awaitWriteFinish.stabilityThreshold).toBe(500);
    expect(opts.ignored).toContain('**/.claude-os/**');
    expect(captured.watcher?.path.replace(/\\/g, '/')).toContain('/Claude-OS/workspaces');
    await captured.handle.stop();
    opened.db.close();
  });

  it('indexes a note on `add` and schedules a debounced save', async () => {
    const { opened, captured } = await setup(vault);
    const wrote = writeNote(vault, 'personal', 'a.md', fm(), 'BM25 kubernetes notes');
    captured.watcher?.emit('add', wrote.path);

    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(1);
    expect(captured.timers.setTimeoutCalls.length).toBe(1);

    const status = captured.handle.status();
    expect(status.addCount).toBe(1);
    expect(status.saveCount).toBe(0);

    // Fire the debounced save callback.
    const pendingSave = captured.timers.setTimeoutCalls.pop();
    pendingSave?.();
    expect(captured.handle.status().saveCount).toBe(1);

    await captured.handle.stop();
    opened.db.close();
  });

  it('coalesces multiple add/change events into one save via debounce', async () => {
    const { opened, captured } = await setup(vault);
    const a = writeNote(vault, 'personal', 'a.md', fm(), 'A');
    const b = writeNote(vault, 'personal', 'b.md', fm(), 'B');
    captured.watcher?.emit('add', a.path);
    captured.watcher?.emit('add', b.path);
    captured.watcher?.emit('change', a.path);

    // Each event schedules a fresh timer + clears the previous one,
    // so the most-recent callback is the only one that actually saves.
    expect(captured.timers.clearedCount).toBeGreaterThanOrEqual(2);
    const last = captured.timers.setTimeoutCalls.pop();
    last?.();
    expect(captured.handle.status().saveCount).toBe(1);

    await captured.handle.stop();
    opened.db.close();
  });

  it('removes a note on `unlink`', async () => {
    const { opened, captured } = await setup(vault);
    const a = writeNote(vault, 'personal', 'a.md', fm(), 'A');
    captured.watcher?.emit('add', a.path);
    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(1);

    captured.watcher?.emit('unlink', a.path);
    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(0);
    expect(captured.handle.status().unlinkCount).toBe(1);

    await captured.handle.stop();
    opened.db.close();
  });

  it('ignores non-.md events', async () => {
    const { opened, captured } = await setup(vault);
    captured.watcher?.emit('add', '/tmp/random.txt');
    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(0);
    expect(captured.handle.status().addCount).toBe(1); // count bumped
    expect(captured.timers.setTimeoutCalls.length).toBe(0); // no save scheduled
    await captured.handle.stop();
    opened.db.close();
  });

  it('forwards watcher errors to onWatcherError sink', async () => {
    const errors: unknown[] = [];
    const opened = await openIndex({ vaultRoot: vault });
    let captured: FakeWatcher | null = null;
    const handle = startMemoryIndexWatcher({
      vaultRoot: vault,
      db: opened.db,
      dbPath: opened.dbPath,
      saveDebounceMs: 100,
      chokidarFactory: (path, options) => {
        captured = new FakeWatcher(path, options);
        return captured as unknown as ReturnType<typeof import('chokidar').watch>;
      },
      onWatcherError: (err) => errors.push(err),
    });
    captured?.emit('error', new Error('EMFILE'));
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe('EMFILE');
    expect(handle.status().errorCount).toBe(1);
    await handle.stop();
    opened.db.close();
  });

  it('flush() saves immediately, stop() flushes any pending', async () => {
    const { opened, captured } = await setup(vault);
    const a = writeNote(vault, 'personal', 'a.md', fm(), 'A');
    captured.watcher?.emit('add', a.path);
    // Don't fire the debounce timer — call flush directly.
    expect(captured.handle.flush()).toBe(true);
    expect(captured.handle.status().saveCount).toBe(1);

    // Second flush with no dirty state -> false, no extra save.
    expect(captured.handle.flush()).toBe(false);
    expect(captured.handle.status().saveCount).toBe(1);

    await captured.handle.stop();
    opened.db.close();
  });

  it('honours forceUsePolling override', async () => {
    const { opened, captured } = await setup(vault, { forceUsePolling: true });
    const opts = captured.watcher?.options as { usePolling?: boolean };
    expect(opts.usePolling).toBe(true);
    expect(captured.handle.status().usePolling).toBe(true);
    await captured.handle.stop();
    opened.db.close();
  });
});
