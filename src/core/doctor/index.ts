/**
 * Doctor domain — public API.
 *
 * @module @core/doctor
 */
export { runDoctor } from './runner.js';
export {
  checkNodeVersion,
  checkGitAvailable,
  checkClaudeBinary,
  checkMountReachable,
  checkWritePermission,
  checkWindowsLongPaths,
} from './checks.js';
export type { CheckResult, DoctorReport, CheckSeverity, CheckFn } from './types.js';
