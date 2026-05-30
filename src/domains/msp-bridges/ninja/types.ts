/**
 * NinjaOne Read-Bridge types.
 *
 * Single-tenant per MSP (one region base-url, one OAuth client app); the
 * customer mapping is the NinjaOne organization-id. The probe reports device
 * counts + active-alert count for one organization.
 *
 * @module @domains/msp-bridges/ninja/types
 */
import type { Logger } from 'pino';

/** Compact, dashboard-ready status payload for one customer's Ninja org. */
export interface NinjaStatus {
  readonly deviceCount: number;
  readonly offlineCount: number;
  /** Active-alert count, or null when the alerts endpoint was unavailable. */
  readonly alertCount: number | null;
  /**
   * Alerts whose severity is not NONE/empty — the actionable subset. NinjaOne
   * emits many severity=NONE conditions (e.g. patch reminders); this separates
   * signal from noise. Null when the alerts endpoint was unavailable.
   */
  readonly actionableAlertCount: number | null;
}

/** Subset of a NinjaOne device we consume (defensive — all optional). */
export interface NinjaDeviceRaw {
  readonly id?: number;
  readonly systemName?: string;
  readonly offline?: boolean;
}

/** Subset of a NinjaOne alert / triggered-condition we consume. */
export interface NinjaAlertRaw {
  readonly uid?: string;
  readonly severity?: string;
}

export interface NinjaCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Resolves the OAuth client-app credentials. Null → bridge emits auth-failed. */
export type NinjaCredentialsResolver = () => Promise<NinjaCredentials | null>;

/** DI-shape for `NinjaBridge`. */
export interface NinjaBridgeConfig {
  /** Region base URL, e.g. `https://eu.ninjarmm.com`. */
  readonly baseUrl: string;
  readonly getCredentials: NinjaCredentialsResolver;
  /** OAuth scope. Default `monitoring` (read-only). */
  readonly scope?: string;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** AbortController-driven request timeout. Default 15_000. */
  readonly timeoutMs?: number;
  /** Optional pino logger. Secrets are NEVER passed to it. */
  readonly logger?: Logger;
}
