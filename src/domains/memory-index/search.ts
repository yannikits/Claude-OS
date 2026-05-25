/**
 * FTS-backed search drop-in (Phase 3d).
 *
 * Pipeline:
 *   1. tokenize query (same Unicode-aware tokeniser as Phase-2c)
 *   2. FTS4 MATCH on `documents_fts` → candidate rowids
 *   3. JOIN to `documents` with workspace + classification WHERE-clauses
 *      (workspace isolation is structural per ADR-0031)
 *   4. apply Phase-2c BM25 scorer over the candidate set
 *   5. sort desc, slice top-K
 *
 * Returns the same shape as `searchWorkspace` (Phase 2c) so it's a
 * drop-in replacement behind a feature-flag (Phase 3e wires that up).
 *
 * v1 caveat: BM25 corpus stats are computed from the FTS-candidate set,
 * not the full workspace. This biases IDF slightly for narrow queries
 * but is fine for top-K ranking within candidates. Workspace-wide
 * cached corpus stats are a Phase 3+ optimisation.
 *
 * @module @domains/memory-index/search
 */
import type { Database } from 'sql.js';
import type { NoteClassification, NoteFrontmatter } from '../notes/index.js';
import type { RetrievalHit, RetrievalQuery, RetrievalResult } from '../retrieval/index.js';
import { bm25Score, buildCorpusStats, buildDocStats, tokenize } from '../retrieval/index.js';
import type { WorkspaceId } from '../workspace/index.js';

const DEFAULT_TOP_K = 10;
const DEFAULT_EXCLUDE_CLASSIFICATIONS: readonly string[] = ['ephemeral'];

/**
 * Quotes a value for FTS4 MATCH so user input can't inject MATCH
 * operators (AND/OR/NEAR/NOT/-/+/^). Wraps in double-quotes and
 * doubles any embedded `"`. FTS4 treats the whole thing as a phrase
 * (multiple tokens → all must appear, no syntax surprises).
 */
function escapeFtsTerm(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function buildFtsMatch(tokens: readonly string[]): string {
  if (tokens.length === 0) return '';
  // OR-join terms so any matching token brings the doc as a candidate
  // (BM25 then ranks by overlap). AND-join would require all-of-query,
  // too restrictive for natural-language input.
  return tokens.map(escapeFtsTerm).join(' OR ');
}

interface CandidateRow {
  readonly path: string;
  readonly workspace: string;
  readonly classification: string;
  readonly frontmatterJson: string;
  readonly body: string;
}

function fetchCandidates(
  db: Database,
  matchExpr: string,
  workspaceId: string,
  excluded: ReadonlySet<string>,
): CandidateRow[] {
  // Build the parameterised query. We can't bind a workspace=? plus the
  // optional NOT IN list cleanly in one statement, so we build the
  // classification filter inline (values are from a small fixed enum;
  // no injection risk).
  const exclList = [...excluded].map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
  const exclClause = exclList.length > 0 ? `AND d.classification NOT IN (${exclList})` : '';
  const sql = `
    SELECT d.path, d.workspace, d.classification, d.frontmatter_json, d.body
    FROM documents_fts f
    JOIN documents d ON d.rowid = f.rowid
    WHERE f.body MATCH ?
      AND d.workspace = ?
      ${exclClause}
  `;
  const stmt = db.prepare(sql);
  stmt.bind([matchExpr, workspaceId]);
  const out: CandidateRow[] = [];
  try {
    while (stmt.step()) {
      const row = stmt.get();
      out.push({
        path: String(row[0]),
        workspace: String(row[1]),
        classification: String(row[2]),
        frontmatterJson: String(row[3]),
        body: String(row[4]),
      });
    }
  } finally {
    stmt.free();
  }
  return out;
}

function rowToHit(row: CandidateRow, score: number, matchedTerms: readonly string[]): RetrievalHit {
  let frontmatter: NoteFrontmatter;
  try {
    frontmatter = JSON.parse(row.frontmatterJson) as NoteFrontmatter;
  } catch {
    frontmatter = {
      workspace: row.workspace,
      classification: row.classification as NoteClassification,
      schema_version: 1,
    };
  }
  return {
    score,
    matchedTerms: [...matchedTerms],
    note: {
      path: row.path,
      workspace: row.workspace,
      frontmatter,
      body: row.body,
      rawFrontmatter: '',
    },
  };
}

/**
 * FTS-backed equivalent of Phase-2c `searchWorkspace`. Same return shape.
 *
 * Empty query → empty hits (no FTS-call). Empty workspace → empty hits.
 * FTS produces no candidates → empty hits (totalScanned = 0).
 */
export function searchIndex(
  db: Database,
  workspaceId: WorkspaceId,
  query: RetrievalQuery,
): RetrievalResult {
  const startedAt = Date.now();
  const topK = query.topK ?? DEFAULT_TOP_K;
  const excluded = new Set(query.excludeClassifications ?? DEFAULT_EXCLUDE_CLASSIFICATIONS);

  const tokens = tokenize(query.text);
  if (tokens.length === 0) {
    return {
      query: query.text,
      tokens: [],
      hits: [],
      totalScanned: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const matchExpr = buildFtsMatch(tokens);
  const candidates = fetchCandidates(db, matchExpr, workspaceId, excluded);
  if (candidates.length === 0) {
    return {
      query: query.text,
      tokens,
      hits: [],
      totalScanned: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const tokenisedDocs = candidates.map((c) => tokenize(c.body));
  const corpus = buildCorpusStats(tokenisedDocs);
  const docStats = tokenisedDocs.map(buildDocStats);

  const hits: RetrievalHit[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const stats = docStats[i];
    const row = candidates[i];
    if (stats === undefined || row === undefined) continue;
    const { score, matchedTerms } = bm25Score(stats, tokens, corpus);
    if (score <= 0) continue;
    hits.push(rowToHit(row, score, matchedTerms));
  }

  hits.sort((a, b) => b.score - a.score);

  return {
    query: query.text,
    tokens,
    hits: hits.slice(0, topK),
    totalScanned: candidates.length,
    durationMs: Date.now() - startedAt,
  };
}
