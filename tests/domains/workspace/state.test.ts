import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE,
  InvalidWorkspaceIdError,
  readActiveWorkspace,
  WorkspaceError,
  writeActiveWorkspace,
} from '../../../src/domains/workspace/index.js';

describe('workspace state persistence', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-state-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns default state when file does not exist', () => {
    const state = readActiveWorkspace({ dataDir });
    expect(state.active).toBe(DEFAULT_WORKSPACE);
    expect(state.switchedAt).toBe(new Date(0).toISOString());
  });

  it('round-trips write -> read', () => {
    const written = writeActiveWorkspace('msp-internal', { dataDir });
    expect(written.active).toBe('msp-internal');
    const read = readActiveWorkspace({ dataDir });
    expect(read.active).toBe('msp-internal');
    expect(read.switchedAt).toBe(written.switchedAt);
  });

  it('writes atomic via tempfile + rename', () => {
    writeActiveWorkspace('personal', { dataDir });
    const raw = readFileSync(join(dataDir, 'workspace-state.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ active: 'personal' });
  });

  it('rejects invalid ids on write', () => {
    expect(() => writeActiveWorkspace('../escape', { dataDir })).toThrow(InvalidWorkspaceIdError);
  });

  it('accepts customer-scoped ids', () => {
    const written = writeActiveWorkspace('msp-customers/acme', { dataDir });
    expect(written.active).toBe('msp-customers/acme');
  });

  it('throws on corrupt JSON', () => {
    const path = join(dataDir, 'workspace-state.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    expect(() => readActiveWorkspace({ dataDir })).toThrow(WorkspaceError);
  });

  it('throws on missing required fields', () => {
    const path = join(dataDir, 'workspace-state.json');
    writeFileSync(path, JSON.stringify({ wrong: 'shape' }), 'utf8');
    expect(() => readActiveWorkspace({ dataDir })).toThrow(WorkspaceError);
  });

  it('read is lenient for legacy/unknown active ids (no validation on read)', () => {
    const path = join(dataDir, 'workspace-state.json');
    writeFileSync(
      path,
      JSON.stringify({ active: 'legacy-id', switchedAt: '2026-01-01T00:00:00Z' }),
      'utf8',
    );
    const state = readActiveWorkspace({ dataDir });
    expect(state.active).toBe('legacy-id');
  });
});
