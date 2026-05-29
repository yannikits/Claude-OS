/**
 * SecurepointBridge — per-MSP cloud-API Read-Bridge.
 *
 * Topologically different from TANSS/Veeam/Sophos: ONE API endpoint
 * (portal.securepoint.cloud) returns all UTMs of all mandanten in one
 * request. We fetch + parse once, cache the parsed Prometheus map for
 * 60s (default), and per-customer-probe filter by `deviceId`.
 *
 * Hard-Contract per ADR-0038:
 *   - never throws
 *   - misconfigured when customer.bridges?.securepoint is missing → no HTTP-call
 *   - auth-failed when no API-key in secrets → no HTTP-call
 *   - getApiKey() called on EVERY probe (token rotation works) — cache only
 *     skips the upstream fetch, not the secret lookup
 *   - durationMs is real
 *
 * @module @domains/msp-bridges/securepoint/bridge
 */
import type { CustomerRecord } from '../../msp-customers/index.js';
import type { BridgeKind, BridgeProbe, BridgeResult, ReadBridge } from '../types.js';
import { classifyHttpStatus, classifyThrown } from './classify-error.js';
import { isDeviceMissing, mapSecurepoint } from './mapper.js';
import { SecurepointMetricsCache } from './metrics-cache.js';
import { parsePrometheus } from './prom-parser.js';
import type { PrometheusMap, SecurepointBridgeConfig, SecurepointStatus } from './types.js';

const DEFAULT_BASE_URL = 'https://portal.securepoint.cloud';
const DEFAULT_API_VERSION = '2.2';
const DEFAULT_TIMEOUT_MS = 15_000;
const METRICS_PATH = '/sms-mgt-api/api/2.0/metrics';

export class SecurepointBridge implements ReadBridge<SecurepointStatus> {
  readonly kind: BridgeKind = 'securepoint';
  private readonly cache: SecurepointMetricsCache;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: SecurepointBridgeConfig) {
    this.cache = new SecurepointMetricsCache({
      ...(config.metricsTtlSec !== undefined ? { ttlSec: config.metricsTtlSec } : {}),
    });
    this.baseUrl = stripTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async probe(customer: CustomerRecord): Promise<BridgeProbe<SecurepointStatus>> {
    const probedAt = new Date().toISOString();
    const start = Date.now();
    const ids = customer.bridges?.securepoint;
    if (!ids || ids.deviceId.length === 0) {
      return done(customer, probedAt, start, {
        kind: 'misconfigured',
        message: 'customer.yaml has no bridges.securepoint.deviceId',
      });
    }

    const apiKey = await this.config.getApiKey();
    if (apiKey === null || apiKey.length === 0) {
      return done(customer, probedAt, start, {
        kind: 'auth-failed',
        message: 'no API-key in secrets-backend (key: securepoint/apiKey)',
      });
    }

    // Fetch (cached if fresh) — multiple concurrent customer-probes
    // share ONE in-flight load via stampede-protection.
    let metrics: PrometheusMap | null = null;
    let loadError: BridgeResult<never> | null = null;
    try {
      metrics = await this.cache.getOrLoad(() => this.fetchMetrics(apiKey));
    } catch (err) {
      // Treat loader-side bridge errors as the wrapped result if available;
      // otherwise as a generic thrown classification.
      if (err && typeof err === 'object' && 'kind' in err) {
        loadError = err as BridgeResult<never>;
      } else {
        loadError = classifyThrown(err);
      }
    }
    if (loadError !== null || metrics === null) {
      return done(customer, probedAt, start, loadError ?? { kind: 'error', message: 'no metrics' });
    }

    if (isDeviceMissing(metrics, ids.deviceId)) {
      return done(customer, probedAt, start, {
        kind: 'misconfigured',
        message: `deviceId "${ids.deviceId}" not present in Securepoint metrics — typo in customer.yaml?`,
      });
    }

    const status = mapSecurepoint(metrics, ids.deviceId);
    return done<SecurepointStatus>(customer, probedAt, start, { kind: 'ok', data: status });
  }

  private async fetchMetrics(apiKey: string): Promise<PrometheusMap> {
    const url = `${this.baseUrl}${METRICS_PATH}?version=${encodeURIComponent(this.apiVersion)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'text/plain',
          },
          signal: ctrl.signal,
        });
      } catch (err) {
        throw classifyThrown(err);
      }
      if (!response.ok) {
        throw classifyHttpStatus(response.status, response.headers.get('retry-after'));
      }
      const text = await response.text();
      return parsePrometheus(text);
    } finally {
      clearTimeout(timer);
    }
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function done<T>(
  customer: CustomerRecord,
  probedAt: string,
  start: number,
  result: BridgeResult<T>,
): BridgeProbe<T> {
  return {
    bridgeKind: 'securepoint',
    customerSlug: customer.slug,
    probedAt,
    durationMs: Date.now() - start,
    result,
  };
}
