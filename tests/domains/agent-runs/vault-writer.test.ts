import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunRecord } from '../../../src/domains/agent-runs/index.js';
import { VaultWriter } from '../../../src/domains/agent-runs/index.js';

function makeRecord(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    version: 1,
    runId: '11111111-2222-3333-4444-555555555555',
    timestamp: '2026-05-17T08:00:00.123Z',
    machineId: 'machine-A',
    project: 'claude-portable',
    prompt: 'hello world',
    exitCode: 0,
    signal: null,
    durationMs: 1234,
    binaryPath: '/usr/bin/claude',
    binarySource: 'path',
    ...overrides,
  } as AgentRunRecord;
}

describe('VaultWriter', () => {
  let tmpBase: string;
  let vaultRoot: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-vw-'));
    vaultRoot = join(tmpBase, 'vault');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('writes markdown at <vault>/agent-runs/<project>/<ISO-safe>.md', () => {
    const w = new VaultWriter({ vaultRoot });
    const path = w.write(makeRecord());
    expect(path).toBe(
      join(vaultRoot, 'agent-runs', 'claude-portable', '2026-05-17T08-00-00-123Z.md'),
    );
    expect(existsSync(path)).toBe(true);
  });

  it('renders YAML frontmatter with all metadata fields', () => {
    const w = new VaultWriter({ vaultRoot });
    const path = w.write(makeRecord());
    const raw = readFileSync(path, 'utf8');
    expect(raw).toMatch(/^---\n/);
    expect(raw).toContain('runId: 11111111-2222-3333-4444-555555555555');
    expect(raw).toContain('project: claude-portable');
    expect(raw).toContain('machineId: machine-A');
    expect(raw).toContain('timestamp: "2026-05-17T08:00:00.123Z"');
    expect(raw).toContain('exitCode: 0');
    expect(raw).toContain('signal: null');
    expect(raw).toContain('durationMs: 1234');
    expect(raw).toContain('binarySource: path');
    expect(raw).toContain('# Agent run 2026-05-17T08:00:00.123Z');
  });

  it('renders prompts containing YAML special chars in the heading', () => {
    const w = new VaultWriter({ vaultRoot });
    const path = w.write(makeRecord({ prompt: 'fix: bug #42 in foo.ts' }));
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('**Prompt:** fix: bug #42 in foo.ts');
  });

  it('renders multi-line prompts in a fenced code block', () => {
    const w = new VaultWriter({ vaultRoot });
    const path = w.write(makeRecord({ prompt: 'line 1\nline 2\nline 3' }));
    const raw = readFileSync(path, 'utf8');
    expect(raw).toMatch(/```\nline 1\nline 2\nline 3\n```/);
  });

  it('sanitises project names with path separators', () => {
    const w = new VaultWriter({ vaultRoot });
    const path = w.write(makeRecord({ project: 'weird/sub:name' }));
    expect(existsSync(path)).toBe(true);
    expect(path).toContain('weird_sub_name');
  });

  it('pathFor is a pure resolver without I/O', () => {
    const w = new VaultWriter({ vaultRoot });
    const path = w.pathFor(makeRecord());
    expect(existsSync(path)).toBe(false);
    expect(path).toContain('agent-runs');
  });

  it('mentions the stdio-inherit caveat in the body', () => {
    const w = new VaultWriter({ vaultRoot });
    const path = w.write(makeRecord());
    const raw = readFileSync(path, 'utf8');
    expect(raw).toMatch(/stdio: inherit/);
  });
});
