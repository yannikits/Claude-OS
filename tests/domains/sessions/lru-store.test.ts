import { describe, expect, it } from 'vitest';
import { LruStore } from '../../../src/domains/sessions/index.js';

describe('LruStore', () => {
  it('stores and retrieves values', () => {
    const lru = new LruStore<string, number>({ capacity: 3 });
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBe(2);
    expect(lru.size()).toBe(2);
  });

  it('returns null for unknown keys', () => {
    const lru = new LruStore<string, number>({ capacity: 3 });
    expect(lru.get('missing')).toBeNull();
    expect(lru.peek('missing')).toBeNull();
  });

  it('evicts the least-recently-used entry when capacity exceeded', () => {
    const lru = new LruStore<string, number>({ capacity: 3 });
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.set('d', 4);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('d')).toBe(true);
    expect(lru.evicted()).toBe(1);
  });

  it('get() promotes recency — protected against eviction', () => {
    const lru = new LruStore<string, number>({ capacity: 3 });
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    // Touch a, which makes b the LRU.
    expect(lru.get('a')).toBe(1);
    lru.set('d', 4);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
  });

  it('peek() does not promote recency', () => {
    const lru = new LruStore<string, number>({ capacity: 3 });
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.peek('a')).toBe(1);
    lru.set('d', 4);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
  });

  it('delete returns true when key existed, false otherwise', () => {
    const lru = new LruStore<string, number>({ capacity: 3 });
    lru.set('a', 1);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('a')).toBe(false);
  });

  it('rejects invalid capacity', () => {
    expect(() => new LruStore<string, number>({ capacity: 0 })).toThrow(/positive integer/);
    expect(() => new LruStore<string, number>({ capacity: -1 })).toThrow();
    expect(() => new LruStore<string, number>({ capacity: 1.5 })).toThrow();
  });

  it('clear() empties the store', () => {
    const lru = new LruStore<string, number>({ capacity: 3 });
    lru.set('a', 1);
    lru.set('b', 2);
    lru.clear();
    expect(lru.size()).toBe(0);
    expect(lru.get('a')).toBeNull();
  });

  it('values() returns a snapshot', () => {
    const lru = new LruStore<string, number>({ capacity: 3 });
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.values().sort()).toEqual([1, 2]);
  });
});
