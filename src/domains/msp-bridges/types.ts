/**
 * MSP-Bridges — Foundation types (Phase 7-A).
 *
 * Eine Bridge ist ein typed Wrapper um eine externe MSP-API (TANSS,
 * Veeam, Sophos, Securepoint, M365). Phase 7-A liefert nur das
 * Interface + Registry + Audit-Wrapper; konkrete Implementierungen
 * kommen in 7-B/C/D.
 *
 * Auth-Modell: jede Bridge liest ihre Secrets selbst aus dem
 * secrets-Backend (Pattern `bridge:<kind>:<slug>:api-token`). Die
 * customer.yaml enthält NUR Identifier — keine Tokens.
 *
 * @module @domains/msp-bridges/types
 */
import type { CustomerRecord } from '../msp-customers/index.js';

export type BridgeKind = 'tanss' | 'veeam' | 'sophos' | 'securepoint' | 'm365' | 'ninja';

/**
 * Discriminated result. Operator-facing — `kind` drives the UI tinting
 * (ok=green/idle=grey/warn=amber/error/auth-failed=red, rate-limited=
 * amber-pulse). Read-only ops, so no `denied` (use Audit's outcome for
 * that classification).
 */
export type BridgeResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unreachable'; message: string }
  | { kind: 'auth-failed'; message: string }
  | { kind: 'rate-limited'; retryAfterSec: number; message?: string }
  | { kind: 'misconfigured'; message: string }
  | { kind: 'error'; message: string };

/**
 * Probe envelope. Always returned (never throws) so the aggregat-layer
 * can render every customer + every bridge without crash-paths.
 */
export interface BridgeProbe<T> {
  readonly bridgeKind: BridgeKind;
  readonly customerSlug: string;
  /** ISO-8601 at probe-start. */
  readonly probedAt: string;
  readonly durationMs: number;
  readonly result: BridgeResult<T>;
}

/**
 * Read-only bridge contract. Implementors should:
 *   1. NEVER throw — wrap any error as `{ kind: 'error', message }`.
 *   2. Check that the customer has the relevant `bridges.<kind>` sub-
 *      object — return `misconfigured` when not.
 *   3. Fetch the API-token from the secrets-Backend on every call —
 *      tokens may rotate.
 *   4. Time their own work; return `durationMs` in the probe.
 */
export interface ReadBridge<TStatus> {
  readonly kind: BridgeKind;
  probe(customer: CustomerRecord): Promise<BridgeProbe<TStatus>>;
}

export class BridgeRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeRegistryError';
  }
}
