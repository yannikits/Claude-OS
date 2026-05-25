/**
 * Tenant-isolation guards (Phase 6 foundation per ADR-0027 §
 * "Tenant-Isolation"). Bridge-callers wrap any customer-touching
 * operation in `assertActiveTenant(...)` to fail-loud when the
 * active workspace doesn't match the customer they're trying to
 * touch.
 *
 * @module @domains/tenant/guard
 */
import { resolveTenantContext } from './resolve.js';
import { CrossTenantAccessError, NoTenantContextError, type TenantContext } from './types.js';

export interface AssertActiveTenantOpts {
  /** Active workspace id (from `workspace.current` / active state). */
  readonly activeWorkspace: string;
  /** Customer-id the bridge-call is about to touch. */
  readonly requestedTenant: string;
  /** Short label for the error / audit-trail ("tanss.tickets.list", ...). */
  readonly actionLabel: string;
}

/**
 * Throws `NoTenantContextError` if active workspace is not `msp-customers/*`.
 * Throws `CrossTenantAccessError` if active tenant != requestedTenant.
 * Returns the `TenantContext` on success.
 */
export function assertActiveTenant(opts: AssertActiveTenantOpts): TenantContext {
  const ctx = resolveTenantContext(opts.activeWorkspace);
  if (ctx.tenant === null) {
    throw new NoTenantContextError(opts.actionLabel);
  }
  if (ctx.tenant !== opts.requestedTenant) {
    throw new CrossTenantAccessError(ctx.tenant, opts.requestedTenant, opts.actionLabel);
  }
  return ctx;
}

/**
 * Lighter-weight guard for tenant-free contexts (e.g. firmen-interne
 * Read-Calls die NICHT customer-specific sind). Refuses when ANY
 * customer tenant is active — protects against accidentally hitting
 * a customer-API while in their workspace.
 *
 * Throws `CrossTenantAccessError` (with `requestedTenant = '<none>'`)
 * if the active workspace has a tenant.
 */
export function assertNoActiveTenant(opts: {
  activeWorkspace: string;
  actionLabel: string;
}): TenantContext {
  const ctx = resolveTenantContext(opts.activeWorkspace);
  if (ctx.tenant !== null) {
    throw new CrossTenantAccessError(ctx.tenant, '<none>', opts.actionLabel);
  }
  return ctx;
}
