/**
 * NinjaOne Read-Bridge — public surface.
 *
 * Wiring (typically in `serve`-bootstrap):
 *
 *   const ninja = new NinjaBridge({
 *     baseUrl: process.env.CLAUDE_OS_NINJA_BASE_URL ?? 'https://eu.ninjarmm.com',
 *     getCredentials: async () => ({
 *       clientId: (await secrets.get('ninja/clientId')) ?? '',
 *       clientSecret: (await secrets.get('ninja/clientSecret')) ?? '',
 *     }),
 *   });
 *   registry.register(withAuditTrail(ninja, auditLogger));
 *
 * @module @domains/msp-bridges/ninja
 */
export { NinjaBridge } from './bridge.js';
export type {
  NinjaAlertRaw,
  NinjaBridgeConfig,
  NinjaCredentials,
  NinjaCredentialsResolver,
  NinjaDeviceRaw,
  NinjaStatus,
} from './types.js';
