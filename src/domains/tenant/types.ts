/**
 * Tenant-isolation domain types (Phase 6 foundation per ADR-0027 §
 * "Tenant-Isolation" + ADR-0031).
 *
 * The "tenant" concept is derived from the active workspace:
 *   - workspace `msp-customers/<id>` → tenant = `<id>`
 *   - any other workspace            → tenant = null (no tenant context)
 *
 * Bridge-calls in `claude-os-msp` MUST verify that the workspace's
 * tenant matches the customer they're about to touch. The
 * `assertActiveTenant` helper centralises that check.
 *
 * @module @domains/tenant/types
 */

export interface TenantContext {
  readonly workspace: string;
  /** Customer-id when active workspace is `msp-customers/<id>`. */
  readonly tenant: string | null;
}

export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantError';
  }
}

export class CrossTenantAccessError extends TenantError {
  constructor(activeTenant: string | null, requestedTenant: string, actionLabel: string) {
    super(
      `Cross-tenant access blocked for "${actionLabel}": active workspace tenant is ` +
        `${activeTenant === null ? '<none>' : `"${activeTenant}"`}, ` +
        `but the call targets tenant "${requestedTenant}". ` +
        'Switch the active workspace first (claude-os workspace use msp-customers/' +
        `${requestedTenant}).`,
    );
    this.name = 'CrossTenantAccessError';
  }
}

export class NoTenantContextError extends TenantError {
  constructor(actionLabel: string) {
    super(
      `"${actionLabel}" requires a customer tenant but the active workspace ` +
        'is not `msp-customers/<id>`. Switch the workspace via ' +
        '`claude-os workspace use msp-customers/<id>`.',
    );
    this.name = 'NoTenantContextError';
  }
}
