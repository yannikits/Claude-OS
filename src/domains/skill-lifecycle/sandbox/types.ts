/**
 * Skill-Sandbox types — Phase 5 Gate 1 per ADR-0026 §"Sandbox".
 *
 * Option B (child_process.fork) — siehe ADR-0034.
 *
 * @module @domains/skill-lifecycle/sandbox/types
 */

export interface SandboxRunInput {
  /**
   * Absolute path to the skill's worker-script (e.g.
   * `<vault>/Claude-OS/workspaces/_sandbox/<skill-id>/script.mjs`).
   * Path is validated against `sandboxRoot` before fork — out-of-root
   * paths are rejected (Codex hardening: defense-in-depth, NOT
   * OS-enforced on Windows).
   */
  readonly skillScriptPath: string;
  /**
   * Skill-id for audit-log correlation. Bare alnum + `-`/`_` only —
   * prevents shell-metachar leakage when the path ends up in error
   * messages.
   */
  readonly skillId: string;
  /** Serializable input passed to the skill via IPC. */
  readonly input: unknown;
}

export interface SandboxOpts {
  /**
   * Absolute sandbox root — only paths under here are allowed for
   * skill scripts. Out-of-root → rejected before fork.
   */
  readonly sandboxRoot: string;
  /**
   * Per-call timeout in milliseconds. ADR-0026 §"Sandbox" specifies
   * 30s default. Hard-kill on overshoot.
   */
  readonly timeoutMs?: number;
  /**
   * Hostname-Allowlist for outbound network. Default `[]` — no net.
   * NOTE: Foundation-spike documents this; actual `fetch`/`net`
   * patching is deferred to Phase-5b.
   */
  readonly netAllowlist?: readonly string[];
  /**
   * Override worker-entry path for tests. Default resolves to the
   * canonical `worker-entry.js` next to this module.
   */
  readonly workerEntry?: string;
  /**
   * Logger sink — defaults to silent. Tests inject to verify
   * lifecycle events.
   */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface SandboxRunOk {
  readonly status: 'ok';
  readonly skillId: string;
  readonly output: unknown;
  readonly durationMs: number;
  readonly killedBy: null;
}

export interface SandboxRunTimeout {
  readonly status: 'timeout';
  readonly skillId: string;
  readonly output: null;
  readonly durationMs: number;
  readonly killedBy: 'timeout';
}

export interface SandboxRunError {
  readonly status: 'error';
  readonly skillId: string;
  readonly output: null;
  readonly durationMs: number;
  /** Error message from the child or from spawn-failure. */
  readonly errorMessage: string;
  readonly killedBy: 'crash' | 'spawn-failure' | 'invalid-path';
}

export type SandboxRunResult = SandboxRunOk | SandboxRunTimeout | SandboxRunError;

export class SandboxError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid-path'
      | 'invalid-skill-id'
      | 'invalid-sandbox-root'
      | 'spawn-failure',
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Wire-format for parent→child IPC. Both sides agree on this shape.
 * Open-ended `params` matches the skill's `run(input)` contract.
 */
export interface SandboxIpcRequest {
  readonly kind: 'run';
  readonly skillId: string;
  readonly skillScriptPath: string;
  readonly input: unknown;
}

export type SandboxIpcResponse =
  | { kind: 'ok'; output: unknown }
  | { kind: 'error'; message: string };
