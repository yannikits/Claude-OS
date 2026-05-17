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
export { diffFiles, type DiffStatus, type DiffSummary } from './diff-engine.js';
export {
  runReviewLoop,
  type FileToReview,
  type ReviewDecision,
  type ReviewLoopOpts,
  type ReviewLoopResult,
  type ReviewOutcome,
} from './review-loop.js';
export {
  ResumableChecklist,
  type ChecklistSnapshot,
  type ChecklistStatus,
} from './resumable-checklist.js';
export { updatePlugins, pluginUpdateLogPath, PLUGINS_V1_HINT } from './plugins.js';
