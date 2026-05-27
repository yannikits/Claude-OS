/**
 * Path-Validation für Sandbox-Skills (Codex Stage-2 hardening:
 * documented defense-in-depth, NOT OS-enforced).
 *
 * Use-Case: bevor wir ein `skillScriptPath` an `child_process.fork()`
 * geben, prüfen wir dass der Pfad
 *   (a) absolut ist
 *   (b) unter `sandboxRoot` liegt (kein `..`-Traversal nach oben)
 *   (c) keine NUL/Path-Separator-Tricks enthält
 *
 * Windows-Caveat (per ADR-0034 / three-brain Plan §"Sandbox auf
 * Windows"): es gibt KEIN `chroot`. Wenn jemand auf Windows ein
 * `\\?\C:\...`-UNC-Pfad oder einen Junction-Link nutzt, kann er aus
 * dem Sandbox-Root "ausbrechen". Diese Funktion ist defense-in-depth
 * gegen versehentliche Code-Bugs in Skill-Authors, NICHT gegen
 * malicious actors mit Windows-FS-Wissen. Sicherheits-Boundary auf
 * Windows liegt bei der Process-Boundary + 30s-Timeout, nicht beim
 * Pfad-Check.
 *
 * @module @domains/skill-lifecycle/sandbox/path-guard
 */
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { SandboxError } from './types.js';

const ILLEGAL_SKILL_ID = /[^A-Za-z0-9_-]/;
const MAX_SKILL_ID_LENGTH = 64;

/**
 * Validates a skill-id. Bare alnum + `-`/`_` only — prevents
 * shell-metachar leakage when the id ends up in error messages or
 * audit-log paths.
 */
export function assertValidSkillId(skillId: string): void {
  if (skillId.length === 0) {
    throw new SandboxError('skill-id must not be empty', 'invalid-skill-id');
  }
  if (skillId.length > MAX_SKILL_ID_LENGTH) {
    throw new SandboxError(
      `skill-id "${skillId}" too long (max ${MAX_SKILL_ID_LENGTH})`,
      'invalid-skill-id',
    );
  }
  if (ILLEGAL_SKILL_ID.test(skillId)) {
    throw new SandboxError(
      `skill-id "${skillId}" contains illegal characters (allowed: [A-Za-z0-9_-])`,
      'invalid-skill-id',
    );
  }
}

/**
 * Validates a sandbox-root path. Must be absolute. We do not check
 * existence here — that's the caller's responsibility (would couple
 * the validator to FS).
 */
export function assertValidSandboxRoot(sandboxRoot: string): void {
  if (sandboxRoot.length === 0) {
    throw new SandboxError('sandbox-root must not be empty', 'invalid-sandbox-root');
  }
  if (!isAbsolute(sandboxRoot)) {
    throw new SandboxError(
      `sandbox-root "${sandboxRoot}" must be absolute`,
      'invalid-sandbox-root',
    );
  }
}

/**
 * Validates a skill-script path against the sandbox-root.
 *
 * Steps:
 *   1. Absolute path required
 *   2. No NUL bytes
 *   3. Normalize away `..`/`.` sequences
 *   4. `relative(sandboxRoot, normalized)` must NOT start with `..`
 *      or be absolute — that would mean the normalized path is
 *      outside the root
 *
 * Throws `SandboxError('invalid-path')` on any violation.
 */
export function assertSkillScriptUnderRoot(skillScriptPath: string, sandboxRoot: string): string {
  if (skillScriptPath.length === 0) {
    throw new SandboxError('skill-script path must not be empty', 'invalid-path');
  }
  if (skillScriptPath.includes('\0')) {
    throw new SandboxError('skill-script path contains NUL byte', 'invalid-path');
  }
  if (!isAbsolute(skillScriptPath)) {
    throw new SandboxError(
      `skill-script path "${skillScriptPath}" must be absolute`,
      'invalid-path',
    );
  }
  const normalizedScript = normalize(resolve(skillScriptPath));
  const normalizedRoot = normalize(resolve(sandboxRoot));
  const rel = relative(normalizedRoot, normalizedScript);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new SandboxError(
      `skill-script path "${skillScriptPath}" is outside sandbox-root "${sandboxRoot}"`,
      'invalid-path',
    );
  }
  return normalizedScript;
}
