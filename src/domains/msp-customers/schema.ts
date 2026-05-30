/**
 * Customer-Schema validation + normalisation.
 *
 * Takes raw YAML-parsed object → returns a fully-typed `CustomerRecord`
 * or throws `CustomerSchemaError` with a precise field-path.
 *
 * Forward-compat: unknown top-level keys are preserved under `extras`
 * rather than rejected — schema can grow without breaking older files.
 *
 * @module @domains/msp-customers/schema
 */
import {
  CUSTOMER_SLUG_MAX_LEN,
  CUSTOMER_SLUG_REGEX,
  type CustomerRecord,
  CustomerSchemaError,
  type M365BridgeIds,
  type NinjaBridgeIds,
  type SecurepointBridgeIds,
  type SophosBridgeIds,
  type TanssBridgeIds,
  type VeeamBridgeIds,
} from './types.js';

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'slug',
  'displayName',
  'contact',
  'bridges',
  'tags',
  'notes',
]);

const KNOWN_BRIDGE_KINDS = new Set(['tanss', 'veeam', 'sophos', 'securepoint', 'm365', 'ninja']);

export interface ValidateOpts {
  /** Override slug from filesystem (yaml's `slug:` field must then match this). */
  readonly expectedSlug?: string;
}

/**
 * Validate + normalise. Mutates nothing; returns a fresh `CustomerRecord`.
 */
export function validateCustomerRecord(raw: unknown, opts: ValidateOpts = {}): CustomerRecord {
  if (typeof raw !== 'object' || raw === null) {
    throw new CustomerSchemaError(null, '<root>', 'customer.yaml must contain a YAML object');
  }
  const v = raw as Record<string, unknown>;

  const slug = readString(v, 'slug', true);
  if (!CUSTOMER_SLUG_REGEX.test(slug)) {
    throw new CustomerSchemaError(slug, 'slug', `slug "${slug}" must match ${CUSTOMER_SLUG_REGEX}`);
  }
  if (slug.length > CUSTOMER_SLUG_MAX_LEN) {
    throw new CustomerSchemaError(
      slug,
      'slug',
      `slug "${slug}" exceeds max length ${CUSTOMER_SLUG_MAX_LEN}`,
    );
  }
  if (opts.expectedSlug !== undefined && opts.expectedSlug !== slug) {
    throw new CustomerSchemaError(
      slug,
      'slug',
      `slug "${slug}" does not match folder name "${opts.expectedSlug}"`,
    );
  }

  const displayName = readString(v, 'displayName', true);
  if (displayName.trim().length === 0) {
    throw new CustomerSchemaError(slug, 'displayName', 'displayName must be non-empty');
  }

  const out: CustomerRecord = {
    slug,
    displayName,
    ...(v.contact !== undefined ? { contact: readContact(v.contact, slug) } : {}),
    ...(v.bridges !== undefined ? { bridges: readBridges(v.bridges, slug) } : {}),
    ...(Array.isArray(v.tags)
      ? { tags: v.tags.filter((t): t is string => typeof t === 'string') }
      : {}),
    ...(typeof v.notes === 'string' ? { notes: v.notes } : {}),
    ...buildExtras(v),
  };
  return out;
}

function buildExtras(v: Record<string, unknown>): { extras?: Record<string, unknown> } {
  const extras: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(k)) extras[k] = val;
  }
  return Object.keys(extras).length > 0 ? { extras } : {};
}

function readString(obj: Record<string, unknown>, key: string, required: boolean): string {
  const v = obj[key];
  if (v === undefined) {
    if (required) throw new CustomerSchemaError(null, key, `${key} is required`);
    return '';
  }
  if (typeof v !== 'string') {
    throw new CustomerSchemaError(null, key, `${key} must be a string`);
  }
  return v;
}

function readContact(raw: unknown, slug: string): CustomerRecord['contact'] {
  if (typeof raw !== 'object' || raw === null) {
    throw new CustomerSchemaError(slug, 'contact', 'contact must be an object');
  }
  const c = raw as Record<string, unknown>;
  const fields: (keyof NonNullable<CustomerRecord['contact']>)[] = [
    'primaryEmail',
    'primaryPhone',
    'street',
    'zip',
    'city',
  ];
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = c[f];
    if (v !== undefined) {
      if (typeof v !== 'string') {
        throw new CustomerSchemaError(slug, `contact.${f}`, `contact.${f} must be a string`);
      }
      out[f] = v;
    }
  }
  return out as CustomerRecord['contact'];
}

function readBridges(raw: unknown, slug: string): NonNullable<CustomerRecord['bridges']> {
  if (typeof raw !== 'object' || raw === null) {
    throw new CustomerSchemaError(slug, 'bridges', 'bridges must be an object');
  }
  const b = raw as Record<string, unknown>;
  // Reject unknown bridge kinds early so typos don't silently disable a bridge.
  for (const k of Object.keys(b)) {
    if (!KNOWN_BRIDGE_KINDS.has(k)) {
      throw new CustomerSchemaError(
        slug,
        `bridges.${k}`,
        `unknown bridge kind "${k}" — expected one of ${[...KNOWN_BRIDGE_KINDS].join(', ')}`,
      );
    }
  }
  return {
    ...(b.tanss !== undefined ? { tanss: readTanss(b.tanss, slug) } : {}),
    ...(b.veeam !== undefined ? { veeam: readVeeam(b.veeam, slug) } : {}),
    ...(b.sophos !== undefined ? { sophos: readSophos(b.sophos, slug) } : {}),
    ...(b.securepoint !== undefined ? { securepoint: readSecurepoint(b.securepoint, slug) } : {}),
    ...(b.m365 !== undefined ? { m365: readM365(b.m365, slug) } : {}),
    ...(b.ninja !== undefined ? { ninja: readNinja(b.ninja, slug) } : {}),
  };
}

