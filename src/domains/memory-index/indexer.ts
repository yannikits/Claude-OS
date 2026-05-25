/**
 * Vault → memory-index indexer (Phase 3b).
 *
 * Walks the workspace tree, parses each `.md` via the Phase-2b note
 * reader, and upserts into `documents` + `documents_fts`. mtime-aware
 * skip so re-runs after partial indexing only pick up the rest.
 *
 * The indexer is sync-ish (parse + upsert per file) but bulk operations
 * wrap in a `BEGIN TRANSACTION` so a few thousand notes get committed
 * as one atomic batch — sql.js exports the resulting bytes once.
 *
 * Failure-mode: a single malformed note (broken YAML, unreadable file)
 * is logged via the callback and skipped — it does not poison the
 * whole walk. The Phase-2b reader is already lenient on the read-side.
 *
 * @module @domains/memory-index/indexer
 */
import { type Dirent, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'sql.js';
import { readNote } from '../notes/index.js';
import { workspacesDir } from '../workspace/index.js';
import { MemoryIndexError } from './types.js';

export type IndexerLog = (level: 'info' | 'warn' | 'error', message: string) => void;

const noopLog: IndexerLog = () => {};

export interface RebuildOpts {
  /** Optional logger sink. Default: drop messages. */
  readonly log?: IndexerLog;
  /** Stop after this many files (debug/tests). Default: no limit. */
  readonly limit?: number;
}

export interface RebuildStats {
  readonly indexed: number;
  readonly skippedUnchanged: number;
  readonly skippedMalformed: number;
  readonly removedStale: number;
  readonly totalScanned: number;
  readonly durationMs: number;
}

/**
 * Returns the mtime stored in the index for a given path, or `null`
 * when the path isn't indexed yet. Used by the watcher (Phase 3c) to
 * skip re-indexing for events that don't actually change content.
 */
export function getIndexedMtime(db: Database, path: string): number | null {
  const stmt = db.prepare('SELECT mtime_ms FROM documents WHERE path=?');
  stmt.bind([path]);
  try {
    if (!stmt.step()) return null;
    const row = stmt.get();
    const v = row[0];
    return typeof v === 'number' ? v : null;
  } finally {
    stmt.free();
  }
}

/**
 * Upserts a single note into both `documents` and `documents_fts`.
 * Caller must wrap in `BEGIN/COMMIT` for bulk operations.
 *
 * `documents_fts` is kept in sync explicitly: delete any prior row +
 * insert the current body. We don't rely on FTS4 content-link triggers
 * (see schema.ts deviation note).
 */
export function indexNote(db: Database, absolutePath: string, mtimeMs: number): void {
  const note = readNote(absolutePath);
  const frontmatterJson = JSON.stringify(note.frontmatter);
  const tenant =
    typeof note.frontmatter.tenant === 'string' && note.frontmatter.tenant.length > 0
      ? note.frontmatter.tenant
      : null;
  const classification = String(note.frontmatter.classification ?? 'customer-confidential');

  // 1. Upsert into documents — uses INSERT OR REPLACE for path-PK.
  // Because we lose the old rowid on REPLACE, we delete the FTS row
  // first using the OLD rowid (lookup before the upsert).
  const oldRowidStmt = db.prepare('SELECT rowid FROM documents WHERE path=?');
  oldRowidStmt.bind([absolutePath]);
  let oldRowid: number | null = null;
  if (oldRowidStmt.step()) {
    const v = oldRowidStmt.get()[0];
    if (typeof v === 'number') oldRowid = v;
  }
  oldRowidStmt.free();

  if (oldRowid !== null) {
    const fdel = db.prepare('DELETE FROM documents_fts WHERE rowid=?');
    fdel.bind([oldRowid]);
    fdel.step();
    fdel.free();
  }

  db.run(
    `INSERT OR REPLACE INTO documents(path, workspace, tenant, classification, frontmatter_json, body, mtime_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [absolutePath, note.workspace, tenant, classification, frontmatterJson, note.body, mtimeMs],
  );

  // 2. Sync FTS — use the (possibly new) rowid from the upserted row.
  const newRowidStmt = db.prepare('SELECT rowid FROM documents WHERE path=?');
  newRowidStmt.bind([absolutePath]);
  newRowidStmt.step();
  const newRowid = newRowidStmt.get()[0];
  newRowidStmt.free();

  db.run('INSERT INTO documents_fts(rowid, body) VALUES (?, ?)', [newRowid ?? null, note.body]);
}

/**
 * Removes a note from both tables. No-op when the path isn't indexed.
 * Returns true when a row was actually removed.
 */
export function removeNote(db: Database, absolutePath: string): boolean {
  const stmt = db.prepare('SELECT rowid FROM documents WHERE path=?');
  stmt.bind([absolutePath]);
  let rowid: number | null = null;
  if (stmt.step()) {
    const v = stmt.get()[0];
    if (typeof v === 'number') rowid = v;
  }
  stmt.free();
  if (rowid === null) return false;

  const fdel = db.prepare('DELETE FROM documents_fts WHERE rowid=?');
  fdel.bind([rowid]);
  fdel.step();
  fdel.free();
  db.run('DELETE FROM documents WHERE path=?', [absolutePath]);
  return true;
}

/**
 * Walks `<vault>/Claude-OS/workspaces/` recursively and returns the
 * absolute paths of every `.md` file found. Skips `.claude-os/` (where
 * the index db lives) defensively even though it sits outside the
 * workspaces tree.
 */
export function walkVaultNotes(vaultRoot: string): string[] {
  const start = workspacesDir(vaultRoot);
  const out: string[] = [];
  walkInto(start, out);
  return out;
}

function walkInto(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
  } catch {
    return; // missing dir / not yet bootstrapped → empty
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkInto(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

/**
 * Full reconciliation pass: walks the vault, upserts new/changed notes,
 * removes stale rows (path on disk gone), and returns aggregate stats.
 *
 * Uses a single `BEGIN/COMMIT` so partial-progress is impossible —
 * either the whole batch lands or none. sql.js persistence (saveIndex)
 * is the caller's responsibility (so they can debounce).
 */
export function rebuildAll(db: Database, vaultRoot: string, opts: RebuildOpts = {}): RebuildStats {
  const log = opts.log ?? noopLog;
  const startedAt = Date.now();
  const onDisk = walkVaultNotes(vaultRoot);
  const limit = opts.limit ?? onDisk.length;

  let indexed = 0;
  let skippedUnchanged = 0;
  let skippedMalformed = 0;
  let removedStale = 0;

  const onDiskSet = new Set<string>();

  db.run('BEGIN TRANSACTION');
  try {
    let i = 0;
    for (const absolutePath of onDisk) {
      if (i >= limit) break;
      onDiskSet.add(absolutePath);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(absolutePath);
      } catch (err) {
        log('warn', `stat failed for ${absolutePath}: ${(err as Error).message}`);
        skippedMalformed++;
        i++;
        continue;
      }
      const indexedAt = getIndexedMtime(db, absolutePath);
      if (indexedAt !== null && indexedAt >= stat.mtimeMs) {
        skippedUnchanged++;
        i++;
        continue;
      }
      try {
        indexNote(db, absolutePath, stat.mtimeMs);
        indexed++;
      } catch (err) {
        log('warn', `index failed for ${absolutePath}: ${(err as Error).message}`);
        skippedMalformed++;
      }
      i++;
    }

    // Cull stale rows that no longer exist on disk.
    const allStmt = db.prepare('SELECT path FROM documents');
    const known: string[] = [];
    while (allStmt.step()) {
      const v = allStmt.get()[0];
      if (typeof v === 'string') known.push(v);
    }
    allStmt.free();
    for (const known_path of known) {
      if (!onDiskSet.has(known_path)) {
        if (removeNote(db, known_path)) removedStale++;
      }
    }

    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw new MemoryIndexError(`Rebuild failed mid-batch: ${(err as Error).message}`);
  }

  return {
    indexed,
    skippedUnchanged,
    skippedMalformed,
    removedStale,
    totalScanned: onDisk.length,
    durationMs: Date.now() - startedAt,
  };
}
