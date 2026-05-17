import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_RUN_SCHEMA_VERSION,
  type AgentRunRecord,
  AgentRunsError,
  JsonlWriter,
  sanitiseSegment,
} from '../../../src/domains/agent-runs/index.js';

describe('sanitiseSegment', () => {
  it('passes through filesystem-safe input', () => {
    expect(sanitiseSegment('thinking-partner')).toBe('thinking-partner');
    expect(sanitiseSegment('machine_A.1')).toBe('machine_A.1');
  });

  it('replaces path separators and special chars with underscore', () => {
    expect(sanitiseSegment('proj/sub')).toBe('proj_sub');
    expect(sanitiseSegment('a:b\\c')).toBe('a_b_c');
    expect(sanitiseSegment('with spaces')).toBe('with_spaces');
  });

  it('throws when the segment is empty after sanitisation', () => {
    expect(() => sanitiseSegment('')).toThrow(AgentRunsError);
  });

  it('all-separator input becomes the sanitised replacement chars (not empty)', () => {
    expect(sanitiseSegment('////')).toBe('_');
  });
});

describe('JsonlWriter', () => {
  let tmpBase: string;
  let agentRunsRoot: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-jsonl-'));
    agentRunsRoot = join(tmpBase, 'agent-runs');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeWriter(
    overrides: { machineId?: string; now?: () => Date; uuid?: () => string } = {},
  ): JsonlWriter {
    return new JsonlWriter({
      agentRunsRoot,
      machineId: overrides.machineId ?? 'machine-A',
      now: overrides.now ?? (() => new Date('2026-05-17T08:00:00.123Z')),
      uuid: overrides.uuid ?? (() => '11111111-2222-3333-4444-555555555555'),
    });
  }

  function readLines(project: string, machineId = 'machine-A'): AgentRunRecord[] {
    const path = join(agentRunsRoot, project, `${machineId}.jsonl`);
    const raw = readFileSync(path, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AgentRunRecord);
  }

  it('writes a JSONL line with all required fields', () => {
    const writer = makeWriter();
    const record = writer.append('claude-portable', {
      prompt: 'hello',
      exitCode: 0,
      signal: null,
      durationMs: 1234,
      binaryPath: '/usr/bin/claude',
      binarySource: 'path',
    });

    expect(record.version).toBe(AGENT_RUN_SCHEMA_VERSION);
    expect(record.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(record.timestamp).toBe('2026-05-17T08:00:00.123Z');
    expect(record.machineId).toBe('machine-A');
    expect(record.project).toBe('claude-portable');

    const lines = readLines('claude-portable');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(record);
  });

  it('appends successive records to the same file', () => {
    const writer = makeWriter();
    writer.append('p', {
      prompt: 'a',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    });
    writer.append('p', {
      prompt: 'b',
      exitCode: 1,
      signal: null,
      durationMs: 2,
      binaryPath: '/x',
      binarySource: 'path',
    });
    writer.append('p', {
      prompt: 'c',
      exitCode: null,
      signal: 'SIGINT',
      durationMs: 3,
      binaryPath: '/x',
      binarySource: 'path',
    });
    const lines = readLines('p');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.prompt)).toEqual(['a', 'b', 'c']);
  });

  it('partitions by project subdir', () => {
    const writer = makeWriter();
    writer.append('proj-A', {
      prompt: 'A',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    });
    writer.append('proj-B', {
      prompt: 'B',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    });
    expect(existsSync(join(agentRunsRoot, 'proj-A', 'machine-A.jsonl'))).toBe(true);
    expect(existsSync(join(agentRunsRoot, 'proj-B', 'machine-A.jsonl'))).toBe(true);
  });

  it('partitions by machineId — two writers on the same project never share a file', () => {
    const a = makeWriter({ machineId: 'machine-A' });
    const b = makeWriter({ machineId: 'machine-B' });
    a.append('p', {
      prompt: 'from A',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    });
    b.append('p', {
      prompt: 'from B',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    });
    expect(readLines('p', 'machine-A').map((l) => l.prompt)).toEqual(['from A']);
    expect(readLines('p', 'machine-B').map((l) => l.prompt)).toEqual(['from B']);
  });

  it('sanitises project names with path separators', () => {
    const writer = makeWriter();
    writer.append('weird/proj name', {
      prompt: 'x',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    });
    expect(existsSync(join(agentRunsRoot, 'weird_proj_name', 'machine-A.jsonl'))).toBe(true);
  });

  it('sanitises machineId via constructor', () => {
    const writer = makeWriter({ machineId: 'host:1\\2' });
    writer.append('p', {
      prompt: 'x',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    });
    expect(existsSync(join(agentRunsRoot, 'p', 'host_1_2.jsonl'))).toBe(true);
  });

  it('filePathFor returns the resolved path without writing', () => {
    const writer = makeWriter();
    const path = writer.filePathFor('demo');
    expect(path).toBe(join(agentRunsRoot, 'demo', 'machine-A.jsonl'));
    expect(existsSync(path)).toBe(false);
  });

  it('each line is valid JSON terminated by newline', () => {
    const writer = makeWriter();
    writer.append('p', {
      prompt: 'x',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      binaryPath: '/x',
      binarySource: 'path',
    });
    const raw = readFileSync(join(agentRunsRoot, 'p', 'machine-A.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw.trim())).not.toThrow();
  });
});
