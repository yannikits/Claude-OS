/**
 * Memory-index domain — SQLite + FTS5 over the Obsidian vault
 * (Phase 3, ADR-0025). Replaces / accelerates the Phase-2c linear-scan
 * for vaults > 1000 notes.
 *
 * @module @domains/memory-index
 */

export {
  getIndexStats,
  type OpenedIndex,
  type OpenIndexOpts,
  openIndex,
  saveIndex,
} from './database.js';
export {
  getIndexedMtime,
  type IndexerLog,
  indexNote,
  type RebuildOpts,
  type RebuildStats,
  rebuildAll,
  removeNote,
  walkVaultNotes,
} from './indexer.js';
export { ensureIndexDir, resolveIndexDbPath } from './paths.js';
export {
  READ_SCHEMA_VERSION_SQL,
  SCHEMA_SQL,
  STAMP_VERSION_SQL,
} from './schema.js';
export {
  IndexCorruptError,
  type IndexedDocument,
  type IndexStats,
  MEMORY_INDEX_SCHEMA_VERSION,
  MemoryIndexError,
} from './types.js';
