/**
 * claude-bridge domain types (Phase 3b).
 *
 * Bridges the claude-os CLI to the Anthropic `bin/claude{,.exe}` binary
 * via streaming child_process.spawn — no buffering, no 120 s cutoff
 * (Memory 569 / 577 / 578).
 *
 * @module @domains/claude-bridge/types
 */

/**
 * How the claude binary was located.
 *   bin    — `<root>/bin/claude{,.exe}` (preferred, bundled with the OS)
 *   path   — found via `$PATH` walk (fallback for system-installed CLI)
 *   override — explicit `binaryPath` argument supplied by caller
 */
export type BinarySource = 'bin' | 'path' | 'override';

export interface ResolvedBinary {
  readonly path: string;
  readonly source: BinarySource;
  /**
   * M2 (2026-05-21 code-review): non-fatal Sicherheits-Warnung wenn die
   * Aufloesung den $PATH-Fallback genutzt hat. CLI-Layer kann die
   * Warning per stderr oder doctor an den User weitergeben. Default
   * undefined wenn keine Warnung anfaellt.
   */
  readonly warning?: string;
}

export interface BridgeOpts {
  /** Anthropic claude binary location override (skips resolution). */
  readonly binaryPath?: string;
  /** Cloud-mount root path; binary is searched under `<rootPath>/bin/`. */
  readonly rootPath?: string;
  /** Arguments to pass through to the claude binary. */
  readonly args: readonly string[];
  /** Environment for the child process. Defaults to parent env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory for the child. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Heartbeat interval in ms. `0` disables heartbeats. Default 10_000. */
  readonly heartbeatIntervalMs?: number;
  /** Grace period after SIGINT before SIGKILL. Default 5_000 ms. */
  readonly killGracePeriodMs?: number;
  /** Inject an alternate spawn fn (tests). Defaults to `child_process.spawn`. */
  readonly spawnFn?: typeof import('node:child_process').spawn;
}

export interface BridgeResult {
  /** Process exit code (null when killed by signal). */
  readonly exitCode: number | null;
  /** Signal that terminated the child, when applicable. */
  readonly signal: NodeJS.Signals | null;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Resolved binary used. */
  readonly binary: ResolvedBinary;
}

export class BinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryNotFoundError';
  }
}
