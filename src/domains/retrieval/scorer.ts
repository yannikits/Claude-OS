/**
 * BM25 (Okapi) scoring — single-doc score given pre-computed corpus
 * statistics. The `bm25Score` function is pure (no I/O), so unit tests
 * can pin numerical behaviour directly.
 *
 * BM25 formula (Robertson/Sparck Jones, simplified ranking variant):
 *
 *     score(doc, query) = sum over q in query of
 *         IDF(q) * (tf(q,doc) * (k1+1)) /
 *                  (tf(q,doc) + k1 * (1 - b + b * dl/avgdl))
 *
 *     IDF(q) = ln( (N - df(q) + 0.5) / (df(q) + 0.5) + 1 )
 *
 * Parameter defaults (k1=1.5, b=0.75) are the industry standard from
 * Lucene/Elasticsearch.
 *
 * @module @domains/retrieval/scorer
 */

export interface CorpusStats {
  /** Total number of documents in the corpus. */
  readonly docCount: number;
  /** Document-frequency per term (number of docs containing the term). */
  readonly docFrequency: ReadonlyMap<string, number>;
  /** Mean document length (in tokens) across the corpus. */
  readonly avgDocLength: number;
}

export interface DocStats {
  /** Term-frequency map for one doc (term -> occurrences). */
  readonly termFreq: ReadonlyMap<string, number>;
  /** Total token count of the doc (length, not unique-count). */
  readonly length: number;
}

export interface Bm25Params {
  readonly k1: number;
  readonly b: number;
}

export const DEFAULT_BM25: Bm25Params = { k1: 1.5, b: 0.75 };

/**
 * Builds corpus stats from a list of pre-tokenised docs.
 *
 * `docs` is `string[][]` — each inner array is the token-stream of one
 * doc (caller pre-tokenised it). Empty docs are tolerated but
 * contribute 0 to docFrequency.
 */
export function buildCorpusStats(docs: readonly (readonly string[])[]): CorpusStats {
  const docFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const tokens of docs) {
    totalLength += tokens.length;
    const seen = new Set<string>();
    for (const t of tokens) seen.add(t);
    for (const t of seen) docFrequency.set(t, (docFrequency.get(t) ?? 0) + 1);
  }
  return {
    docCount: docs.length,
    docFrequency,
    avgDocLength: docs.length === 0 ? 0 : totalLength / docs.length,
  };
}

/**
 * Builds per-doc stats — term-frequency map + length.
 */
export function buildDocStats(tokens: readonly string[]): DocStats {
  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  return { termFreq, length: tokens.length };
}

/**
 * Computes the BM25 score for one doc against one query. Returns 0
 * when no query-term matches. Returns 0 when corpus is empty.
 *
 * Query-terms repeated across the query are counted once — BM25's
 * IDF * TF formula already amplifies via tf in the doc, not via
 * query-occurrence.
 */
export function bm25Score(
  doc: DocStats,
  queryTokens: readonly string[],
  corpus: CorpusStats,
  params: Bm25Params = DEFAULT_BM25,
): { score: number; matchedTerms: string[] } {
  if (corpus.docCount === 0 || corpus.avgDocLength === 0) {
    return { score: 0, matchedTerms: [] };
  }
  const { k1, b } = params;
  const seen = new Set<string>();
  let score = 0;
  const matched: string[] = [];
  for (const q of queryTokens) {
    if (seen.has(q)) continue;
    seen.add(q);
    const tf = doc.termFreq.get(q) ?? 0;
    if (tf === 0) continue;
    const df = corpus.docFrequency.get(q) ?? 0;
    // df=0 should not happen if doc actually has the term, but guard
    // anyway in case the doc isn't in the corpus that built stats.
    if (df === 0) continue;
    matched.push(q);
    const idf = Math.log((corpus.docCount - df + 0.5) / (df + 0.5) + 1);
    const norm = doc.length / corpus.avgDocLength;
    const tfWeight = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * norm));
    score += idf * tfWeight;
  }
  return { score, matchedTerms: matched };
}
