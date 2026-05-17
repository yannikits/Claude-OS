/**
 * JSONL writer for agent-runs — one append-only file per (project,
 * machineId). Append-only is the cross-machine sync-safety guarantee
 * per ADR-0002: each machine only ever writes its own file, so cloud-
 * sync clients never need to merge.
 *
 * Atomicity: `appendFileSync` issues a single `write(2)` with
 * `O_APPEND`. On POSIX this is atomic up to `PIPE_BUF` (~4 KB).
 * Modern Linux/macOS/Windows handle multi-KB appends atomically for
 * regular files; an AgentRunRecord serialises to ~200-400 bytes well
 * inside the atomicity window. Since each machine has only one
 * writer per file by design, contention is not a concern.
 *
 * @module @domains/agent-runs/jsonl-writer
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { AGENT_RUN_SCHEMA_VERSION, type AgentRunRecord, AgentRunsError } from './types.js';

interface JsonlWriterOpts {
  /** `<root>/vault/agent-runs/` parent path. */
  readonly agentRunsRoot: string;
  /** Override `os.hostname()`. */
  readonly machineId?: string;
  /** Override clock. */
  readonly now?: () => Date;
  /** Override UUID generator (tests). */
  readonly uuid?: () => string;
}

const FILENAME_SAFE = /[^A-Za-z0-9._-]+/g;

/** Replaces filesystem-unsafe characters with `_`. */
export function sanitiseSegment(segment: string): string {
  const replaced = segment.replace(FILENAME_SAFE, '_');
  if (replaced.length === 0) {
    throw new AgentRunsError('Path segment is empty after sanitisation');
  }
  return replaced;
}

export class JsonlWriter {
  private readonly agentRunsRoot: string;
  private readonly machineId: string;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(opts: JsonlWriterOpts) {
    this.agentRunsRoot = opts.agentRunsRoot;
    this.machineId = sanitiseSegment(opts.machineId ?? hostname());
    this.now = opts.now ?? (() => new Date());
    this.uuid = opts.uuid ?? (() => randomUUID());
  }

  /** Resolves the JSONL file path for a given project + the configured machineId. */
  filePathFor(project: string): string {
    const safeProject = sanitiseSegment(project);
    return join(this.agentRunsRoot, safeProject, `${this.machineId}.jsonl`);
  }

  /**
   * Appends a record to the per-machine JSONL file for `project`.
   * Generates `version`, `runId`, `timestamp`, and `machineId` if the
   * caller omits them — the rest is taken from `partial`.
   */
  append(
    project: string,
    partial: Omit<AgentRunRecord, 'version' | 'runId' | 'timestamp' | 'machineId' | 'project'>,
  ): AgentRunRecord {
    const record: AgentRunRecord = {
      version: AGENT_RUN_SCHEMA_VERSION,
      runId: this.uuid(),
      timestamp: this.now().toISOString(),
      machineId: this.machineId,
      project,
      ...partial,
    };
    const path = this.filePathFor(project);
    mkdirSync(join(path, '..'), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(path, line, { mode: 0o644 });
    return record;
  }
}
