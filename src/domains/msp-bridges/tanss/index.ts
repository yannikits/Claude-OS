/**
 * TANSS Read-Bridge — public surface.
 *
 * Wiring (typically in `serve`-bootstrap):
 *
 *   const tanss = new TanssBridge({
 *     serverUrl: process.env.CLAUDE_OS_TANSS_SERVER_URL!,
 *     getApiToken: () => secretsStore.get('tanss/apiToken'),
 *   });
 *   registry.register(withAuditTrail(tanss, auditLogger));
 *
 * @module @domains/msp-bridges/tanss
 */
export { TanssBridge } from './bridge.js';
export { classifyHttpStatus, classifyThrown } from './classify-error.js';
export { createTanssHttpClient, type TanssHttpClient } from './http-client.js';
export { isClosed, mapTanssTickets } from './mapper.js';
export type {
  TanssBridgeConfig,
  TanssStatus,
  TanssTicketRaw,
  TanssTicketSample,
} from './types.js';
