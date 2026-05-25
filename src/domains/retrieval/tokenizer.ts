/**
 * Lightweight tokeniser for linear-scan retrieval.
 *
 * Strategy:
 *   - lower-case
 *   - split on any non-word character (Unicode-aware via `\p{L}\p{N}_`)
 *   - drop tokens shorter than 2 chars
 *
 * No stopword removal — BM25's IDF term naturally down-weights common
 * words. Numbers stay (dates, ticket-ids, port-numbers are searchable).
 *
 * Unicode rationale: Yannik writes German. `[a-z0-9]+` would split
 * "Mitarbeiter" into "mitarbeiter" but also strip umlauts ("über" →
 * ["ber"]). `\p{L}` (any letter) + `\p{N}` (any number) preserves
 * "über", "groß", "café" intact.
 *
 * @module @domains/retrieval/tokenizer
 */

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const MIN_TOKEN_LENGTH = 2;

/**
 * Tokenises `text` into a lower-cased word-list. Stable order
 * (preserves input order), duplicates preserved (caller may dedupe).
 */
export function tokenize(text: string): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  const matches = text.matchAll(TOKEN_PATTERN);
  for (const m of matches) {
    const token = m[0].toLowerCase();
    if (token.length >= MIN_TOKEN_LENGTH) out.push(token);
  }
  return out;
}

/**
 * Deduplicates a token-list preserving first-seen order.
 */
export function uniqTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
