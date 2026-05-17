/**
 * BackupManager — point-in-time snapshots of skill/plugin scopes
 * before an update merge per ADR-0005 §27.
 *
 * Layout:
 *   <backupsDir>/update-<ISO-safe-timestamp>/
 *     ├── <files...>                Recursive copy of the source dir
 *     └── manifest.json             {timestamp, scope, sourceDir,
 *                                    fileCount, totalBytes}
 *
 * Retention policy: prune(N) keeps the N most recent backups by
 * timestamp (default N=5). Older entries are removed in full.
 *
 * @module @domains/update-orchestrator/backup-manager
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { UpdateScope } from './types.js';

export interface BackupEntry {
  /** Filesystem-safe ISO timestamp, e.g. `2026-05-17T12-34-56-789Z`. */
  readonly timestamp: string;
  /** Absolute path to the backup directory. */
  readonly path: string;
  readonly scope: UpdateScope;
  /** Absolute path that was snapshotted. */
  readonly sourceDir: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

interface ManifestFile {
  readonly timestamp: string;
  readonly scope: UpdateScope;
  readonly sourceDir: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

interface BackupManagerOpts {
  /** Absolute path of the parent backups directory. */
  readonly backupsDir: string;
  /** Override clock (tests). */
  readonly now?: () => Date;
}

const BACKUP_PREFIX = 'update-';

function refSafeIso(d: Date): string {
  // Same convention as conflict-policy: replace `:` and `.` with `-`
  // so the dir name is portable across NTFS and tmpfs.
  return d.toISOString().replaceAll(':', '-').replace('.', '-');
}

function walkSizes(dir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  if (!existsSync(dir)) return { fileCount, totalBytes };
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const childPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(childPath);
        continue;
      }
      if (entry.isFile()) {
        fileCount += 1;
        try {
          totalBytes += statSync(childPath).size;
        } catch {
          /* skip unreadable files */
        }
      }
    }
  }
  return { fileCount, totalBytes };
}

function readManifest(backupPath: string): ManifestFile | null {
  const manifestPath = join(backupPath, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const m = parsed as Record<string, unknown>;
    if (
      typeof m.timestamp !== 'string' ||
      typeof m.scope !== 'string' ||
      typeof m.sourceDir !== 'string' ||
      typeof m.fileCount !== 'number' ||
      typeof m.totalBytes !== 'number'
    ) {
      return null;
    }
    return m as unknown as ManifestFile;
  } catch {
    return null;
  }
}

function entryFromManifest(backupPath: string, manifest: ManifestFile): BackupEntry {
  return {
    timestamp: manifest.timestamp,
    path: backupPath,
    scope: manifest.scope,
    sourceDir: manifest.sourceDir,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
  };
}

export class BackupManager {
  readonly backupsDir: string;
  private readonly now: () => Date;

  constructor(opts: BackupManagerOpts) {
    this.backupsDir = opts.backupsDir;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Snapshots `sourceDir` into a new backup folder. Source files are
   * recursively copied under `<backupsDir>/update-<ts>/<scope>/` and a
   * manifest is written alongside.
   */
  snapshot(scope: UpdateScope, sourceDir: string): BackupEntry {
    const timestamp = refSafeIso(this.now());
    const backupPath = join(this.backupsDir, `${BACKUP_PREFIX}${timestamp}`);
    mkdirSync(backupPath, { recursive: true });

    if (existsSync(sourceDir)) {
      cpSync(sourceDir, join(backupPath, scope), { recursive: true });
    } else {
      mkdirSync(join(backupPath, scope), { recursive: true });
    }

    const sizes = walkSizes(join(backupPath, scope));
    const manifest: ManifestFile = {
      timestamp,
      scope,
      sourceDir,
      fileCount: sizes.fileCount,
      totalBytes: sizes.totalBytes,
    };
    writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });

    return entryFromManifest(backupPath, manifest);
  }

  /**
   * Returns all backup entries sorted oldest-first. Entries missing or
   * with malformed manifests are skipped silently.
   */
  list(): readonly BackupEntry[] {
    if (!existsSync(this.backupsDir)) return [];
    const entries: BackupEntry[] = [];
    for (const child of readdirSync(this.backupsDir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      if (!child.name.startsWith(BACKUP_PREFIX)) continue;
      const backupPath = join(this.backupsDir, child.name);
      const manifest = readManifest(backupPath);
      if (manifest === null) continue;
      entries.push(entryFromManifest(backupPath, manifest));
    }
    entries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    return entries;
  }

  /**
   * Restores the most recent (or named) backup back into `destination`.
   * Existing destination contents are NOT cleared — callers must wipe
   * if they want pristine state. Returns the entry that was restored,
   * or null when no backups exist or the timestamp does not match.
   */
  restore(timestamp: string | 'latest', destination: string): BackupEntry | null {
    const all = this.list();
    if (all.length === 0) return null;
    const entry =
      timestamp === 'latest'
        ? (all[all.length - 1] ?? null)
        : (all.find((e) => e.timestamp === timestamp) ?? null);
    if (entry === null) return null;
    const scopeDir = join(entry.path, entry.scope);
    if (!existsSync(scopeDir)) return entry;
    mkdirSync(destination, { recursive: true });
    cpSync(scopeDir, destination, { recursive: true });
    return entry;
  }

  /**
   * Keeps the `retention` most recent backups and removes older ones.
   * Returns the timestamps of removed entries.
   */
  prune(retention = 5): readonly string[] {
    if (retention < 0) {
      throw new Error(`BackupManager.prune: retention must be >= 0, got ${retention}`);
    }
    const all = this.list();
    if (all.length <= retention) return [];
    const removed: string[] = [];
    const toRemove = all.slice(0, all.length - retention);
    for (const entry of toRemove) {
      try {
        rmSync(entry.path, { recursive: true, force: true });
        removed.push(entry.timestamp);
      } catch {
        /* best-effort */
      }
    }
    return removed;
  }
}

/** Default backup-dir convention: `<dataRoot>/backups/`. */
export function backupsDirFor(dataRoot: string): string {
  return join(dataRoot, 'backups');
}

/** Returns the path a given backup timestamp would live at. */
export function backupPathFor(backupsDir: string, timestamp: string): string {
  return join(backupsDir, `${BACKUP_PREFIX}${timestamp}`);
}
