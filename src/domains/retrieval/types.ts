/**
 * Retrieval-domain types.
 *
 * Linear-scan, workspace-scoped, BM25-ranked top-K retrieval over
 * Markdown notes. FTS5-backed retrieval is Phase 3 (ADR-0025) —
 * this is the v1 Memory MVP fallback, surfaced as Phase 2c.
 *
 * @module @domains/retrieval/types
 */
import type { Note } from '../notes/index.js';

export interface RetrievalQuery {
  /** Free-form natural-language query — tokenised internally. */
  readonly text: string;
  /** Top-K cut-off. Default 10. */
  readonly topK?: number;
  /**
   * Skip notes whose `classification` is in this set. Defaults to
   * `['ephemeral']` so disposable notes don't surface in normal recall.
   */
  readonly excludeClassifications?: readonly string[];
  /**
   * If true, recurses into sub-dirs under the workspace. Default false
   * — matches `listNotes` default (top-level only).
   */
  readonly recursive?: boolean;
}

export interface RetrievalHit {
  readonly note: Note;
  /** BM25 score (higher = more relevant). Strictly positive for hits. */
  readonly score: number;
  /** Matched query-terms found in the note (lower-cased, tokenised). */
  readonly matchedTerms: readonly string[];
}

export interface RetrievalResult {
  readonly query: string;
  readonly tokens: readonly string[];
  readonly hits: readonly RetrievalHit[];
  /** Number of notes scanned (before scoring/cutoff). */
  readonly totalScanned: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

export class RetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalError';
  }
}
