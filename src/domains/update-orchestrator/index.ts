/**
 * Update-orchestrator domain — Phase 4 (ADR-0005).
 *
 * @module @domains/update-orchestrator
 */

export {
  type BackupEntry,
  BackupManager,
  backupPathFor,
  backupsDirFor,
} from './backup-manager.js';
export { type DiffStatus, type DiffSummary, diffFiles } from './diff-engine.js';
export { updateEnvRepo } from './env-repo.js';
export { PLUGINS_V1_HINT, pluginUpdateLogPath, updatePlugins } from './plugins.js';
export {
  type ChecklistSnapshot,
  type ChecklistStatus,
  ResumableChecklist,
} from './resumable-checklist.js';
export {
  type FileToReview,
  type ReviewDecision,
  type ReviewLoopOpts,
  type ReviewLoopResult,
  type ReviewOutcome,
  runReviewLoop,
} from './review-loop.js';
export { updateSkillsRepo } from './skills-repo.js';
export type { UpdateResult, UpdateScope, UpdateState } from './types.js';
export {
  type Classification,
  type Zone,
  ZoneClassifier,
} from './zone-classifier.js';
