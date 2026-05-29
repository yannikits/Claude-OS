/**
 * Securepoint USC Read-Bridge — public surface.
 *
 * Wiring (typically in serve()-bootstrap):
 *
 *   const sp = new SecurepointBridge({
 *     getApiKey: () => secrets.get('securepoint/apiKey'),
 *     ...(process.env.CLAUDE_OS_SECUREPOINT_BASE_URL
 *       ? { baseUrl: process.env.CLAUDE_OS_SECUREPOINT_BASE_URL }
 *       : {}),
 *   });
 *   registry.register(withAuditTrail(sp, auditLogger));
 *
 * @module @domains/msp-bridges/securepoint
 */
export { SecurepointBridge } from './bridge.js';
export { classifyHttpStatus, classifyThrown } from './classify-error.js';
export { isDeviceMissing, mapSecurepoint } from './mapper.js';
export { SecurepointMetricsCache } from './metrics-cache.js';
export {
  deviceAppearsInMetrics,
  findSamplesForDevice,
  parsePrometheus,
} from './prom-parser.js';
export type {
  MetricsSample,
  PrometheusMap,
  SecurepointBridgeConfig,
  SecurepointLicenseStatus,
  SecurepointStatus,
} from './types.js';
