/**
 * Per-IP token-bucket rate-limit for login (Phase Web-7-2,
 * ADR-0036 draft §Rate-Limit).
 *
 * Defaults: 5 failed attempts per 15 minutes per IP → 429 with
 * `Retry-After` until the bucket refills.
 *
 * In-memory only — restart resets the buckets. Persistent rate-store
 * is Phase Web-8 once the audit-log can be the source of truth for
 * the cooldown window.
 *
 * Bucket model: each IP starts with `capacity` tokens. Each FAILED
 * login consumes one. Successful login resets the bucket. When
 * `tokens <= 0`, requests are rejected until the next refill.
 * Refill: linear, full-capacity-per-`refillIntervalMs`.
 *
 * Time source injectable so tests can fast-forward.
 *
 * @module @server/rate-limit
 */

export interface LoginRateLimitOpts {
  /** Max failed attempts before block. Default 5. */
  readonly capacity?: number;
  /** Window over which the bucket refills to capacity, ms. Default 15 min. */
  readonly refillIntervalMs?: number;
  readonly now?: () => number;
  /** Cap on tracked IPs so a flood of unique IPs can't OOM us. */
  readonly maxTrackedIps?: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds the client should wait before retrying. 0 when allowed. */
  readonly retryAfterSec: number;
}

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TRACKED_IPS = 10_000;

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly now: () => number;
  private readonly maxTracked: number;

  constructor(opts: LoginRateLimitOpts = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.refillIntervalMs = opts.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.maxTracked = opts.maxTrackedIps ?? DEFAULT_MAX_TRACKED_IPS;
  }

  /**
   * Pre-flight check: does this IP currently have tokens? Does NOT
   * consume — call `recordFailed` after a real failed attempt to debit
   * the bucket.
   */
  check(ip: string): RateLimitDecision {
    const bucket = this.refilled(ip);
    if (bucket.tokens > 0) {
      return { allowed: true, retryAfterSec: 0 };
    }
    const msToRefill = Math.max(0, this.refillIntervalMs - (this.now() - bucket.lastRefill));
    return { allowed: false, retryAfterSec: Math.ceil(msToRefill / 1000) };
  }

  recordFailed(ip: string): void {
    const bucket = this.refilled(ip);
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  recordSuccess(ip: string): void {
    // Successful login wipes the failure history for this IP.
    this.buckets.delete(ip);
  }

  /** Diagnostic helper. */
  remaining(ip: string): number {
    return this.refilled(ip).tokens;
  }

  /** Diagnostic helper. */
  size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }

  private refilled(ip: string): Bucket {
    let bucket = this.buckets.get(ip);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxTracked) {
        this.evictOldest();
      }
      bucket = { tokens: this.capacity, lastRefill: this.now() };
      this.buckets.set(ip, bucket);
      return bucket;
    }
    const elapsed = this.now() - bucket.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      bucket.tokens = this.capacity;
      bucket.lastRefill = this.now();
    }
    return bucket;
  }

  private evictOldest(): void {
    const oldest = this.buckets.keys().next().value;
    if (oldest !== undefined) this.buckets.delete(oldest);
  }
}
