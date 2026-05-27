/**
 * Skill-Lifecycle Sandbox — Phase 5 Gate 1 (ADR-0026 §"Sandbox" +
 * ADR-0034).
 *
 * Foundation-spike: process-boundary via `child_process.fork`, 30s
 * hard-timeout, path-validation as defense-in-depth. fs/net-API
 * patching inside the child is deferred to Phase-5b.
 *
 * @module @domains/skill-lifecycle/sandbox
 */

export {
  hostAllowed,
  type InstalledNetGuard,
  installNetGuard,
  NetGuardError,
} from './net-guard.js';
export {
  assertSkillScriptUnderRoot,
  assertValidSandboxRoot,
  assertValidSkillId,
} from './path-guard.js';
export { runSkillInSandbox } from './runner.js';
export {
  DEFAULT_TIMEOUT_MS,
  SandboxError,
  type SandboxIpcRequest,
  type SandboxIpcResponse,
  type SandboxOpts,
  type SandboxRunError,
  type SandboxRunInput,
  type SandboxRunOk,
  type SandboxRunResult,
  type SandboxRunTimeout,
} from './types.js';
