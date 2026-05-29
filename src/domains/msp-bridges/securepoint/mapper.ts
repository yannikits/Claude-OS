/**
 * Pure mapper — `PrometheusMap` + deviceId → `SecurepointStatus`.
 *
 * Surfaces the two operator-relevant signals plus a bounded list of
 * other matched `utm_*` metrics for diagnostics drill-down.
 *
 * @module @domains/msp-bridges/securepoint/mapper
 */
import { deviceAppearsInMetrics, findSamplesForDevice } from './prom-parser.js';
import type {
  MetricsSample,
  PrometheusMap,
  SecurepointLicenseStatus,
  SecurepointStatus,
} from './types.js';

const ONLINE_METRIC = 'utm_usc_online_status';
const LICENSE_METRIC = 'utm_license_days_valid';
const MAX_ADDITIONAL = 20;

function bucketLicense(days: number | null): SecurepointLicenseStatus {
  if (days === null) return 'unknown';
  if (days <= 0) return 'expired';
  if (days <= 30) return 'expiring-soon';
  return 'valid';
}

function firstFinite(samples: readonly MetricsSample[]): number | null {
  for (const s of samples) {
    if (Number.isFinite(s.value)) return s.value;
  }
  return null;
}

export function mapSecurepoint(metrics: PrometheusMap, deviceId: string): SecurepointStatus {
  const onlineSamples = findSamplesForDevice(metrics, ONLINE_METRIC, deviceId);
  const onlineValue = firstFinite(onlineSamples);
  const online = onlineValue === 1;

  const licenseSamples = findSamplesForDevice(metrics, LICENSE_METRIC, deviceId);
  const licenseDaysRemaining = firstFinite(licenseSamples);

  // Collect OTHER utm_* metrics matched by this device for diagnostics.
  const additional: { name: string; value: number }[] = [];
  for (const name of metrics.keys()) {
    if (name === ONLINE_METRIC || name === LICENSE_METRIC) continue;
    if (!name.startsWith('utm_')) continue;
    const matched = findSamplesForDevice(metrics, name, deviceId);
    for (const s of matched) {
      if (Number.isFinite(s.value)) {
        additional.push({ name, value: s.value });
        if (additional.length >= MAX_ADDITIONAL) break;
      }
    }
    if (additional.length >= MAX_ADDITIONAL) break;
  }

  return {
    online,
    licenseDaysRemaining,
    licenseStatus: bucketLicense(licenseDaysRemaining),
    deviceId,
    additionalMetrics: additional,
  };
}

/** True iff the deviceId is missing from the entire metrics-map. */
export function isDeviceMissing(metrics: PrometheusMap, deviceId: string): boolean {
  return !deviceAppearsInMetrics(metrics, deviceId);
}
