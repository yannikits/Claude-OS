/**
 * Schema barrel — re-exports all `@core/schemas/*` TypeBox schemas
 * per ADR-0012 §"Constraints" ("ALLE Schema-Definitionen liegen in
 * src/core/schemas/").
 *
 * @module @core/schemas
 */
export {
  CloudProviderSchema,
  type EnvironmentManifest,
  EnvironmentManifestJsonSchema,
  EnvironmentManifestSchema,
} from './environment-manifest.js';
