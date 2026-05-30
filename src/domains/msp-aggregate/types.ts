/**
 * MSP-Aggregate types — Phase 7-E.
 *
 * The aggregator coalesces N customer-probes per bridge into a single
 * `AggregateSnapshot` rendered by the dashboard. Each cell is one
 * (customer, bridge) intersection — present only when the bridge is
 * REGISTERED in the BridgeRegistry AND the customer has a `bridges.<kind>`
 * sub-object in their customer.yaml.
 *
 * @module @domains/msp-aggregate/types
 */

import type { NinjaStatus } from '../msp-bridges/ninja/types.js';
import type { SecurepointStatus } from '../msp-bridges/securepoint/types.js';
import type { SophosStatus } from '../msp-bridges/sophos/types.js';
import type { TanssStatus } from '../msp-bridges/tanss/types.js';
import type { BridgeKind } from '../msp-bridges/types.js';
import type { VeeamStatus } from '../msp-bridges/veeam/types.js';

/**
 * Discriminated cell result — mirrors `BridgeResult` plus two aggregator-
 * specific variants: `'timeout'` (probe didn't finish within the aggregate
 * hard-cap) and `'skipped'` (bridge not registered → no probe attempted).
 */
export type BridgeCellResult<T> =
  | {
      readonly kind: 'ok';
      readonly data: T;
      readonly durationMs: number;
      readonly probedAt: string;
    }
  | { readonly kind: 'misconfigured'; readonly message: string }
  | { readonly kind: 'auth-failed'; readonly message: string }
  | { readonly kind: 'unreachable'; readonly message: string }
  | { readonly kind: 'rate-limited'; readonly retryAfterSec: number; readonly message?: string }
  | { readonly kind: 'timeout'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/** Type-safe accessors per bridge kind — keeps frontend cells correctly typed. */
export interface CustomerHealthCells {
  readonly tanss?: BridgeCellResult<TanssStatus>;
  readonly veeam?: BridgeCellResult<VeeamStatus>;
  readonly ninja?: BridgeCellResult<NinjaStatus>;
  readonly sophos?: BridgeCellResult<SophosStatus>;
  readonly securepoint?: BridgeCellResult<SecurepointStatus>;
  // m365 has no bridge yet; its cell is written dynamically by the prober if/when added.
}

export interface CustomerHealthRow {
  readonly slug: string;
  readonly displayName: string;
  readonly cells: CustomerHealthCells;
}

/** Top-level shape returned by `/api/msp-health/rows`. */
export interface AggregateSnapshot {
  /** ISO-8601 UTC. */
  readonly snapshotAt: string;
  /** Total wall-clock for the parallel-probe pass. */
  readonly durationMs: number;
  /** Bridge kinds present in the registry at snapshot-time. */
  readonly registeredBridges: readonly BridgeKind[];
  readonly rows: readonly CustomerHealthRow[];
}

/** Aggregator orchestration options. */
export interface AggregateProberOpts {
  /** Per-probe timeout. Capped at 10_000 by default. */
  readonly probeTimeoutMs?: number;
  /** Hard-cap on whole-aggregate runtime. Default 30_000. */
  readonly hardTimeoutMs?: number;
}
