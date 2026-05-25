import { describe, expect, it } from 'vitest';
import {
  bm25Score,
  buildCorpusStats,
  buildDocStats,
} from '../../../src/domains/retrieval/index.js';

describe('buildCorpusStats', () => {
  it('returns zero stats for empty corpus', () => {
    const c = buildCorpusStats([]);
    expect(c.docCount).toBe(0);
    expect(c.avgDocLength).toBe(0);
    expect(c.docFrequency.size).toBe(0);
  });

  it('counts docFrequency as unique-per-doc (not total occurrences)', () => {
    const c = buildCorpusStats([
      ['foo', 'foo', 'bar'],
      ['foo', 'baz'],
    ]);
    // foo appears in both docs (df=2), bar+baz in one each (df=1).
    expect(c.docFrequency.get('foo')).toBe(2);
    expect(c.docFrequency.get('bar')).toBe(1);
    expect(c.docFrequency.get('baz')).toBe(1);
    expect(c.docCount).toBe(2);
    // avg length: (3 + 2) / 2 = 2.5
    expect(c.avgDocLength).toBe(2.5);
  });
});

describe('buildDocStats', () => {
  it('counts term-frequency + length correctly', () => {
    const d = buildDocStats(['a', 'b', 'a', 'c', 'a']);
    expect(d.length).toBe(5);
    expect(d.termFreq.get('a')).toBe(3);
    expect(d.termFreq.get('b')).toBe(1);
    expect(d.termFreq.get('c')).toBe(1);
  });

  it('handles empty token-list', () => {
    const d = buildDocStats([]);
    expect(d.length).toBe(0);
    expect(d.termFreq.size).toBe(0);
  });
});

describe('bm25Score', () => {
  it('returns 0 + no-match for empty corpus', () => {
    const d = buildDocStats(['x']);
    const c = buildCorpusStats([]);
    const r = bm25Score(d, ['x'], c);
    expect(r.score).toBe(0);
    expect(r.matchedTerms).toEqual([]);
  });

  it('returns 0 + no-match when none of the query terms hit', () => {
    const docs = [['foo', 'bar'], ['baz']];
    const corpus = buildCorpusStats(docs);
    const d = buildDocStats(docs[0] as string[]);
    const r = bm25Score(d, ['qux'], corpus);
    expect(r.score).toBe(0);
    expect(r.matchedTerms).toEqual([]);
  });

  it('matchedTerms only contains terms with tf > 0', () => {
    const docs = [['alpha', 'beta'], ['gamma']];
    const corpus = buildCorpusStats(docs);
    const d = buildDocStats(docs[0] as string[]);
    const r = bm25Score(d, ['alpha', 'gamma', 'delta'], corpus);
    expect(r.matchedTerms).toEqual(['alpha']);
    expect(r.score).toBeGreaterThan(0);
  });

  it('rare terms score higher than common terms (IDF property)', () => {
    // 'rare' appears in 1/3 docs; 'common' in 3/3.
    const docs = [
      ['rare', 'common'],
      ['common', 'filler'],
      ['common', 'noise'],
    ];
    const corpus = buildCorpusStats(docs);
    const doc0 = buildDocStats(docs[0] as string[]);
    const rare = bm25Score(doc0, ['rare'], corpus).score;
    const common = bm25Score(doc0, ['common'], corpus).score;
    expect(rare).toBeGreaterThan(common);
  });

  it('does not double-count duplicate query terms', () => {
    const docs = [['foo', 'bar']];
    const corpus = buildCorpusStats(docs);
    const d = buildDocStats(docs[0] as string[]);
    const single = bm25Score(d, ['foo'], corpus).score;
    const dup = bm25Score(d, ['foo', 'foo', 'foo'], corpus).score;
    expect(dup).toBeCloseTo(single, 10);
  });

  it('shorter docs score higher for same tf (length-normalisation)', () => {
    const longDoc = ['target', ...Array(20).fill('filler')];
    const shortDoc = ['target', 'extra'];
    const corpus = buildCorpusStats([longDoc, shortDoc]);
    const longStats = buildDocStats(longDoc);
    const shortStats = buildDocStats(shortDoc);
    const longScore = bm25Score(longStats, ['target'], corpus).score;
    const shortScore = bm25Score(shortStats, ['target'], corpus).score;
    expect(shortScore).toBeGreaterThan(longScore);
  });

  it('more occurrences of a term yields higher score (saturating TF)', () => {
    // Two docs of same length, one mentions target once, other twice.
    const corpus = buildCorpusStats([
      ['target', 'a', 'b', 'c'],
      ['target', 'target', 'a', 'b'],
    ]);
    const doc1 = buildDocStats(['target', 'a', 'b', 'c']);
    const doc2 = buildDocStats(['target', 'target', 'a', 'b']);
    expect(bm25Score(doc2, ['target'], corpus).score).toBeGreaterThan(
      bm25Score(doc1, ['target'], corpus).score,
    );
  });
});
