/**
 * Shared metrics cache for the Securepoint bridge.
 *
 * Single-slot TTL cache for the parsed Prometheus map. Per-customer
 * probes within the TTL window share ONE upstream fetch — critical for
 * the 7-E aggregator-pass over many customers.
 *
 * Stampede protection: concurrent callers share a single in-flight
 * loader Promise (same pattern as AggregateCache).
 *
 * @module @domains/msp-bridges/securepoint/metrics-cache
 */
import type { PrometheusMap } from './types.js';

export interface MetricsCacheOpts {
  readonly ttlSec?: number;
  readonly now?: () => number;
}

export class SecurepointMetricsCache {
  private snapshot: PrometheusMap | null = null;
  private storedAtMs = 0;
  private inFlight: Promise<PrometheusMap> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: MetricsCacheOpts = {}) {
    this.ttlMs = (opts.ttlSec ?? 60) * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  get(): PrometheusMap | null {
    if (this.snapshot === null) return null;
    if (this.now() - this.storedAtMs >= this.ttlMs) return null;
    return this.snapshot;
  }

  invalidate(): void {
    this.snapshot = null;
    this.storedAtMs = 0;
  }

  async getOrLoad(loader: () => Promise<PrometheusMap>): Promise<PrometheusMap> {
    const cached = this.get();
    if (cached !== null) return cached;
    if (this.inFlight !== null) return this.inFlight;
    const promise = loader().then(
      (snap) => {
        this.snapshot = snap;
        this.storedAtMs = this.now();
        this.inFlight = null;
        return snap;
      },
      (err) => {
        this.inFlight = null;
        throw err;
      },
    );
    this.inFlight = promise;
    return promise;
  }
}