function readNinja(raw: unknown, slug: string): NinjaBridgeIds {
  const b = asObject(raw, slug, 'bridges.ninja');
  const organizationId = b.organizationId;
  if (
    typeof organizationId !== 'number' ||
    !Number.isInteger(organizationId) ||
    organizationId <= 0
  ) {
    throw new CustomerSchemaError(
      slug,
      'bridges.ninja.organizationId',
      'bridges.ninja.organizationId must be a positive integer',
    );
  }
  return { organizationId };
}

function readTanss(raw: unknown, slug: string): TanssBridgeIds {
  const b = asObject(raw, slug, 'bridges.tanss');
  const customerId = b.customerId;
  if (typeof customerId !== 'number' || !Number.isInteger(customerId) || customerId <= 0) {
    throw new CustomerSchemaError(
      slug,
      'bridges.tanss.customerId',
      'bridges.tanss.customerId must be a positive integer',
    );
  }
  return { customerId };
}

function readVeeam(raw: unknown, slug: string): VeeamBridgeIds {
  const b = asObject(raw, slug, 'bridges.veeam');
  if (typeof b.serverHostname !== 'string' || b.serverHostname.trim().length === 0) {
    throw new CustomerSchemaError(
      slug,
      'bridges.veeam.serverHostname',
      'bridges.veeam.serverHostname is required (per-customer VBR; ADR-0040)',
    );
  }
  let serverPort: number | undefined;
  if (b.serverPort !== undefined) {
    if (
      typeof b.serverPort !== 'number' ||
      !Number.isInteger(b.serverPort) ||
      b.serverPort <= 0 ||
      b.serverPort > 65535
    ) {
      throw new CustomerSchemaError(
        slug,
        'bridges.veeam.serverPort',
        'bridges.veeam.serverPort must be an integer in 1..65535',
      );
    }
    serverPort = b.serverPort;
  }
  let jobNames: readonly string[] | undefined;
  if (b.jobNames !== undefined) {
    if (!Array.isArray(b.jobNames)) {
      throw new CustomerSchemaError(
        slug,
        'bridges.veeam.jobNames',
        'bridges.veeam.jobNames must be an array of strings (or omitted to match all jobs)',
      );
    }
    jobNames = b.jobNames.filter((n): n is string => typeof n === 'string');
  }
  return {
    serverHostname: b.serverHostname,
    ...(serverPort !== undefined ? { serverPort } : {}),
    ...(jobNames !== undefined ? { jobNames } : {}),
  };
}

function readSophos(raw: unknown, slug: string): SophosBridgeIds {
  const b = asObject(raw, slug, 'bridges.sophos');
  if (typeof b.firewallHostname !== 'string' || b.firewallHostname.trim().length === 0) {
    throw new CustomerSchemaError(
      slug,
      'bridges.sophos.firewallHostname',
      'bridges.sophos.firewallHostname is required (per-customer firewall; ADR-0042)',
    );
  }
  let firewallPort: number | undefined;
  if (b.firewallPort !== undefined) {
    if (
      typeof b.firewallPort !== 'number' ||
      !Number.isInteger(b.firewallPort) ||
      b.firewallPort <= 0 ||
      b.firewallPort > 65535
    ) {
      throw new CustomerSchemaError(
        slug,
        'bridges.sophos.firewallPort',
        'bridges.sophos.firewallPort must be an integer in 1..65535',
      );
    }
    firewallPort = b.firewallPort;
  }
  const centralCustomerId =
    typeof b.centralCustomerId === 'string' ? b.centralCustomerId : undefined;
  return {
    firewallHostname: b.firewallHostname,
    ...(firewallPort !== undefined ? { firewallPort } : {}),
    ...(centralCustomerId !== undefined ? { centralCustomerId } : {}),
  };
}

function readSecurepoint(raw: unknown, slug: string): SecurepointBridgeIds {
  const b = asObject(raw, slug, 'bridges.securepoint');
  if (typeof b.deviceId !== 'string' || b.deviceId.length === 0) {
    throw new CustomerSchemaError(
      slug,
      'bridges.securepoint.deviceId',
      'bridges.securepoint.deviceId must be a non-empty string',
    );
  }
  return { deviceId: b.deviceId };
}

function readM365(raw: unknown, slug: string): M365BridgeIds {
  const b = asObject(raw, slug, 'bridges.m365');
  if (typeof b.tenantId !== 'string' || b.tenantId.length === 0) {
    throw new CustomerSchemaError(
      slug,
      'bridges.m365.tenantId',
      'bridges.m365.tenantId must be a non-empty string',
    );
  }
  return { tenantId: b.tenantId };
}

function asObject(raw: unknown, slug: string, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw new CustomerSchemaError(slug, field, `${field} must be an object`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Build a fresh default record for a customer-workspace that exists on
 * disk but has no `customer.yaml` yet. Operator-Aktion later: fill in
 * displayName, bridge-ids, contact via direct yaml-edit.
 */
export function defaultRecord(slug: string): CustomerRecord {
  return { slug, displayName: slug };
}
