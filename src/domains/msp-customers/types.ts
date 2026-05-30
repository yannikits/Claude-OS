/**
 * MSP-Customers — typed customer records (Phase 7-A).
 *
 * Customer-Stammdaten + bridge-IDs liegen pro Customer-Workspace unter
 * `<vault>/workspaces/msp-customers/<slug>/customer.yaml`. Schema ist
 * forward-compatible (unknown top-level keys werden gelesen + preserved).
 *
 * **WICHTIG:** API-Tokens für Bridges (TANSS/Veeam/Sophos/…) landen
 * NICHT hier — die kommen aus dem secrets-Backend unter dem
 * Secret-Key-Pattern `bridge:<kind>:<customer-slug>:api-token`. Diese
 * YAML enthält nur **Identifier** (Customer-IDs, Hostnames, Job-Namen).
 *
 * @module @domains/msp-customers/types
 */

export const CUSTOMER_SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;
export const CUSTOMER_SLUG_MAX_LEN = 64;

/**
 * Discriminated bridge-ids per kind. All optional — a customer that
 * isn't on a given bridge simply omits the section. Aggregat-Layer
 * (Phase 7-E) shows `n/a` for missing kinds.
 */
export interface TanssBridgeIds {
  /** Numeric TANSS customer-id. */
  readonly customerId: number;
}

export interface VeeamBridgeIds {
  /**
   * Hostname / IP of the per-customer Veeam Backup & Replication
   * Server. Required since v1.8.3 (ADR-0040): claude-os assumes
   * per-customer VBR (each customer has their own backup server,
   * reached via VPN/MPLS), not a single central VBR.
   */
  readonly serverHostname: string;
  /** Veeam REST-API port. Default 9419. */
  readonly serverPort?: number;
  /**
   * Optional Job-Name filter. When empty/undefined: probe returns
   * status of ALL jobs on that VBR. When set: only matching jobs are
   * considered (useful when one VBR hosts multiple customers' jobs).
   */
  readonly jobNames?: readonly string[];
}

export interface SophosBridgeIds {
  /**
   * Hostname / IP of the per-customer Sophos XG/XGS Firewall.
   * Required since v1.9.1 (ADR-0042): claude-os hits the firewall's
   * XML-API directly at port 4444 (default).
   */
  readonly firewallHostname: string;
  /** Sophos XG/XGS XML-API port. Default 4444. */
  readonly firewallPort?: number;
  /**
   * Customer id in Sophos Central (cloud-mgmt). Reserved for a future
   * Central-API bridge; not used by the v1.9.1 firewall-bridge.
   */
  readonly centralCustomerId?: string;
}

export interface SecurepointBridgeIds {
  /** Device-id in the Securepoint cloud-mgmt console. */
  readonly deviceId: string;
}

export interface M365BridgeIds {
  /** Azure-tenant-id (GUID). */
  readonly tenantId: string;
}

export interface NinjaBridgeIds {
  /** Numeric NinjaOne organization-id (maps the customer to a Ninja org). */
  readonly organizationId: number;
}

/** Optional contact + address-Stammdaten for the customer record. */
export interface CustomerContact {
  readonly primaryEmail?: string;
  readonly primaryPhone?: string;
  readonly street?: string;
  readonly zip?: string;
  readonly city?: string;
}

/**
 * The full customer record. Slug + displayName are the only required
 * top-level fields; everything else is optional and may grow over time
 * without breaking the schema (`extras` keeps unknown keys).
 */
export interface CustomerRecord {
  readonly slug: string;
  readonly displayName: string;
  readonly contact?: CustomerContact;
  readonly bridges?: {
    readonly tanss?: TanssBridgeIds;
    readonly veeam?: VeeamBridgeIds;
    readonly sophos?: SophosBridgeIds;
    readonly securepoint?: SecurepointBridgeIds;
    readonly m365?: M365BridgeIds;
    readonly ninja?: NinjaBridgeIds;
  };
  readonly tags?: readonly string[];
  readonly notes?: string;
  /** Forward-compat: any top-level key not in the schema is preserved here. */
  readonly extras?: Record<string, unknown>;
}

export class CustomerSchemaError extends Error {
  constructor(
    public readonly customerSlug: string | null,
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CustomerSchemaError';
  }
}

export class CustomerNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`Customer not found: "${slug}"`);
    this.name = 'CustomerNotFoundError';
  }
}
