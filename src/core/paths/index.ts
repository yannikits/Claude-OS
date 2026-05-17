/**
 * Paths domain — platform-aware per-machine directories (ADR-0002).
 *
 * @module @core/paths
 */

export { externalGitDirFor, resolveMachinePaths } from './machine-paths.js';
export type { MachinePaths } from './types.js';
export { PathsResolutionError } from './types.js';
