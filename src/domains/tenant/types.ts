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

/**
 * Server-mode extension of `TenantContext` (Phase Web-5 / ADR-0033).
 * Adds the deterministic token-derived tenant-id used for per-token
 * data isolation and audit-log subject tagging. Undefined in Tauri-mode
 * (no bearer token there).
 */
export interface ServerTenantContext extends TenantContext {
  /**
   * Stable 12-hex prefix of SHA-256(token). Survives container restarts
   * — same token always resolves to the same id. Used as audit-log
   * subject and (Phase Web-5b) per-token workspace key.
   */
  readonly tokenTenantId?: string;
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
