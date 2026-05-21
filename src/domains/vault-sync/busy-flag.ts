/**
 * Persistent busy-flag for vault-sync (ADR-0002 §38, Phase 2c).
 *
 * Stored as JSON at `<dataDir>/vault-sync-state.json`. Survives sidecar
 * restarts so a crashed snapshot leaves the flag set; the user can
 * reset it via `claude-os vault unlock`. On the same host, the flag
 * also stores the PID — if the PID is no longer alive we treat the
 * flag as stale and allow re-acquisition.
 *
 * Concurrency: acquire() benutzt `fs.openSync(filePath, 'wx')` als
 * atomare OS-level "claim" — der erste Prozess der den Aufruf gewinnt
 * erzeugt die Datei, alle weiteren bekommen `EEXIST` und scheitern. Das
 * schliesst die TOCTOU-Race zwischen zwei simultanen acquire()-Calls
 * (CLI + Sidecar) auf demselben Host. Stale-PID-Recovery auf dem
 * gleichen Host: nicht-laufende PID → unlink VOR dem openSync.
 * Corrupt-File-Recovery: read() liefert null → unlink VOR dem openSync.
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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
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
   *
   * C5 (2026-05-21 code-review): TOCTOU-safe via openSync(..., 'wx') —
   * atomarer OS-level exclusive-create. Wenn zwei Prozesse parallel
   * acquire() rufen, gewinnt genau einer; der andere bekommt EEXIST und
   * scheitert.
   */
  acquire(reason: string): boolean {
    const current = this.read();
    if (current?.busy) {
      const isSameHost = current.hostname === this.hostname;
      const stale = isSameHost && !this.isPidAlive(current.pid);
      if (!stale) return false;
      // Stale on same host — unlink BEFORE exclusive-create attempt.
      this.bestEffortUnlink();
    }
    // KEINE auto-recovery von "file exists aber read() ist null". Solche
    // Faelle entstehen entweder durch korrupten on-disk state ODER
    // durch eine laufende race mit einem anderen acquire(): falls
    // letzteres wuerde ein unlink hier die Lock-Claim des anderen
    // Prozesses kaputtmachen. User muss `vault unlock` ausfuehren.
    const next: BusyState = {
      busy: true,
      reason,
      pid: this.pid,
      hostname: this.hostname,
      acquiredAt: this.now().toISOString(),
    };
    return this.tryExclusiveWrite(next);
  }

  /**
   * Clears the flag wenn dieser Prozess (pid + hostname) ihn auch
   * gesetzt hat. No-op wenn nicht gesetzt ODER von einem anderen
   * Prozess gehalten wird — Codex-Round-2 finding: vorher konnte ein
   * Prozess B den Lock von Prozess A clearen.
   */
  release(): void {
    if (!existsSync(this.filePath)) return;
    const current = this.read();
    if (current === null) {
      // Corrupt-state ist niemand-haelt-den-Lock → safe to clear.
      this.bestEffortUnlink();
      return;
    }
    const isOwner = current.pid === this.pid && current.hostname === this.hostname;
    if (!isOwner) return; // Foreign lock — refuse to clear.
    this.bestEffortUnlink();
  }

  /**
   * Explicit reset — used by `claude-os vault unlock` when the user
   * accepts the loss of any in-flight work. Im Unterschied zu release()
   * cleart forceReset() unconditional (Cross-Host-Crash-Recovery).
   */
  forceReset(): void {
    if (!existsSync(this.filePath)) return;
    this.bestEffortUnlink();
  }

  /**
   * Atomarer exclusive-create: gibt true zurueck wenn die Datei
   * erfolgreich angelegt wurde, false wenn ein anderer Caller den Lock
   * bereits hielt (EEXIST). Andere Fehler werden weitergeworfen.
   */
  private tryExclusiveWrite(state: BusyState): boolean {
    mkdirSync(dirname(this.filePath), { recursive: true });
    let fd: number;
    try {
      fd = openSync(this.filePath, 'wx', 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      throw err;
    }
    try {
      writeSync(fd, JSON.stringify(state));
    } finally {
      closeSync(fd);
    }
    return true;
  }

  private bestEffortUnlink(): void {
    try {
      unlinkSync(this.filePath);
    } catch {
      /* race: someone else already unlinked. */
    }
  }
}
