/**
 * SQL schema for the memory-index (ADR-0025 §Schema, Phase 3a).
 *
 * Three tables:
 *   - `meta`           — single-row schema-version marker for migrations
 *   - `documents`      — one row per indexed note (denormalised body)
 *   - `documents_fts`  — FTS4 virtual table built on document bodies
 *
 * **v1 deviation from ADR-0025**: the spec called for FTS5, but `sql.js@1.14.x`
 * does not compile FTS5 into its WASM build (FTS3+FTS4 only). Switching to a
 * different WASM SQLite would lose the "zero native-build" property that
 * ADR-0025 §Konsequenzen+ relies on. FTS4 + `unicode61` tokenizer covers our
 * Phase-3 needs (workspace-scoped substring search with German umlauts). The
 * Phase-2c BM25 implementation is still used for ranking on top of FTS4
 * candidates (FTS4 lacks the built-in `bm25()` of FTS5). When sql.js gains
 * FTS5 or we switch SQLite stacks, the schema can grow `documents_fts5` next
 * to the existing virtual table without breaking callers.
 *
 * `documents_fts` is NOT content-linked to `documents` — Phase-3b indexer
 * manages both tables explicitly. Same shape as the FTS5 spec but the FTS4
 * trigger syntax is incompatible enough that explicit upserts are simpler.
 *
 * @module @domains/memory-index/schema
 */
import { MEMORY_INDEX_SCHEMA_VERSION } from './types.js';

/**
 * Idempotent DDL — safe to run on every open. `IF NOT EXISTS` everywhere.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  path TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  tenant TEXT,
  classification TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL,
  body TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace);
CREATE INDEX IF NOT EXISTS idx_documents_classification ON documents(classification);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts4(
  body,
  tokenize=unicode61
);
`;

/**
 * Stamps the schema-version row. Runs after `SCHEMA_SQL`. Idempotent
 * via `INSERT OR REPLACE`.
 */
export const STAMP_VERSION_SQL = `
INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '${MEMORY_INDEX_SCHEMA_VERSION}');
`;

/**
 * Returns the integer schema-version recorded in `meta`. Used at open-
 * time to detect a stale schema and trigger a drop+rebuild.
 */
export const READ_SCHEMA_VERSION_SQL = `
SELECT value FROM meta WHERE key='schema_version';
`;
