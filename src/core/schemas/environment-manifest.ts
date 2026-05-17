/**
 * Schema for the `.claude-os-root` marker-file payload.
 *
 * Per ADR-0002 the marker file identifies a directory as a claude-os
 * root. v1 of root-resolver only checks for the file's existence; this
 * schema is the forward-compatible structured payload for future writes
 * (machine-fingerprint, provenance, owner notes). Readers stay tolerant
 * of an empty/legacy marker — only structured writes go through this
 * schema.
 *
 * Per ADR-0012:
 *   - TypeBox is the single-source-of-truth for runtime validation +
 *     TS-type-inference + JSON-Schema-Draft-2020-12 export.
 *   - Strict export (Type.Strict) is the format consumed by external
 *     tooling (MCP-bundles v1.1, doctor-schema-drift checks).
 *   - Top-level `version: 1` literal anchors the migration boundary.
 *
 * @module @core/schemas/environment-manifest
 */
import { type Static, Type } from '@sinclair/typebox';

const ISO_8601_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+\\-]\\d{2}:\\d{2})$';

export const CloudProviderSchema = Type.Union([
  Type.Literal('onedrive'),
  Type.Literal('gdrive'),
  Type.Literal('dropbox'),
  Type.Literal('rclone'),
  Type.Literal('icloud'),
  Type.Literal('local'),
  Type.Literal('unknown'),
]);

export const EnvironmentManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    createdAt: Type.String({ pattern: ISO_8601_PATTERN }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    cloudProvider: Type.Optional(CloudProviderSchema),
    notes: Type.Optional(Type.String({ maxLength: 4096 })),
  },
  { additionalProperties: false },
);

export type EnvironmentManifest = Static<typeof EnvironmentManifestSchema>;

/**
 * Plain JSON-Schema-Draft-2020-12 export of the manifest schema.
 *
 * TypeBox 0.34 removed the `Type.Strict()` helper because schema
 * objects are already JSON-Schema-compatible; the only addition is
 * `Symbol`-keyed metadata for the internal type-system. `JSON.parse(
 * JSON.stringify(...))` is the canonical strip: `JSON.stringify` drops
 * symbol-keyed properties per ES2020 spec, leaving a clean spec
 * payload consumable by Ajv, jsonschema, or mcp-tools. Snapshot tests
 * in v1.1 will lock the shape for the MCP-bundle pipeline.
 */
export const EnvironmentManifestJsonSchema: Record<string, unknown> = JSON.parse(
  JSON.stringify(EnvironmentManifestSchema),
);
