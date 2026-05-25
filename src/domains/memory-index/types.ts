/**
 * Memory-index domain types (ADR-0025, Phase 3a foundation).
 *
 * SQLite + FTS5 index over the Obsidian vault. v1 uses `sql.js`
 * (WASM-based, no native build per ADR-0025 §Konsequenzen) — see
 * `database.ts` for the load/save lifecycle trade-off.
 *
 * @module @domains/memory-index/types
 */
import type { NoteClassification, NoteFrontmatter } from '../notes/index.js';

/**
 * Persisted row in the `documents` table. `body` is denormalised here so
 * a single row lookup yields the full text without joining `documents_fts`.
 * `frontmatter_json` stores the parsed frontmatter as JSON for fast
 * filter operations without re-parsing the markdown.
 */
export interface IndexedDocument {
  readonly path: string;
  readonly workspace: string;
  readonly tenant: string | null;
  readonly classification: NoteClassification;
  readonly frontmatter: NoteFrontmatter;
  readonly body: string;
  /** Filesystem mtime in milliseconds (matches `fs.statSync().mtimeMs`). */
  readonly mtimeMs: number;
}

/**
 * Lightweight diagnostics view returned by `database.ts:getIndexStats`.
 */
export interface IndexStats {
  readonly documentsRowCount: number;
  /** Path to the on-disk `.db` file (may not exist yet). */
  readonly dbPath: string;
  /** True if the WASM database has been opened in-memory. */
  readonly opened: boolean;
}

/**
 * Schema-version stamped in the `meta` table so we can drop+rebuild
 * when the schema evolves. Bump on schema-shape changes.
 */
export const MEMORY_INDEX_SCHEMA_VERSION = 1;

export class MemoryIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryIndexError';
  }
}

export class IndexCorruptError extends MemoryIndexError {
  constructor(reason: string) {
    super(`Memory-index corrupt: ${reason}. The caller should rebuild.`);
    this.name = 'IndexCorruptError';
  }
}
