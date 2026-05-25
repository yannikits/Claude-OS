/**
 * Incremental memory-index watcher (Phase 3c).
 *
 * Wraps a chokidar watcher on `<vault>/Claude-OS/workspaces/`. Each
 * `add` / `change` re-indexes the file; each `unlink` removes the row.
 * sql.js persistence is debounced — we batch index mutations in memory
 * and write the DB to disk a few seconds after the last event, so
 * editing many notes in quick succession doesn't trigger one full
 * export per save.
 *
 * Cloud-mount auto-detect (per Lesson 2026-05-15) switches chokidar to
 * polling for OneDrive/GDrive/Dropbox where native FS events are
 * unreliable.
 *
 * Same injectable-factory + timer + error-sink pattern as the existing
 * `vault-sync/scheduler.ts` so tests stay deterministic.
 *
 * @module @domains/memory-index/watcher
 */
import { statSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Database } from 'sql.js';
import { detectCloudProvider } from '../../core/environment/index.js';
import { workspacesDir } from '../workspace/index.js';
import { saveIndex } from './database.js';
import { type IndexerLog, indexNote, removeNote } from './indexer.js';

type ChokidarFactory = (paths: string, options: Parameters<typeof chokidar.watch>[1]) => FSWatcher;

export interface MemoryWatcherOpts {
  readonly vaultRoot: string;
  readonly db: Database;
  readonly dbPath: string;
  /** Debounce window before persisting the DB to disk. Default 5_000 ms. */
  readonly saveDebounceMs?: number;
  /** Override cloud-polling decision (auto-detected by default). */
  readonly forceUsePolling?: boolean;
  /** Inject chokidar (tests). */
  readonly chokidarFactory?: ChokidarFactory;
  /** Inject timers (tests). */
  readonly timers?: {
    readonly setTimeout: typeof setTimeout;
    readonly clearTimeout: typeof clearTimeout;
  };
  /** Optional logger sink. Default no-op. */
  readonly log?: IndexerLog;
  /** Surfaces chokidar-level errors (EMFILE etc.). Default stderr-log. */
  readonly onWatcherError?: (err: unknown) => void;
}

export interface MemoryWatcherStats {
  readonly addCount: number;
  readonly changeCount: number;
  readonly unlinkCount: number;
  readonly saveCount: number;
  readonly errorCount: number;
  readonly cloudProvider: string;
  readonly usePolling: boolean;
  readonly running: boolean;
}

export interface MemoryWatcherHandle {
  stop(): Promise<void>;
  status(): MemoryWatcherStats;
  /**
   * Force a save now (bypassing the debounce). Used by sidecar shutdown
   * so the in-memory DB doesn't lose recent mutations. Returns true if
   * a save actually happened, false if nothing was pending.
   */
  flush(): boolean;
}

const DEFAULT_SAVE_DEBOUNCE_MS = 5_000;

const noopLog: IndexerLog = () => {};

const defaultErrorSink = (err: unknown): void => {
  console.error('memory-index watcher error:', err);
};

export function startMemoryIndexWatcher(opts: MemoryWatcherOpts): MemoryWatcherHandle {
  const start = workspacesDir(opts.vaultRoot);
  const debounce = opts.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
  const log = opts.log ?? noopLog;
  const cloudProvider = detectCloudProvider(opts.vaultRoot);
  const usePolling = opts.forceUsePolling ?? cloudProvider !== 'unknown';
  const timers = opts.timers ?? { setTimeout, clearTimeout };
  const errorSink = opts.onWatcherError ?? defaultErrorSink;

  const factory: ChokidarFactory = opts.chokidarFactory ?? chokidar.watch;

  const watcher = factory(start, {
    ignored: ['**/.git/**', '**/.claude-os/**', '**/.DS_Store', '**/Thumbs.db'],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ...(usePolling ? { usePolling: true, interval: 2000, binaryInterval: 5000 } : {}),
  });

  let running = true;
  let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const stats = {
    addCount: 0,
    changeCount: 0,
    unlinkCount: 0,
    saveCount: 0,
    errorCount: 0,
  };

  function scheduleSave(): void {
    if (!running) return;
    dirty = true;
    if (pendingSaveTimer !== null) timers.clearTimeout(pendingSaveTimer);
    pendingSaveTimer = timers.setTimeout(() => {
      pendingSaveTimer = null;
      flush();
    }, debounce);
    // Don't keep event-loop alive solely for the save timer.
    pendingSaveTimer.unref?.();
  }

  function flush(): boolean {
    if (!dirty) return false;
    try {
      saveIndex(opts.db, opts.dbPath);
      stats.saveCount++;
      dirty = false;
      return true;
    } catch (err) {
      stats.errorCount++;
      log('error', `flush failed: ${(err as Error).message}`);
      return false;
    }
  }

  function handleAddOrChange(path: string, kind: 'add' | 'change'): void {
    if (kind === 'add') stats.addCount++;
    else stats.changeCount++;
    if (!path.toLowerCase().endsWith('.md')) return;
    try {
      const st = statSync(path);
      indexNote(opts.db, path, st.mtimeMs);
      log('info', `indexed ${kind} ${path}`);
      scheduleSave();
    } catch (err) {
      stats.errorCount++;
      log('warn', `index ${kind} failed for ${path}: ${(err as Error).message}`);
    }
  }

  function handleUnlink(path: string): void {
    stats.unlinkCount++;
    if (!path.toLowerCase().endsWith('.md')) return;
    try {
      if (removeNote(opts.db, path)) {
        log('info', `removed ${path}`);
        scheduleSave();
      }
    } catch (err) {
      stats.errorCount++;
      log('warn', `remove failed for ${path}: ${(err as Error).message}`);
    }
  }

  watcher.on('add', (p) => handleAddOrChange(p, 'add'));
  watcher.on('change', (p) => handleAddOrChange(p, 'change'));
  watcher.on('unlink', handleUnlink);
  watcher.on('error', (err) => {
    stats.errorCount++;
    errorSink(err);
  });

  return {
    async stop() {
      running = false;
      if (pendingSaveTimer !== null) {
        timers.clearTimeout(pendingSaveTimer);
        pendingSaveTimer = null;
      }
      flush();
      await watcher.close();
    },
    status() {
      return {
        ...stats,
        cloudProvider,
        usePolling,
        running,
      };
    },
    flush() {
      return flush();
    },
  };
}
