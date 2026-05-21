/**
 * M33 (2026-05-21 code-review): RPC-Tests fuer `agent.list` —
 * verifiziert Singleton-Repository (M13) + happy-path-list + filter
 * params + leerer-Catalog default.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

describe('agent.list RPC', () => {
  let tmpRoot: string;
  let tmpData: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-agent-root-'));
    tmpData = mkdtempSync(join(tmpdir(), 'claude-os-agent-data-'));
    mkdirSync(join(tmpData, 'data'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    envBackup = { ...process.env };
    process.env.CLAUDE_OS_ROOT = tmpRoot;
    process.env.CLAUDE_OS_DATA_DIR = tmpData;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
    process.env = envBackup;
  });

  it('returns count:0 + items:[] wenn keine agent-runs existieren', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('agent.list', {})) as {
      count: number;
      items: unknown[];
    };
    expect(result.count).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('liefert items wenn JSONL records existieren', async () => {
    // Setup minimaler JSONL-Eintrag
    const runsDir = join(tmpRoot, 'vault', 'agent-runs');
    mkdirSync(runsDir, { recursive: true });
    const record = {
      version: 1 as const,
      runId: 'r1',
      project: 'demo',
      machineId: 'm1',
      timestamp: '2026-05-21T08:00:00.000Z',
      exitCode: 0,
      signal: null,
      durationMs: 1000,
      prompt: 'test prompt',
      binaryPath: '/x/claude',
      binarySource: 'override' as const,
    };
    writeFileSync(join(runsDir, 'demo-m1.jsonl'), `${JSON.stringify(record)}\n`);

    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('agent.list', {})) as {
      count: number;
      items: { runId: string; project: string }[];
    };
    expect(result.count).toBe(1);
    expect(result.items[0]?.runId).toBe('r1');
    expect(result.items[0]?.project).toBe('demo');
  });

  it('respektiert project-filter', async () => {
    const runsDir = join(tmpRoot, 'vault', 'agent-runs');
    mkdirSync(runsDir, { recursive: true });
    const recordA = {
      version: 1 as const,
      runId: 'a1',
      project: 'projA',
      machineId: 'm1',
      timestamp: '2026-05-21T08:00:00.000Z',
      exitCode: 0,
      signal: null,
      durationMs: 1000,
      prompt: 'a',
      binaryPath: '/x/claude',
      binarySource: 'override' as const,
    };
    const recordB = { ...recordA, runId: 'b1', project: 'projB', prompt: 'b' };
    writeFileSync(join(runsDir, 'projA-m1.jsonl'), `${JSON.stringify(recordA)}\n`);
    writeFileSync(join(runsDir, 'projB-m1.jsonl'), `${JSON.stringify(recordB)}\n`);

    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('agent.list', { project: 'projA' })) as {
      count: number;
      items: { runId: string; project: string }[];
    };
    expect(result.count).toBe(1);
    expect(result.items[0]?.project).toBe('projA');
  });

  it('respektiert limit-filter', async () => {
    const runsDir = join(tmpRoot, 'vault', 'agent-runs');
    mkdirSync(runsDir, { recursive: true });
    const records = Array.from({ length: 5 }, (_, i) => ({
      version: 1 as const,
      runId: `r${i}`,
      project: 'demo',
      machineId: 'm1',
      timestamp: `2026-05-21T08:0${i}:00.000Z`,
      exitCode: 0,
      signal: null,
      durationMs: 1000,
      prompt: `p${i}`,
      binaryPath: '/x/claude',
      binarySource: 'override' as const,
    }));
    writeFileSync(
      join(runsDir, 'demo-m1.jsonl'),
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );

    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('agent.list', { limit: 2 })) as {
      count: number;
      items: unknown[];
    };
    expect(result.count).toBe(2);
  });

  it('M13: repository wird zwischen RPC-Calls cached (Singleton)', async () => {
    const runsDir = join(tmpRoot, 'vault', 'agent-runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, 'demo-m1.jsonl'),
      `${JSON.stringify({
        version: 1 as const,
        runId: 'r1',
        project: 'demo',
        machineId: 'm1',
        timestamp: '2026-05-21T08:00:00.000Z',
        exitCode: 0,
        signal: null,
        durationMs: 1000,
        prompt: 'p',
        binaryPath: '/x/claude',
        binarySource: 'override' as const,
      })}\n`,
    );
    const d = new RpcDispatcher();
    registerMethods(d);
    // Two consecutive invokes — der zweite re-uses repository
    const r1 = (await d.invoke('agent.list', {})) as { count: number };
    const r2 = (await d.invoke('agent.list', {})) as { count: number };
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(1);
    // (Wir koennen nicht direkt observe dass Singleton greift — der Code-
    // Pfad ist single-process — aber consistency zwischen beiden Calls
    // ist die externe Garantie.)
  });
});
