/**
 * sql.js database lifecycle: open + apply schema + save.
 *
 * Trade-off: sql.js is a WASM SQLite that runs entirely in-memory.
 * Persistence happens via `db.export()` → `Uint8Array` → `fs.writeFile`.
 * Writing the whole file on every mutation is expensive — Phase 3c
 * (watcher) will debounce saves (e.g. 5s after the last index mutation).
 * For Phase 3a, `saveIndex()` is callable on demand and the open/save
 * lifecycle is exposed so the indexer + watcher layers can compose it.
 *
 * Schema-version mismatch → drops + rebuilds the entire DB. Callers
 * should treat that as "rebuild trigger" and re-walk the vault.
 *
 * @module @domains/memory-index/database
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { ensureIndexDir, resolveIndexDbPath } from './paths.js';
import { READ_SCHEMA_VERSION_SQL, SCHEMA_SQL, STAMP_VERSION_SQL } from './schema.js';
import {
  IndexCorruptError,
  type IndexStats,
  MEMORY_INDEX_SCHEMA_VERSION,
  MemoryIndexError,
} from './types.js';

/**
 * Long-lived sql.js runtime instance. `initSqlJs()` is async + loads
 * the WASM bundle — caching it avoids re-loading on every `openIndex`
 * call (cold start would also fail in tests for the same reason).
 */
let cachedSqlJs: SqlJsStatic | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (cachedSqlJs !== null) return cachedSqlJs;
  cachedSqlJs = await initSqlJs();
  return cachedSqlJs;
}

export interface OpenIndexOpts {
  readonly vaultRoot: string;
  /** When true and the schema-version mismatches, drop + recreate. Default true. */
  readonly autoRebuildOnSchemaDrift?: boolean;
}

export interface OpenedIndex {
  readonly db: Database;
  readonly dbPath: string;
  /** True if the on-disk file was empty/absent and we created a fresh DB. */
  readonly fresh: boolean;
  /** True if a schema-drift forced a drop+rebuild. */
  readonly rebuilt: boolean;
}

/**
 * Opens (or creates) the memory-index for a vault. Applies the schema
 * (idempotent) and stamps the version. Returns the live `Database`.
 *
 * If the on-disk file exists but a `SELECT` against `meta` reveals a
 * version mismatch, the DB is dropped and recreated empty — callers
 * then need to re-walk the vault to repopulate.
 */
export async function openIndex(opts: OpenIndexOpts): Promise<OpenedIndex> {
  const dbPath = resolveIndexDbPath(opts.vaultRoot);
  const SQL = await getSqlJs();

  let db: Database;
  let fresh: boolean;
  if (existsSync(dbPath)) {
    try {
      const bytes = readFileSync(dbPath);
      db = new SQL.Database(bytes);
      fresh = false;
    } catch (err) {
      throw new IndexCorruptError(
        `Failed to load existing index at "${dbPath}": ${(err as Error).message}`,
      );
    }
  } else {
    db = new SQL.Database();
    fresh = true;
  }

  // Always apply DDL — it's `IF NOT EXISTS`, so safe on already-
  // initialised DBs.
  try {
    db.exec(SCHEMA_SQL);
  } catch (err) {
    db.close();
    throw new IndexCorruptError(`Failed to apply schema to "${dbPath}": ${(err as Error).message}`);
  }

  // Check schema-version. If mismatch and autoRebuild is on (default),
  // drop everything and reapply. The caller will then re-walk.
  const onDisk = readSchemaVersion(db);
  let rebuilt = false;
  if (onDisk !== null && onDisk !== MEMORY_INDEX_SCHEMA_VERSION) {
    if (opts.autoRebuildOnSchemaDrift === false) {
      db.close();
      throw new MemoryIndexError(
        `Schema-version mismatch: on-disk=${onDisk}, expected=${MEMORY_INDEX_SCHEMA_VERSION}. ` +
          'Re-open with autoRebuildOnSchemaDrift=true to drop + recreate.',
      );
    }
    db.exec('DROP TABLE IF EXISTS documents_fts;');
    db.exec('DROP TABLE IF EXISTS documents;');
    db.exec('DROP TABLE IF EXISTS meta;');
    db.exec(SCHEMA_SQL);
    rebuilt = true;
    fresh = true; // semantically empty after rebuild
  }

  db.exec(STAMP_VERSION_SQL);

  return { db, dbPath, fresh, rebuilt };
}

/**
 * Reads the schema-version from `meta`. Returns `null` if the row
 * doesn't exist (fresh DB) or the value isn't an integer.
 */
function readSchemaVersion(db: Database): number | null {
  const stmt = db.prepare(READ_SCHEMA_VERSION_SQL);
  try {
    if (!stmt.step()) return null;
    const row = stmt.get();
    const raw = row[0];
    if (typeof raw !== 'string') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? n : null;
  } finally {
    stmt.free();
  }
}

/**
 * Atomically persists the in-memory database to disk. Uses
 * tempfile + rename to avoid partial writes on crash.
 *
 * Callers (Phase 3c watcher) should debounce this — exporting the full
 * DB on every mutation defeats the purpose of incremental indexing.
 */
export function saveIndex(db: Database, dbPath: string): void {
  ensureIndexDir(getParentDir(dbPath));
  const bytes = db.export();
  const tmp = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, dbPath);
}

function getParentDir(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(0, idx) : filePath;
}

/**
 * Returns lightweight diagnostic stats — primarily for the GUI Memory
 * page's "index health" widget and for the `memory.stats` RPC in
 * Phase 3f.
 */
export function getIndexStats(db: Database | null, dbPath: string): IndexStats {
  if (db === null) {
    return { documentsRowCount: 0, dbPath, opened: false };
  }
  const stmt = db.prepare('SELECT COUNT(*) AS n FROM documents;');
  try {
    stmt.step();
    const row = stmt.get();
    const n = typeof row[0] === 'number' ? row[0] : Number(row[0] ?? 0);
    return { documentsRowCount: n, dbPath, opened: true };
  } finally {
    stmt.free();
  }
}
