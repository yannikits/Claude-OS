/**
 * Memory-index sidecar lifecycle (Phase 3f).
 *
 * Wraps `openIndex` + `rebuildAll` + `startMemoryIndexWatcher` into a
 * single async service that the sidecar boots and shuts down. The
 * service is lazy + tolerant:
 *   - If `CLAUDE_OS_VAULT_PATH` is unset, the service stays in
 *     "disabled" mode (`getDb()` returns `null`). The retrieval
 *     dispatcher (Phase 3e) then falls back to linear-scan or
 *     returns an empty result — sidecar boot never fails because
 *     the vault isn't yet configured.
 *   - If `openIndex` throws (corrupt DB, schema-drift refused),
 *     we log + continue in disabled mode rather than killing the
 *     whole sidecar. The next boot can recover after the user
 *     manually deletes the .db.
 *
 * Public API:
 *   - start(): Promise<void>     — call once on boot
 *   - stop():  Promise<void>     — call on shutdown (flushes watcher)
 *   - getDb(): Database | null   — for retrieval dispatcher
 *   - getStats(): ServiceStats   — for memory.stats RPC
 *   - rebuild(): RebuildStats    — force a full rebuild
 *
 * @module @sidecar/memory-index-service
 */
import type { Database } from 'sql.js';
import {
  getIndexStats,
  type IndexerLog,
  type IndexStats,
  type MemoryWatcherHandle,
  type MemoryWatcherStats,
  type OpenedIndex,
  openIndex,
  type RebuildStats,
  rebuildAll,
  saveIndex,
  startMemoryIndexWatcher,
} from '../domains/memory-index/index.js';
import { resolveVaultRoot, WorkspaceError } from '../domains/workspace/index.js';

export interface MemoryIndexServiceOpts {
  /** Optional logger. Default no-op. */
  readonly log?: IndexerLog;
  /** Skip the boot-time rebuildAll (tests, manual mode). */
  readonly skipBootRebuild?: boolean;
  /** Watcher save-debounce override (tests). */
  readonly saveDebounceMs?: number;
}

export interface ServiceStats {
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly vaultPath?: string;
  readonly index?: IndexStats;
  readonly watcher?: MemoryWatcherStats;
  readonly lastRebuild?: RebuildStats;
  readonly bootedAt?: string;
}

const noopLog: IndexerLog = () => {};

export class MemoryIndexService {
  private opened: OpenedIndex | null = null;
  private watcher: MemoryWatcherHandle | null = null;
  private lastRebuild: RebuildStats | null = null;
  private disabledReason: string | null = null;
  private bootedAt: string | null = null;
  private readonly log: IndexerLog;

  constructor(private readonly opts: MemoryIndexServiceOpts = {}) {
    this.log = opts.log ?? noopLog;
  }

  /**
   * Boots the service. Failure to resolve the vault or open the DB
   * leaves the service in disabled-mode (no throw) so the sidecar
   * keeps running.
   */
  async start(): Promise<void> {
    let vault: string;
    try {
      vault = resolveVaultRoot();
    } catch (err) {
      this.disabledReason =
        err instanceof WorkspaceError ? err.message : `vault: ${(err as Error).message}`;
      this.log('warn', `memory-index disabled: ${this.disabledReason}`);
      return;
    }

    try {
      this.opened = await openIndex({ vaultRoot: vault });
    } catch (err) {
      this.disabledReason = `openIndex failed: ${(err as Error).message}`;
      this.log('error', `memory-index disabled: ${this.disabledReason}`);
      return;
    }

    if (this.opened.fresh && this.opts.skipBootRebuild !== true) {
      try {
        this.lastRebuild = rebuildAll(this.opened.db, vault, { log: this.log });
        saveIndex(this.opened.db, this.opened.dbPath);
        this.log(
          'info',
          `memory-index initial rebuild: indexed=${this.lastRebuild.indexed} ` +
            `scanned=${this.lastRebuild.totalScanned} ${this.lastRebuild.durationMs}ms`,
        );
      } catch (err) {
        this.log('error', `initial rebuild failed: ${(err as Error).message}`);
        // Don't disable — the watcher can still pick up future writes.
      }
    }

    try {
      this.watcher = startMemoryIndexWatcher({
        vaultRoot: vault,
        db: this.opened.db,
        dbPath: this.opened.dbPath,
        log: this.log,
        ...(this.opts.saveDebounceMs === undefined
          ? {}
          : { saveDebounceMs: this.opts.saveDebounceMs }),
      });
      this.log('info', 'memory-index watcher started');
    } catch (err) {
      this.log('error', `watcher start failed: ${(err as Error).message}`);
    }

    this.bootedAt = new Date().toISOString();
  }

  async stop(): Promise<void> {
    if (this.watcher !== null) {
      await this.watcher.stop();
      this.watcher = null;
    }
    if (this.opened !== null) {
      try {
        saveIndex(this.opened.db, this.opened.dbPath);
      } catch (err) {
        this.log('warn', `final save failed: ${(err as Error).message}`);
      }
      this.opened.db.close();
      this.opened = null;
    }
  }

  /** Returns the open Database, or `null` when in disabled-mode. */
  getDb(): Database | null {
    return this.opened?.db ?? null;
  }

  /** Returns disabled-reason or empty string when enabled. */
  getDisabledReason(): string {
    return this.disabledReason ?? '';
  }

  /**
   * Force a full rebuild and persist. Returns the stats. Throws when
   * the service is in disabled-mode.
   */
  rebuild(): RebuildStats {
    if (this.opened === null) {
      throw new Error(
        `memory-index disabled${this.disabledReason ? `: ${this.disabledReason}` : ''}`,
      );
    }
    const vault = resolveVaultRoot();
    const stats = rebuildAll(this.opened.db, vault, { log: this.log });
    saveIndex(this.opened.db, this.opened.dbPath);
    this.lastRebuild = stats;
    return stats;
  }

  getStats(): ServiceStats {
    if (this.opened === null) {
      return {
        enabled: false,
        ...(this.disabledReason === null ? {} : { disabledReason: this.disabledReason }),
      };
    }
    let vaultPath: string | undefined;
    try {
      vaultPath = resolveVaultRoot();
    } catch {
      // shouldn't happen if opened !== null but be defensive
    }
    return {
      enabled: true,
      ...(vaultPath === undefined ? {} : { vaultPath }),
      index: getIndexStats(this.opened.db, this.opened.dbPath),
      ...(this.watcher === null ? {} : { watcher: this.watcher.status() }),
      ...(this.lastRebuild === null ? {} : { lastRebuild: this.lastRebuild }),
      ...(this.bootedAt === null ? {} : { bootedAt: this.bootedAt }),
    };
  }
}
