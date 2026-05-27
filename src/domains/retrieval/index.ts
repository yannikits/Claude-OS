/**
 * Retrieval domain — workspace-scoped BM25 linear-scan over notes
 * (Phase 2c, v1 Memory MVP).
 *
 * @module @domains/retrieval
 */

export {
  buildScope,
  type CrossWorkspaceSearchInput,
  type CrossWorkspaceSearchOpts,
  type CrossWorkspaceSearchResult,
  crossWorkspaceSearch,
} from './cross-workspace.js';
export {
  type DispatcherOpts,
  type DispatcherResult,
  type SearchKind,
  searchWithFallback,
} from './dispatcher.js';
export { searchWorkspace } from './linear-scan.js';
export {
  type Bm25Params,
  bm25Score,
  buildCorpusStats,
  buildDocStats,
  type CorpusStats,
  DEFAULT_BM25,
  type DocStats,
} from './scorer.js';
export { tokenize, uniqTokens } from './tokenizer.js';
export {
  RetrievalError,
  type RetrievalHit,
  type RetrievalQuery,
  type RetrievalResult,
} from './types.js';
