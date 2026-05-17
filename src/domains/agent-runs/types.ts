/**
 * Agent-runs domain types (Phase 5, ADR-0002 §27).
 *
 * One JSONL record per AI session run, partitioned across machines:
 *   vault/agent-runs/<project>/<machineId>.jsonl
 *
 * Append-only by design — no rewrites mean cloud-sync is a no-conflict
 * operation across machines. The local SQLite index (Phase 5b) is a
 * rebuilt read-cache.
 *
 * @module @domains/agent-runs/types
 */

/** Schema version. Bump when adding non-additive fields. */
export const AGENT_RUN_SCHEMA_VERSION = 1;

/** A single recorded AI-bridge session run. */
export interface AgentRunRecord {
  /** Schema version for forward-compat readers. */
  readonly version: typeof AGENT_RUN_SCHEMA_VERSION;
  /** v4 UUID identifying the run within (project, machineId). */
  readonly runId: string;
  /** ISO-8601 with millisecond precision. */
  readonly timestamp: string;
  /** `os.hostname()` of the machine that produced the record. */
  readonly machineId: string;
  /**
   * Project name the run is attributed to. Memory-565: this column is
   * REQUIRED so multi-project agent-runs cross-machine can be queried
   * with project as a first-class filter, not inferred from path.
   */
  readonly project: string;
  /** First-line summary of the user prompt; full text lives in the vault markdown. */
  readonly prompt: string;
  /** Child exit code, null when terminated by signal. */
  readonly exitCode: number | null;
  /** POSIX signal name when terminated by signal. */
  readonly signal: string | null;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Absolute path of the claude binary that ran. */
  readonly binaryPath: string;
  /** How the binary was located (mirrors claude-bridge ResolvedBinary.source). */
  readonly binarySource: 'bin' | 'path' | 'override';
  /** Arbitrary extension fields. Reserved for v1.x without bumping `version`. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class AgentRunsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunsError';
  }
}
