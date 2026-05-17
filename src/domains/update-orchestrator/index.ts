/**
 * Update-orchestrator domain — Phase 4 (ADR-0005).
 *
 * @module @domains/update-orchestrator
 */
export type { UpdateResult, UpdateScope, UpdateState } from './types.js';
export { updateEnvRepo } from './env-repo.js';
export { updateSkillsRepo } from './skills-repo.js';
export {
  BackupManager,
  backupsDirFor,
  backupPathFor,
  type BackupEntry,
} from './backup-manager.js';
export {
  ZoneClassifier,
  type Classification,
  type Zone,
} from './zone-classifier.js';
