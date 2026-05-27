/**
 * Doctor domain — public API.
 *
 * @module @core/doctor
 */

export {
  checkClaudeBinary,
  checkGitAvailable,
  checkMountReachable,
  checkNodeVersion,
  checkServerEnv,
  checkWindowsLongPaths,
  checkWritePermission,
} from './checks.js';
export { runDoctor } from './runner.js';
export type { CheckFn, CheckResult, CheckSeverity, DoctorReport } from './types.js';
