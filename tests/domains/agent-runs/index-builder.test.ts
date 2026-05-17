import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRunsError,
  AgentRunsIndex,
  agentRunsIndexPathFor,
  JsonlWriter,
} from '../../../src/domains/agent-runs/index.js';

describe('AgentRunsIndex', () => {
  let tmpBase: string;
  let agentRunsRoot: string;
  let dataDir: string;
  let indexPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-runs-idx-'));
    agentRunsRoot = join(tmpBase, 'agent-runs');
    dataDir = join(tmpBase, 'data');
    indexPath = agentRunsIndexPathFor(dataDir);
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function seed(opts: {
    project: string;
    machineId: string;
    count: number;
    baseMs?: number;
  }): void {
    const baseMs = opts.baseMs ?? Date.parse('2026-05-17T08:00:00.000Z');
    for (let i = 0; i < opts.count; i += 1) {
      const w = new JsonlWriter({
        agentRunsRoot,
        machineId: opts.machineId,
        now: () => new Date(baseMs + i * 1000),
        uuid: () => `${opts.project}-${opts.machineId}-${i.toString().padStart(4, '0')}`,
      });
      w.append(opts.project, {
        prompt: `${opts.project}-${i}`,
        exitCode: 0,
        signal: null,
        durationMs: 100,
        binaryPath: '/x',
        binarySource: 'path',
      });
    }
  }

  it('rebuild scans all JSONL files and returns counts', () => {
    seed({ project: 'proj-A', machineId: 'm1', count: 3 });
    seed({ project: 'proj-B', machineId: 'm1', count: 2 });
    seed({ project: 'proj-A', machineId: 'm2', count: 1 });
    const { index, result } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    expect(result.recordCount).toBe(6);
    expect(result.jsonlFilesScanned).toBe(3);
    expect(result.malformedLinesSkipped).toBe(0);
    expect(index.count()).toBe(6);
    expect(existsSync(indexPath)).toBe(true);
  });

  it('rebuild sorts records timestamp-descending', () => {
    seed({ project: 'p', machineId: 'm', count: 4 });
    const { index } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    const ts = index.query().map((r) => r.timestamp);
    const sorted = [...ts].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(ts).toEqual(sorted);
  });

  it('rebuild persists a valid envelope on disk', () => {
    seed({ project: 'p', machineId: 'm', count: 2 });
    AgentRunsIndex.rebuild({
      indexPath,
      agentRunsRoot,
      now: () => new Date('2026-05-17T09:00:00.000Z'),
    });
    const raw = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    expect(raw.version).toBe(1);
    expect(raw.rebuiltAt).toBe('2026-05-17T09:00:00.000Z');
    expect(Array.isArray(raw.records)).toBe(true);
    expect((raw.records as unknown[]).length).toBe(2);
  });

  it('load returns null when index file missing', () => {
    expect(AgentRunsIndex.load({ indexPath, agentRunsRoot })).toBeNull();
  });

  it('load returns null on malformed envelope', () => {
    mkdirSync(join(indexPath, '..'), { recursive: true });
    writeFileSync(indexPath, '{not real json');
    expect(AgentRunsIndex.load({ indexPath, agentRunsRoot })).toBeNull();
  });

  it('load returns null on version mismatch', () => {
    mkdirSync(join(indexPath, '..'), { recursive: true });
    writeFileSync(
      indexPath,
      JSON.stringify({ version: 99, rebuiltAt: '2026-05-17T08:00:00.000Z', records: [] }),
    );
    expect(AgentRunsIndex.load({ indexPath, agentRunsRoot })).toBeNull();
  });

  it('load round-trips after rebuild', () => {
    seed({ project: 'p', machineId: 'm', count: 3 });
    AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    const reloaded = AgentRunsIndex.load({ indexPath, agentRunsRoot });
    expect(reloaded?.count()).toBe(3);
  });

  it('loadOrRebuild rebuilds when no index exists', () => {
    seed({ project: 'p', machineId: 'm', count: 2 });
    const idx = AgentRunsIndex.loadOrRebuild({ indexPath, agentRunsRoot });
    expect(idx.count()).toBe(2);
    expect(existsSync(indexPath)).toBe(true);
  });

  it('query filters by project', () => {
    seed({ project: 'A', machineId: 'm', count: 3 });
    seed({
      project: 'B',
      machineId: 'm',
      count: 5,
      baseMs: Date.parse('2026-05-17T09:00:00.000Z'),
    });
    const { index } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    expect(index.query({ project: 'A' }).length).toBe(3);
    expect(index.query({ project: 'B' }).length).toBe(5);
  });

  it('query filters by machineId', () => {
    seed({ project: 'p', machineId: 'm1', count: 2 });
    seed({
      project: 'p',
      machineId: 'm2',
      count: 3,
      baseMs: Date.parse('2026-05-17T09:00:00.000Z'),
    });
    const { index } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    expect(index.query({ machineId: 'm1' }).length).toBe(2);
    expect(index.query({ machineId: 'm2' }).length).toBe(3);
  });

  it('query filters by sinceIso', () => {
    seed({ project: 'p', machineId: 'm', count: 5 });
    const { index } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    const filtered = index.query({ sinceIso: '2026-05-17T08:00:02.500Z' });
    expect(filtered.every((r) => r.timestamp > '2026-05-17T08:00:02.500Z')).toBe(true);
    expect(filtered.length).toBe(2);
  });

  it('query applies limit', () => {
    seed({ project: 'p', machineId: 'm', count: 10 });
    const { index } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    expect(index.query({ limit: 3 }).length).toBe(3);
  });

  it('query rejects negative limit', () => {
    const { index } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    expect(() => index.query({ limit: -1 })).toThrow(AgentRunsError);
  });

  it('byProject returns counts per project', () => {
    seed({ project: 'A', machineId: 'm', count: 4 });
    seed({
      project: 'B',
      machineId: 'm',
      count: 7,
      baseMs: Date.parse('2026-05-17T09:00:00.000Z'),
    });
    const { index } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    const byProj = index.byProject();
    expect(byProj.get('A')).toBe(4);
    expect(byProj.get('B')).toBe(7);
  });

  it('malformed JSONL lines are tolerated and counted', () => {
    seed({ project: 'p', machineId: 'm', count: 2 });
    appendFileSync(join(agentRunsRoot, 'p', 'm.jsonl'), '{not valid json\n');
    appendFileSync(join(agentRunsRoot, 'p', 'm.jsonl'), '{"version":999}\n');
    const { result } = AgentRunsIndex.rebuild({ indexPath, agentRunsRoot });
    expect(result.recordCount).toBe(2);
    expect(result.malformedLinesSkipped).toBe(2);
  });

  it('handles a missing agentRunsRoot gracefully', () => {
    const { index, result } = AgentRunsIndex.rebuild({
      indexPath,
      agentRunsRoot: join(tmpBase, 'no-such-dir'),
    });
    expect(result.recordCount).toBe(0);
    expect(result.jsonlFilesScanned).toBe(0);
    expect(index.count()).toBe(0);
  });
});

describe('agentRunsIndexPathFor', () => {
  it('returns <dataDir>/agent-runs-index.json', () => {
    expect(agentRunsIndexPathFor('/data')).toBe(join('/data', 'agent-runs-index.json'));
  });
});
