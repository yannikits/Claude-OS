/**
 * VaultScheduler — idle-detection file watcher per ADR-0002, Phase 2d.
 *
 * Design points (driven by obsidian-git #114 + chokidar #384/#675/
 * #895/#998/#225):
 *
 *  1. Raw chokidar events drive a SEPARATE idle-timer. We do NOT abuse
 *     `awaitWriteFinish` for the multi-minute idle window — that option
 *     silently drops events on large files.
 *  2. `awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }`
 *     runs in parallel to smooth per-file editor-save bursts.
 *  3. `ignoreInitial: true` so the bootstrap scan does not trigger an
 *     immediate snapshot of an unmodified vault.
 *  4. Cloud-mount auto-detect (via `detectCloudProvider`) switches
 *     chokidar to polling because OneDrive/GDrive/Dropbox Files-On-
 *     Demand mounts return unreliable native FS events.
 *  5. The scheduler does NOT call the snapshot function directly; the
 *     caller supplies an `onSnapshot` callback. This keeps the
 *     scheduler agnostic to busy-flag handling and snapshot policy.
 *
 * @module @domains/vault-sync/scheduler
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { detectCloudProvider } from '../../core/environment/index.js';

type ChokidarFactory = (paths: string, options: Parameters<typeof chokidar.watch>[1]) => FSWatcher;

export interface SchedulerOpts {
  /** Vault working-tree to watch. */
  readonly workTree: string;
  /** Idle window in milliseconds before a snapshot is triggered. Default 300_000 (5 min). */
  readonly idleMs?: number;
  /** Callback invoked when the idle timer expires. */
  readonly onSnapshot: (reason: string) => Promise<unknown>;
  /** Override cloud-polling decision (auto-detected by default). */
  readonly forceUsePolling?: boolean;
  /** Extra glob patterns to ignore (merged with the defaults). */
  readonly extraIgnored?: readonly string[];
  /** Inject chokidar factory (tests). */
  readonly chokidarFactory?: ChokidarFactory;
  /** Inject timer functions (tests). */
  readonly timers?: {
    readonly setTimeout: typeof setTimeout;
    readonly clearTimeout: typeof clearTimeout;
  };
  /** Override now() (tests). */
  readonly now?: () => Date;
  /**
   * M27 (2026-05-21 code-review): optional chokidar-error-Sink. Vorher
   * war der `watcher.on('error')`-Handler ein No-op — EMFILE/EACCES und
   * andere chokidar-Errors blieben unsichtbar. Default: stderr-Log.
   * Caller kann eigenen Logger injizieren.
   */
  readonly onWatcherError?: (err: unknown) => void;
}

export interface SchedulerStatus {
  readonly running: boolean;
  readonly idleMs: number;
  readonly usePolling: boolean;
  readonly cloudProvider: string;
  readonly eventsSinceLastSnapshot: number;
  readonly pendingTimerSetAt: string | null;
  readonly lastSnapshotAt: string | null;
  readonly inFlight: boolean;
}

const DEFAULT_IDLE_MS = 300_000;

const DEFAULT_IGNORED: readonly string[] = [
  '**/.git/**',
  '**/.obsidian/cache/**',
  '**/.obsidian/workspace*.json',
  '**/.trash/**',
  '**/node_modules/**',
  '**/.DS_Store',
  '**/Thumbs.db',
];

export class VaultScheduler {
  private readonly workTree: string;
  private readonly idleMs: number;
  private readonly onSnapshot: (reason: string) => Promise<unknown>;
  private readonly ignored: readonly string[];
  private readonly chokidarFactory: ChokidarFactory;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly now: () => Date;
  private readonly usePolling: boolean;
  private readonly cloudProvider: ReturnType<typeof detectCloudProvider>;
  private readonly onWatcherError: (err: unknown) => void;

  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private events = 0;
  private pendingTimerSetAt: string | null = null;
  private lastSnapshotAt: string | null = null;
  private inFlight = false;
  // C4 (2026-05-21 code-review): wenn der idle-Timer waehrend laufendem
  // onSnapshot feuert, dropping wir nicht still — wir merken uns dass eine
  // weitere Snapshot-Runde noetig ist und feuern sie aus dem finally-Hook
  // des laufenden onSnapshot heraus.
  private pendingFire = false;

