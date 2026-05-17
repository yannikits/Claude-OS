import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRunsRepository,
  agentRunsIndexPathFor,
} from '../../../src/domains/agent-runs/index.js';

describe('AgentRunsRepository', () => {
  let tmpBase: string;
  let agentRunsRoot: string;
  let dataDir: string;
  let indexPath: string;
  let vaultRoot: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-repo-'));
    agentRunsRoot = join(tmpBase, 'vault', 'agent-runs');
    dataDir = join(tmpBase, 'data');
    indexPath = agentRunsIndexPathFor(dataDir);
    vaultRoot = join(tmpBase, 'vault');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeRepo(
    overrides: {
      machineId?: string;
      vaultRoot?: string;
      now?: () => Date;
      uuid?: () => string;
    } = {},
  ): AgentRunsRepository {
    return new AgentRunsRepository({
      agentRunsRoot,
      indexPath,
      vaultRoot: overrides.vaultRoot ?? vaultRoot,
      machineId: overrides.machineId ?? 'machine-A',
      now: overrides.now ?? (() => new Date('2026-05-17T08:00:00.123Z')),
      uuid: overrides.uuid ?? (() => '11111111-2222-3333-4444-555555555555'),
    });
  }

  function makeOpts(overrides: { project?: string; prompt?: string } = {}): {
    project: string;
    prompt: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    binaryPath: string;
    binarySource: 'bin' | 'path' | 'override';
  } {
    return {
      project: overrides.project ?? 'p',
      prompt: overrides.prompt ?? 'hello',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    };
  }

  it('record() writes JSONL + vault markdown', () => {
    const repo = makeRepo();
    const result = repo.record(makeOpts());
    expect(result.record.project).toBe('p');
    expect(existsSync(result.jsonlPath)).toBe(true);
    expect(result.vaultMarkdownPath).not.toBeNull();
    expect(existsSync(result.vaultMarkdownPath as string)).toBe(true);
  });

  it('record() returns null vaultMarkdownPath when vaultRoot is not configured', () => {
    const repo = new AgentRunsRepository({
      agentRunsRoot,
      indexPath,
      machineId: 'machine-A',
      now: () => new Date('2026-05-17T08:00:00.123Z'),
      uuid: () => '11111111-2222-3333-4444-555555555555',
    });
    const result = repo.record(makeOpts());
    expect(result.vaultMarkdownPath).toBeNull();
  });

  it('list() returns recorded runs sorted timestamp-DESC', () => {
    const t0 = Date.parse('2026-05-17T08:00:00.000Z');
    const project = 'p';
    for (let i = 0; i < 3; i += 1) {
      const repo = makeRepo({
        now: () => new Date(t0 + i * 1000),
        uuid: () => `id-${i}`,
      });
      repo.record(makeOpts({ project, prompt: `n${i}` }));
    }
    const repo = makeRepo();
    const list = repo.list();
    expect(list.map((r) => r.prompt)).toEqual(['n2', 'n1', 'n0']);
  });

  it('list() respects project filter (Memory-565)', () => {
    const t0 = Date.parse('2026-05-17T08:00:00.000Z');
    for (let i = 0; i < 2; i += 1) {
      const repo = makeRepo({ now: () => new Date(t0 + i * 1000), uuid: () => `a-${i}` });
      repo.record(makeOpts({ project: 'A' }));
    }
    for (let i = 0; i < 3; i += 1) {
      const repo = makeRepo({
        now: () => new Date(t0 + 100_000 + i * 1000),
        uuid: () => `b-${i}`,
      });
      repo.record(makeOpts({ project: 'B' }));
    }
    const repo = makeRepo();
    expect(repo.list({ project: 'A' }).length).toBe(2);
    expect(repo.list({ project: 'B' }).length).toBe(3);
  });

  it('show() returns a record by runId', () => {
    const repo = makeRepo({ uuid: () => 'fixed-id' });
    repo.record(makeOpts({ prompt: 'unique' }));
    const found = repo.show('fixed-id');
    expect(found?.prompt).toBe('unique');
  });

  it('show() returns null for unknown runId', () => {
    const repo = makeRepo();
    repo.record(makeOpts());
    expect(repo.show('does-not-exist')).toBeNull();
  });

  it('byProject() aggregates counts', () => {
    const t0 = Date.parse('2026-05-17T08:00:00.000Z');
    const a = makeRepo({ now: () => new Date(t0), uuid: () => 'a1' });
    a.record(makeOpts({ project: 'A' }));
    const b1 = makeRepo({ now: () => new Date(t0 + 1000), uuid: () => 'b1' });
    b1.record(makeOpts({ project: 'B' }));
    const b2 = makeRepo({ now: () => new Date(t0 + 2000), uuid: () => 'b2' });
    b2.record(makeOpts({ project: 'B' }));
    const repo = makeRepo();
    const byProj = repo.byProject();
    expect(byProj.get('A')).toBe(1);
    expect(byProj.get('B')).toBe(2);
  });

  it('refreshIndex() rebuilds and reflects fresh JSONL appends', () => {
    const repo = makeRepo();
    repo.record(makeOpts());
    repo.refreshIndex();
    expect(repo.list().length).toBe(1);
  });

  it('vault markdown carries the project + prompt fields', () => {
    const repo = makeRepo({ uuid: () => 'rid-vault' });
    const result = repo.record(makeOpts({ project: 'demo', prompt: 'do the thing' }));
    const raw = readFileSync(result.vaultMarkdownPath as string, 'utf8');
    expect(raw).toContain('runId: rid-vault');
    expect(raw).toContain('project: demo');
    expect(raw).toContain('**Prompt:** do the thing');
  });
});
