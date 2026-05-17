/**
 * AgentRunsRepository — public façade over the JSONL writer + JSON
 * index + vault-markdown writer.
 *
 * Per Memory-565: the `project` column is a first-class field on
 * every query, never inferred from a directory path. The repository
 * surfaces this guarantee through `list({project})` and `show(runId)`
 * that returns the record regardless of how it was written.
 *
 * @module @domains/agent-runs/repository
 */
import { AgentRunsIndex, type QueryOpts } from './index-builder.js';
import { JsonlWriter } from './jsonl-writer.js';
import type { AgentRunRecord } from './types.js';
import { VaultWriter } from './vault-writer.js';

interface RepositoryOpts {
  readonly agentRunsRoot: string;
  readonly indexPath: string;
  readonly vaultRoot?: string;
  readonly machineId?: string;
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

export interface RecordOpts {
  readonly project: string;
  readonly prompt: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly binaryPath: string;
  readonly binarySource: 'bin' | 'path' | 'override';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RecordResult {
  readonly record: AgentRunRecord;
  readonly jsonlPath: string;
  readonly vaultMarkdownPath: string | null;
}

export class AgentRunsRepository {
  private readonly jsonlWriter: JsonlWriter;
  private readonly vaultWriter: VaultWriter | null;
  private readonly indexCtorOpts: { indexPath: string; agentRunsRoot: string };
  private cachedIndex: AgentRunsIndex | null = null;

  constructor(opts: RepositoryOpts) {
    this.jsonlWriter = new JsonlWriter({
      agentRunsRoot: opts.agentRunsRoot,
      ...(opts.machineId === undefined ? {} : { machineId: opts.machineId }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.uuid === undefined ? {} : { uuid: opts.uuid }),
    });
    this.vaultWriter =
      opts.vaultRoot === undefined ? null : new VaultWriter({ vaultRoot: opts.vaultRoot });
    this.indexCtorOpts = { indexPath: opts.indexPath, agentRunsRoot: opts.agentRunsRoot };
  }

  /**
   * Appends a JSONL row, writes the vault markdown (if vaultRoot is
   * configured), and invalidates the cached index. Returns the
   * resulting record + paths so callers can surface a confirmation.
   */
  record(opts: RecordOpts): RecordResult {
    const partial = {
      prompt: opts.prompt,
      exitCode: opts.exitCode,
      signal: opts.signal,
      durationMs: opts.durationMs,
      binaryPath: opts.binaryPath,
      binarySource: opts.binarySource,
      ...(opts.metadata === undefined ? {} : { metadata: opts.metadata }),
    };
    const record = this.jsonlWriter.append(opts.project, partial);
    const jsonlPath = this.jsonlWriter.filePathFor(opts.project);
    const vaultMarkdownPath = this.vaultWriter !== null ? this.vaultWriter.write(record) : null;
    this.cachedIndex = null;
    return { record, jsonlPath, vaultMarkdownPath };
  }

  /** Returns matching runs sorted timestamp-DESC. */
  list(query: QueryOpts = {}): readonly AgentRunRecord[] {
    return this.index().query(query);
  }

  /** Returns the record matching `runId`, or null. */
  show(runId: string): AgentRunRecord | null {
    return this.index().query().find((r) => r.runId === runId) ?? null;
  }

  /** Map of project → record count. */
  byProject(): ReadonlyMap<string, number> {
    return this.index().byProject();
  }

  /** Forces an index rebuild from the JSONL source-of-truth. */
  refreshIndex(): AgentRunsIndex {
    const { index } = AgentRunsIndex.rebuild(this.indexCtorOpts);
    this.cachedIndex = index;
    return index;
  }

  private index(): AgentRunsIndex {
    if (this.cachedIndex === null) {
      this.cachedIndex = AgentRunsIndex.loadOrRebuild(this.indexCtorOpts);
    }
    return this.cachedIndex;
  }
}
