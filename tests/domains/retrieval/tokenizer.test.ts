import { describe, expect, it } from 'vitest';
import { tokenize, uniqTokens } from '../../../src/domains/retrieval/index.js';

describe('tokenize', () => {
  it('returns empty for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('splits on whitespace + punctuation', () => {
    expect(tokenize('Hello, world! Foo.bar')).toEqual(['hello', 'world', 'foo', 'bar']);
  });

  it('drops tokens shorter than 2 chars', () => {
    expect(tokenize('a b cd e')).toEqual(['cd']);
  });

  it('lower-cases everything', () => {
    expect(tokenize('HelloWORLD')).toEqual(['helloworld']);
  });

  it('preserves German umlauts (Unicode-aware)', () => {
    expect(tokenize('Über Mitarbeiter müssen größere Räume haben.')).toEqual([
      'über',
      'mitarbeiter',
      'müssen',
      'größere',
      'räume',
      'haben',
    ]);
  });

  it('keeps numbers + alphanumeric tokens', () => {
    expect(tokenize('Ticket #4711 due 2026-05-25')).toEqual([
      'ticket',
      '4711',
      'due',
      '2026',
      '05',
      '25',
    ]);
  });

  it('preserves duplicates in order', () => {
    expect(tokenize('foo foo bar foo')).toEqual(['foo', 'foo', 'bar', 'foo']);
  });
});

describe('uniqTokens', () => {
  it('dedupes preserving first-seen order', () => {
    expect(uniqTokens(['foo', 'bar', 'foo', 'baz', 'bar'])).toEqual(['foo', 'bar', 'baz']);
  });

  it('handles empty input', () => {
    expect(uniqTokens([])).toEqual([]);
  });
});
