/**
 * Small LRU store for in-process session entries.
 *
 * Built on `Map` (which preserves insertion order — re-inserting a key
 * moves it to the most-recent position). When `size > capacity`, the
 * least-recently-used entry (the first map key) is evicted.
 *
 * No external dep needed. The store does NOT auto-expire entries by
 * time — expiry is owned by `SessionRepository` so the LRU primitive
 * stays pure and trivially testable.
 *
 * @module @domains/sessions/lru-store
 */

export interface LruStoreOpts {
  readonly capacity: number;
}

export class LruStore<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;
  private evictedCount = 0;

  constructor(opts: LruStoreOpts) {
    if (!Number.isInteger(opts.capacity) || opts.capacity < 1) {
      throw new Error(`LruStore: capacity must be a positive integer, got ${opts.capacity}`);
    }
    this.capacity = opts.capacity;
  }

  /**
   * Get the value and move the key to most-recent position (so the LRU
   * tail won't evict it on the next set).
   */
  get(key: K): V | null {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Get without touching recency — used by tests. */
  peek(key: K): V | null {
    return this.map.has(key) ? (this.map.get(key) as V) : null;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const lruKey = this.map.keys().next().value;
      if (lruKey !== undefined) {
        this.map.delete(lruKey);
        this.evictedCount++;
      }
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  /** Diagnostic — how many entries have been evicted to make room. */
  evicted(): number {
    return this.evictedCount;
  }

  /** Take a snapshot of values for filtered iteration (e.g. "expire all"). */
  values(): V[] {
    return [...this.map.values()];
  }
}
