/**
 * AgentRunsIndex — rebuildable read-cache over all JSONL files
 * partitioned across project + machine.
 *
 * Per ADR-0002 the index is just a cache: source of truth is the
 * JSONL files in the cloud-mount, so a corrupt or missing index is
 * always recoverable by re-scanning.
 *
 * v1 implementation uses a single JSON file at
 *   <dataDir>/agent-runs-index.json
 * with all records inlined sorted timestamp-DESC. SQLite (sql.js or
 * better-sqlite3) is an easy v1.x drop-in if record count or query
 * complexity grows past what an in-memory filter handles.
 *
 * @module @domains/agent-runs/index-builder
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentRunsError, type AgentRunRecord } from './types.js';

export interface IndexFileEnvelope {
  readonly version: 1;
  readonly rebuiltAt: string;
  readonly records: readonly AgentRunRecord[];
}

export interface RebuildResult {
  readonly indexPath: string;
  readonly recordCount: number;
  readonly jsonlFilesScanned: number;
  readonly malformedLinesSkipped: number;
  readonly durationMs: number;
}

export interface QueryOpts {
  readonly project?: string;
  readonly machineId?: string;
  /** ISO timestamp; only records strictly newer than this are returned. */
  readonly sinceIso?: string;
  /** Max number of records to return (after sorting). */
  readonly limit?: number;
}

interface IndexCtorOpts {
  readonly indexPath: string;
  readonly agentRunsRoot: string;
  readonly now?: () => Date;
}

const INDEX_VERSION = 1;

function walkJsonl(agentRunsRoot: string): string[] {
  const files: string[] = [];
  if (!existsSync(agentRunsRoot)) return files;
  const stack: string[] = [agentRunsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path);
      }
    }
  }
  return files;
}

function isAgentRunRecord(value: unknown): value is AgentRunRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === INDEX_VERSION &&
    typeof v.runId === 'string' &&
    typeof v.timestamp === 'string' &&
    typeof v.machineId === 'string' &&
    typeof v.project === 'string' &&
    typeof v.prompt === 'string' &&
    typeof v.durationMs === 'number' &&
    typeof v.binaryPath === 'string' &&
    typeof v.binarySource === 'string'
  );
}

function parseJsonlLines(filePath: string): {
  records: AgentRunRecord[];
  malformedLines: number;
} {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { records: [], malformedLines: 0 };
  }
  const records: AgentRunRecord[] = [];
  let malformedLines = 0;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (isAgentRunRecord(parsed)) {
      records.push(parsed);
    } else {
      malformedLines += 1;
    }
  }
  return { records, malformedLines };
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export class AgentRunsIndex {
  readonly indexPath: string;
  readonly agentRunsRoot: string;
  private records: AgentRunRecord[];
  private rebuiltAt: string;

  private constructor(opts: IndexCtorOpts, records: AgentRunRecord[], rebuiltAt: string) {
    this.indexPath = opts.indexPath;
    this.agentRunsRoot = opts.agentRunsRoot;
    this.records = records;
    this.rebuiltAt = rebuiltAt;
  }

  /**
   * Walks `agentRunsRoot`, parses every JSONL, sorts records by
   * timestamp descending, and writes the index to disk atomically.
   */
  static rebuild(opts: IndexCtorOpts): {
    index: AgentRunsIndex;
    result: RebuildResult;
  } {
    const startedAt = Date.now();
    const files = walkJsonl(opts.agentRunsRoot);
    const allRecords: AgentRunRecord[] = [];
    let malformedLines = 0;
    for (const file of files) {
      const { records, malformedLines: m } = parseJsonlLines(file);
      allRecords.push(...records);
      malformedLines += m;
    }
    allRecords.sort((a, b) =>
      a.timestamp > b.timestamp ? -1 : a.timestamp < b.timestamp ? 1 : 0,
    );
    const rebuiltAt = (opts.now ?? (() => new Date()))().toISOString();
    const envelope: IndexFileEnvelope = {
      version: INDEX_VERSION,
      rebuiltAt,
      records: allRecords,
    };
    atomicWrite(opts.indexPath, JSON.stringify(envelope, null, 2));
    const index = new AgentRunsIndex(opts, allRecords, rebuiltAt);
    return {
      index,
      result: {
        indexPath: opts.indexPath,
        recordCount: allRecords.length,
        jsonlFilesScanned: files.length,
        malformedLinesSkipped: malformedLines,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  /** Loads an existing index file. Returns null on missing/corrupt. */
  static load(opts: IndexCtorOpts): AgentRunsIndex | null {
    if (!existsSync(opts.indexPath)) return null;
    let raw: string;
    try {
      raw = readFileSync(opts.indexPath, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const env = parsed as Record<string, unknown>;
    if (env.version !== INDEX_VERSION) return null;
    if (typeof env.rebuiltAt !== 'string') return null;
    if (!Array.isArray(env.records)) return null;
    const records = env.records.filter(isAgentRunRecord);
    return new AgentRunsIndex(opts, [...records], env.rebuiltAt);
  }

  /** Loads if present, otherwise rebuilds from JSONL files. */
  static loadOrRebuild(opts: IndexCtorOpts): AgentRunsIndex {
    return AgentRunsIndex.load(opts) ?? AgentRunsIndex.rebuild(opts).index;
  }

  count(): number {
    return this.records.length;
  }

  /** Map of project name → record count. */
  byProject(): ReadonlyMap<string, number> {
    const map = new Map<string, number>();
    for (const r of this.records) map.set(r.project, (map.get(r.project) ?? 0) + 1);
    return map;
  }

  query(opts: QueryOpts = {}): readonly AgentRunRecord[] {
    let filtered: readonly AgentRunRecord[] = this.records;
    if (opts.project !== undefined) {
      const project = opts.project;
      filtered = filtered.filter((r) => r.project === project);
    }
    if (opts.machineId !== undefined) {
      const machineId = opts.machineId;
      filtered = filtered.filter((r) => r.machineId === machineId);
    }
    if (opts.sinceIso !== undefined) {
      const since = opts.sinceIso;
      filtered = filtered.filter((r) => r.timestamp > since);
    }
    if (opts.limit !== undefined) {
      if (opts.limit < 0) {
        throw new AgentRunsError(`query limit must be >= 0, got ${opts.limit}`);
      }
      filtered = filtered.slice(0, opts.limit);
    }
    return filtered;
  }

  rebuiltAtIso(): string {
    return this.rebuiltAt;
  }
}

/** Default index path convention: `<dataDir>/agent-runs-index.json`. */
export function agentRunsIndexPathFor(dataDir: string): string {
  return join(dataDir, 'agent-runs-index.json');
}
