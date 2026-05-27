/**
 * Tenant-isolation domain — workspace-derived tenant resolution +
 * guards for cross-tenant access (Phase 6 foundation per ADR-0027).
 *
 * @module @domains/tenant
 */

export {
  type AssertActiveTenantOpts,
  assertActiveTenant,
  assertNoActiveTenant,
} from './guard.js';
export { resolveTenantContext } from './resolve.js';
export { resolveTenantFromToken, tokenToTenantId } from './resolve-token.js';
export {
  CrossTenantAccessError,
  NoTenantContextError,
  type ServerTenantContext,
  type TenantContext,
  TenantError,
} from './types.js';
