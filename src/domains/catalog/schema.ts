/**
 * Schemas for the on-disk catalog state — closes the "catalog.json /
 * catalog.lock.json Schema + Validator deferred" item from the Phase 5
 * v1-Abweichungen list.
 *
 * Per ADR-0012 schemas live next to their domain when they're not
 * cross-cutting. catalog.json describes what the user wants installed;
 * catalog.lock.json is the resolver-produced snapshot a sidecar can
 * apply deterministically.
 *
 * Both carry a top-level `version: 1` literal as the migration anchor.
 *
 * @module @domains/catalog/schema
 */
import { type Static, Type } from '@sinclair/typebox';

const ISO_8601_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+\\-]\\d{2}:\\d{2})$';

/** Catalog entry kind — mirrors ADR-0009 §31. */
export const CatalogEntryKindSchema = Type.Union([
  Type.Literal('skill'),
  Type.Literal('plugin'),
  Type.Literal('mcp'),
]);

/** Where the entry lives in the layered configuration. */
export const CatalogScopeSchema = Type.Union([Type.Literal('user'), Type.Literal('project')]);

/**
 * Stable identifier accepted in catalog.json and lock entries.
 * Same alphabet as MarketplaceRegistry name/plugin (kebab-case +
 * dots + underscores).
 */
const IdSchema = Type.String({ pattern: '^[A-Za-z0-9._-]+$', minLength: 1, maxLength: 256 });

/**
 * Source string — re-validated by parseSource() at runtime; the schema
 * enforces only basic shape so a typo in the prefix is caught early.
 */
const SourceSchema = Type.String({
  pattern: '^(marketplace|github|local):.+$',
  maxLength: 1024,
});

/** sha256 hex (lowercase, 64 chars). */
const Sha256Schema = Type.String({ pattern: '^[a-f0-9]{64}$' });

// ---------- catalog.json ----------

export const CatalogEntrySchema = Type.Object(
  {
    id: IdSchema,
    kind: CatalogEntryKindSchema,
    source: SourceSchema,
    enabled: Type.Boolean(),
    scope: CatalogScopeSchema,
  },
  { additionalProperties: false },
);

export const CatalogConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    entries: Type.Array(CatalogEntrySchema, { maxItems: 1024 }),
  },
  { additionalProperties: false },
);

export type CatalogEntry = Static<typeof CatalogEntrySchema>;
export type CatalogConfig = Static<typeof CatalogConfigSchema>;

// ---------- catalog.lock.json ----------

/** One capability binding the resolver picked during the last solve. */
export const CatalogLockBindingSchema = Type.Object(
  {
    capability: Type.String({ minLength: 1, maxLength: 512 }),
    providedBy: IdSchema,
  },
  { additionalProperties: false },
);

export const CatalogLockEntrySchema = Type.Object(
  {
    id: IdSchema,
    source: SourceSchema,
    sha256: Sha256Schema,
    /** The git ref the github-tarball was fetched at, or "HEAD". */
    resolvedRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    bindings: Type.Array(CatalogLockBindingSchema, { maxItems: 512 }),
  },
  { additionalProperties: false },
);

export const CatalogLockSchema = Type.Object(
  {
    version: Type.Literal(1),
    resolvedAt: Type.String({ pattern: ISO_8601_PATTERN }),
    entries: Type.Array(CatalogLockEntrySchema, { maxItems: 1024 }),
  },
  { additionalProperties: false },
);

export type CatalogLockBinding = Static<typeof CatalogLockBindingSchema>;
export type CatalogLockEntry = Static<typeof CatalogLockEntrySchema>;
export type CatalogLock = Static<typeof CatalogLockSchema>;

// ---------- Strict JSON-Schema exports (per ADR-0012) ----------

export const CatalogConfigJsonSchema: Record<string, unknown> = JSON.parse(
  JSON.stringify(CatalogConfigSchema),
);

export const CatalogLockJsonSchema: Record<string, unknown> = JSON.parse(
  JSON.stringify(CatalogLockSchema),
);
