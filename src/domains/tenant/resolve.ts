/**
 * Resolves the tenant-context from a workspace id (Phase 6 foundation).
 *
 * Pure function — no FS, no env, no side effects. Bridge-callers can
 * dependency-inject any workspace-id and get back a `TenantContext`.
 *
 * @module @domains/tenant/resolve
 */
import type { TenantContext } from './types.js';

const MSP_CUSTOMER_PREFIX = 'msp-customers/';

/**
 * Returns the tenant-context for a workspace id. `tenant` is set only
 * when the workspace starts with `msp-customers/`; otherwise `null`.
 */
export function resolveTenantContext(workspaceId: string): TenantContext {
  if (workspaceId.startsWith(MSP_CUSTOMER_PREFIX)) {
    const tenant = workspaceId.slice(MSP_CUSTOMER_PREFIX.length);
    if (tenant.length > 0) {
      return { workspace: workspaceId, tenant };
    }
  }
  return { workspace: workspaceId, tenant: null };
}
