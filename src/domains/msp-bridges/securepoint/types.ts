/**
 * Securepoint USC Read-Bridge types.
 *
 * Per-customer status surfaces the two operator-relevant signals
 * from the Prometheus metrics:
 *   - is the UTM online right now?
 *   - how many days does its license still have?
 *
 * Other utm_* metrics matched by this customer's deviceId are
 * exposed under `additionalMetrics` for diagnostics drill-down,
 * but are not surfaced in the at-a-glance UI cell.
 *
 * @module @domains/msp-bridges/securepoint/types
 */
import type { Logger } from 'pino';

export interface MetricsSample {
  /** Map<labelKey, labelValue>. Both sides are strings. */
  readonly labels: Readonly<Record<string, string>>;
  /** Parsed numeric value. NaN never; we reject NaN at parse-time. */
  readonly value: number;
}

/** Map<metricName, samples[]>. */
export type PrometheusMap = ReadonlyMap<string, readonly MetricsSample[]>;

export type SecurepointLicenseStatus = 'valid' | 'expiring-soon' | 'expired' | 'unknown';

export interface SecurepointStatus {
  /** True iff `utm_usc_online_status{utm=deviceId}` is 1. */
  readonly online: boolean;
  /** Value of `utm_license_days_valid{utm=deviceId}`, null when absent. */
  readonly licenseDaysRemaining: number | null;
  readonly licenseStatus: SecurepointLicenseStatus;
  /** Echo of the customer.yaml-configured deviceId for in-UI display. */
  readonly deviceId: string;
  /**
   * Any other `utm_*` metric (besides the two surfaced above) whose
   * labels matched this device-id. Clipped to 20 for UI sanity.
   */
  readonly additionalMetrics: readonly { readonly name: string; readonly value: number }[];
}

export interface SecurepointBridgeConfig {
  /** Called fresh on every probe — returns null when no API-key set. */
  readonly getApiKey: () => Promise<string | null>;
  /** Default: https://portal.securepoint.cloud. */
  readonly baseUrl?: string;
  /** Default: "2.2" — sent as `?version=2.2`. */
  readonly apiVersion?: string;
  /** Default 60s. Shared parsed-metrics TTL. */
  readonly metricsTtlSec?: number;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** AbortController-driven request timeout. Default: 15_000. */
  readonly timeoutMs?: number;
  /** Optional pino logger. API key never reaches it. */
  readonly logger?: Logger;
}
