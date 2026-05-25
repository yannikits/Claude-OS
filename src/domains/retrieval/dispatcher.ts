/**
 * Search dispatcher with FTS-first + linear-scan fallback (Phase 3e).
 *
 * Tries the FTS-backed `searchIndex` (Phase 3d) first when a db handle
 * is provided. On any error (DB-corrupt, FTS-runtime, prepared-stmt
 * failure) degrades to the Phase-2c linear-scan over the on-disk vault
 * and logs a warning. Same return-shape either way.
 *
 * The caller (sidecar — Phase 3f) is responsible for triggering a
 * background rebuild on the next watcher event or on next boot if the
 * FTS path stays broken. This module deliberately doesn't kick off
 * rebuilds itself (would couple retrieval to the indexer lifecycle).
 *
 * @module @domains/retrieval/dispatcher
 */
import type { Database } from 'sql.js';
import { searchIndex } from '../memory-index/index.js';
import { searchWorkspace } from './linear-scan.js';
import type { RetrievalQuery, RetrievalResult } from './types.js';

export type SearchKind = 'fts' | 'linear-scan';

export interface DispatcherOpts {
  readonly vaultRoot: string;
  readonly workspaceId: string;
  readonly query: RetrievalQuery;
  /** Open index db, or `null` when memory-index isn't ready. */
  readonly db: Database | null;
  /** Optional logger sink. Default no-op. */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface DispatcherResult extends RetrievalResult {
  readonly kind: SearchKind;
  /** When kind=linear-scan because FTS failed: the error message. */
  readonly fallbackReason?: string;
}

const noopLog: NonNullable<DispatcherOpts['log']> = () => {};

/**
 * Runs `searchIndex` first (when db is open), falls back to
 * `searchWorkspace` on error or when no db is available.
 */
export function searchWithFallback(opts: DispatcherOpts): DispatcherResult {
  const log = opts.log ?? noopLog;

  if (opts.db !== null) {
    try {
      const r = searchIndex(opts.db, opts.workspaceId, opts.query);
      return { ...r, kind: 'fts' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('warn', `FTS search failed, falling back to linear-scan: ${msg}`);
      const linear = searchWorkspace(opts.vaultRoot, opts.workspaceId, opts.query);
      return { ...linear, kind: 'linear-scan', fallbackReason: msg };
    }
  }

  const linear = searchWorkspace(opts.vaultRoot, opts.workspaceId, opts.query);
  return { ...linear, kind: 'linear-scan' };
}