  constructor(opts: SchedulerOpts) {
    this.workTree = opts.workTree;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.onSnapshot = opts.onSnapshot;
    this.ignored = [...DEFAULT_IGNORED, ...(opts.extraIgnored ?? [])];
    this.chokidarFactory =
      opts.chokidarFactory ?? ((paths, options) => chokidar.watch(paths, options));
    this.setTimeoutFn = opts.timers?.setTimeout ?? setTimeout;
    this.clearTimeoutFn = opts.timers?.clearTimeout ?? clearTimeout;
    this.now = opts.now ?? (() => new Date());
    this.cloudProvider = detectCloudProvider(opts.workTree);
    this.usePolling = opts.forceUsePolling ?? this.cloudProvider !== 'unknown';
    this.onWatcherError =
      opts.onWatcherError ??
      ((err) => {
        // M27-Default: stderr-Log mit minimaler shape. Sidecar/CLI kann
        // einen Pino-Logger injizieren wenn struktiertes Logging gewollt.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`vault-sync chokidar error: ${message}`);
      });
  }

  start(): void {
    if (this.watcher !== null) return;
    this.watcher = this.chokidarFactory(this.workTree, {
      persistent: true,
      ignoreInitial: true,
      ignored: [...this.ignored],
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
      atomic: 100,
      usePolling: this.usePolling,
      interval: this.usePolling ? 2000 : undefined,
      binaryInterval: this.usePolling ? 5000 : undefined,
    });

    const onEvent = (): void => this.handleEvent();
    this.watcher.on('add', onEvent);
    this.watcher.on('change', onEvent);
    this.watcher.on('unlink', onEvent);
    this.watcher.on('unlinkDir', onEvent);
    // M27 (2026-05-21 code-review): chokidar-Errors NICHT mehr silent
    // verworfen — durch injectable `onWatcherError` (Default: stderr-Log)
    // werden EMFILE/EACCES/inotify-Watch-Limit-Erreicht sichtbar.
    this.watcher.on('error', (err) => this.onWatcherError(err));
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
      this.pendingTimerSetAt = null;
    }
    if (this.watcher !== null) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  status(): SchedulerStatus {
    return {
      running: this.watcher !== null,
      idleMs: this.idleMs,
      usePolling: this.usePolling,
      cloudProvider: this.cloudProvider,
      eventsSinceLastSnapshot: this.events,
      pendingTimerSetAt: this.pendingTimerSetAt,
      lastSnapshotAt: this.lastSnapshotAt,
      inFlight: this.inFlight,
    };
  }

  /** Public for tests — synthesises a watcher event without involving chokidar. */
  notifyEventForTest(): void {
    this.handleEvent();
  }

  private handleEvent(): void {
    this.events += 1;
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.pendingTimerSetAt = this.now().toISOString();
    this.timer = this.setTimeoutFn(() => {
      this.fireSnapshot();
    }, this.idleMs);
    // Avoid the timer keeping the process alive on its own.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private fireSnapshot(): void {
    this.timer = null;
    this.pendingTimerSetAt = null;
    if (this.inFlight) {
      // C4-Fix: snapshot is already running. Vorher: `return` und damit
      // alle events seit dem letzten erfolgreichen fire orphaned. Jetzt:
      // pendingFire-Flag — der finally-Hook unten triggert erneut wenn
      // events angesammelt wurden.
      this.pendingFire = true;
      return;
    }
    this.inFlight = true;
    const eventsCaptured = this.events;
    this.events = 0;
    Promise.resolve()
      .then(() => this.onSnapshot(`idle-${eventsCaptured}-events`))
      .catch(() => {
        /* caller is responsible for logging via the snapshot pipeline */
      })
      .finally(() => {
        this.inFlight = false;
        this.lastSnapshotAt = this.now().toISOString();
        if (this.pendingFire) {
          this.pendingFire = false;
          // Re-fire um die waehrend des letzten onSnapshot angefallenen
          // events zu draenen. fireSnapshot ist re-entrant-safe — inFlight
          // ist jetzt false.
          this.fireSnapshot();
        }
      });
  }
}
