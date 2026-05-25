/**
 * Workspace-scoped linear-scan retrieval over notes.
 *
 * Pipeline:
 *   1. listNotes(workspace) — get all candidate notes
 *   2. tokenise body + indexable frontmatter (tags, type)
 *   3. build BM25 corpus stats over the workspace
 *   4. score each doc against the query
 *   5. filter out zero-score, sort desc, slice top-K
 *
 * Workspace isolation is structural (ADR-0031 §FTS5-Query-Always-Filtered):
 * we only ever scan one workspace's notes per query. Cross-workspace
 * retrieval is an explicit caller-iteration of multiple invocations,
 * never an automatic merge.
 *
 * @module @domains/retrieval/linear-scan
 */
import { listNotes, type Note } from '../notes/index.js';
import type { WorkspaceId } from '../workspace/index.js';
import { bm25Score, buildCorpusStats, buildDocStats, type DocStats } from './scorer.js';
import { tokenize } from './tokenizer.js';
import type { RetrievalHit, RetrievalQuery, RetrievalResult } from './types.js';

const DEFAULT_TOP_K = 10;
const DEFAULT_EXCLUDE_CLASSIFICATIONS: readonly string[] = ['ephemeral'];

/**
 * Builds the indexable text for one note: body + frontmatter.tags
 * (joined) + frontmatter.type. Other frontmatter (classification,
 * schema_version, timestamps) is metadata, not searchable.
 */
function indexableText(note: Note): string {
  const parts: string[] = [note.body];
  const tags = note.frontmatter.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string') parts.push(tag);
    }
  }
  const type = note.frontmatter.type;
  if (typeof type === 'string') parts.push(type);
  return parts.join(' ');
}

/**
 * Runs a BM25-ranked retrieval over the given workspace.
 *
 * Returns an empty `hits` array (with `tokens` populated) when the
 * query produces no token after tokenisation — caller can render a
 * "query too short" message.
 */
export function searchWorkspace(
  vaultRoot: string,
  workspaceId: WorkspaceId,
  query: RetrievalQuery,
): RetrievalResult {
  const startedAt = Date.now();
  const topK = query.topK ?? DEFAULT_TOP_K;
  const excluded = new Set(query.excludeClassifications ?? DEFAULT_EXCLUDE_CLASSIFICATIONS);

  const queryTokens = tokenize(query.text);
  if (queryTokens.length === 0) {
    return {
      query: query.text,
      tokens: [],
      hits: [],
      totalScanned: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const notes = listNotes(vaultRoot, workspaceId, {
    recursive: query.recursive === true,
  }).filter((n) => !excluded.has(String(n.frontmatter.classification)));

  if (notes.length === 0) {
    return {
      query: query.text,
      tokens: queryTokens,
      hits: [],
      totalScanned: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const tokenisedDocs: string[][] = notes.map((n) => tokenize(indexableText(n)));
  const corpus = buildCorpusStats(tokenisedDocs);
  const docStats: DocStats[] = tokenisedDocs.map(buildDocStats);

  const hits: RetrievalHit[] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const stats = docStats[i];
    if (note === undefined || stats === undefined) continue;
    const { score, matchedTerms } = bm25Score(stats, queryTokens, corpus);
    if (score <= 0) continue;
    hits.push({ note, score, matchedTerms });
  }

  hits.sort((a, b) => b.score - a.score);

  return {
    query: query.text,
    tokens: queryTokens,
    hits: hits.slice(0, topK),
    totalScanned: notes.length,
    durationMs: Date.now() - startedAt,
  };
}
