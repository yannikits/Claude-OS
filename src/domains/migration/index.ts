/**
 * Migration-Domain — `claude-os migrate --from-portable` (Auftrag 1c v1.5).
 *
 * @module @domains/migration
 */
export { type CopyTreeOpts, type CopyTreeStats, copyTree } from './copy-tree.js';
export { discoverPortable } from './portable-discovery.js';
export {
  type BuildPlanOpts,
  buildMigrationPlan,
  type ExecutePlanOpts,
  executePlan,
} from './runner.js';
export { type EnvScanResult, scanEnvFiles } from './secrets-collector.js';
export {
  type CollectSecretsStep,
  type CopyTreeStep,
  type MigrateGitMetadataStep,
  MigrationError,
  type MigrationPlan,
  type MigrationResult,
  type PlanStep,
  type PortableSource,
  type StepResult,
} from './types.js';
