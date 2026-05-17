/**
 * Persistent busy-flag for vault-sync (ADR-0002 §38, Phase 2c).
 *
 * Stored as JSON at `<dataDir>/vault-sync-state.json`. Survives sidecar
 * restarts so a crashed snapshot leaves the flag set; the user can
 * reset it via `claude-os vault unlock`. On the same host, the flag
 * also stores the PID — if the PID is no longer alive we treat the
 * flag as stale and allow re-acquisition.
 *
 * Concurrency note: the JSON+rename approach is atomic *per write*
 * but does not prevent a true TOCTOU race between two simultaneous
 * acquire() calls. In v1 the scheduler runs in a single process
 * (Phase 6 Tauri sidecar) and the CLI is user-initiated one-at-a-time,
 * so this is sufficient. A real mutex (file-lock or sqlite BEGIN
 * IMMEDIATE) would be Phase 6 hardening.
 *
 * On-disk shape:
 *   {
 *     "busy": true,
 *     "reason": "snapshot",
 *     "pid": 12345,
 *     "hostname": "machine-A",
 *     "acquiredAt": "2026-05-17T08:00:00.123Z"
 *   }
 *
 * @module @domains/vault-sync/busy-flag
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/** Serialized busy-flag envelope. */
export interface BusyState {
  readonly busy: boolean;
  readonly reason: string;
  readonly pid: number;
  readonly hostname: string;
  /** ISO-8601 with milliseconds. */
  readonly acquiredAt: string;
}

export class BusyFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusyFlagError';
  }
}

interface BusyFlagOpts {
  /** Absolute path to the state file. */
  readonly filePath: string;
  /** Override hostname (tests). */
  readonly hostname?: string;
  /** Override pid (tests). */
  readonly pid?: number;
  /** Override pid-alive probe (tests). Default: `process.kill(pid, 0)`. */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Override now() (tests). */
  readonly now?: () => Date;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we lack access (still alive).
    if (err instanceof Error && /EPERM/i.test(err.message)) return true;
    return false;
  }
}

export class BusyFlag {
  readonly filePath: string;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => Date;

  constructor(opts: BusyFlagOpts) {
    this.filePath = opts.filePath;
    this.hostname = opts.hostname ?? hostname();
    this.pid = opts.pid ?? process.pid;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.now = opts.now ?? (() => new Date());
  }

  /** Reads the current state or returns null when the file is absent/empty/corrupt. */
  read(): BusyState | null {
    if (!existsSync(this.filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    if (raw.trim().length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj.busy !== 'boolean' ||
        typeof obj.reason !== 'string' ||
        typeof obj.pid !== 'number' ||
        typeof obj.hostname !== 'string' ||
        typeof obj.acquiredAt !== 'string'
      ) {
        return null;
      }
      return obj as unknown as BusyState;
    } catch {
      return null;
    }
  }

  /**
   * Tries to acquire the flag. Returns true on success, false if another
   * party already holds it (alive PID on this host, or any hostname).
   * Stale state on the same host (PID dead) is auto-cleared.
   */
  acquire(reason: string): boolean {
    const current = this.read();
    if (current?.busy) {
      const isSameHost = current.hostname === this.hostname;
      const stale = isSameHost && !this.isPidAlive(current.pid);
      if (!stale) return false;
      // Fall through — treat as released.
    }
    const next: BusyState = {
      busy: true,
      reason,
      pid: this.pid,
      hostname: this.hostname,
      acquiredAt: this.now().toISOString(),
    };
    this.write(next);
    return true;
  }

  /** Clears the flag. Safe to call when not currently held. */
  release(): void {
    if (!existsSync(this.filePath)) return;
    unlinkSync(this.filePath);
  }

  /**
   * Explicit reset — used by `claude-os vault unlock` when the user
   * accepts the loss of any in-flight work.
   */
  forceReset(): void {
    this.release();
  }

  private write(state: BusyState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
