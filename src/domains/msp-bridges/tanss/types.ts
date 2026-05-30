/**
 * TANSS Read-Bridge types.
 *
 * Shapes are kept intentionally small — the full TANSS-Ticket has 30+
 * fields, but the probe only needs counts, the newest update timestamp,
 * and one sample for the dashboard cell.
 *
 * PII boundary (per SECURITY.md §4 + ADR-0038):
 *   - The `sample.subject` MAY contain PII (customer names, hostnames).
 *     It is carried in the probe-return-value for in-session display only.
 *     It MUST NOT be written to the audit log.
 *   - Counts + timestamps are not PII.
 *
 * @module @domains/msp-bridges/tanss/types
 */
import type { Logger } from 'pino';

/** Compact, dashboard-ready status payload for one customer. */
export interface TanssStatus {
  readonly openCount: number;
  readonly totalCount: number;
  readonly newestUpdateAt: string | null;
  readonly sample: TanssTicketSample | null;
}

export interface TanssTicketSample {
  readonly id: number;
  readonly subject: string;
  readonly status: string;
}

/**
 * Subset of TANSS' ticket-response we consume. The real response has
 * 30+ fields; we read just the ones the mapper needs and ignore the rest.
 * Fields are all optional because the schema isn't versioned and we want
 * the mapper to be defensive (ADR-0038 forward-compat philosophy).
 */
export interface TanssTicketRaw {
  readonly id?: number;
  readonly subject?: string;
  readonly status?: string;
  readonly statusName?: string;
  readonly updateDate?: number | string;
  readonly date?: number | string;
  readonly closed?: boolean;
}

/** DI-shape for `TanssBridge`. */
export interface TanssBridgeConfig {
  /** Origin only — paths are appended. Trailing slash is normalised away. */
  readonly serverUrl: string;
  /**
   * API base path prepended to `/tickets/company/{id}`. Default `/api/v1`.
   * Some TANSS installs serve the REST API under `/backend/api/v1` — set this
   * (or `$CLAUDE_OS_TANSS_API_BASE`) to match. Leading slash added + trailing
   * slash normalised away.
   */
  readonly apiBase?: string;
  /** Called on every probe. Returns null when secrets-backend has no token. */
  readonly getApiToken: () => Promise<string | null>;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** AbortController-driven request timeout. Default: 10_000. */
  readonly timeoutMs?: number;
  /** Optional pino logger. Token is NEVER passed to it. */
  readonly logger?: Logger;
}
