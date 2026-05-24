import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertValidWorkspaceId,
  classifyWorkspace,
  InvalidWorkspaceIdError,
  listWorkspaces,
  resolveWorkspacePath,
  workspaceExists,
  workspacesDir,
} from '../../../src/domains/workspace/index.js';

describe('assertValidWorkspaceId', () => {
  it.each([
    'personal',
    'msp-internal',
    'msp-customers/acme',
    'msp-customers/foo-bar_42',
  ])('accepts %s', (id) => {
    expect(() => assertValidWorkspaceId(id)).not.toThrow();
  });

  it.each([
    '',
    '../escape',
    'msp-customers/',
    'msp-customers/UPPER',
    'msp-customers/with space',
    'msp-customers/-leading-dash',
    'unknown',
    'msp-customers/foo/../../escape',
  ])('rejects %s', (id) => {
    expect(() => assertValidWorkspaceId(id)).toThrow(InvalidWorkspaceIdError);
  });
});

describe('classifyWorkspace', () => {
  it('maps known kinds', () => {
    expect(classifyWorkspace('personal')).toBe('personal');
    expect(classifyWorkspace('msp-internal')).toBe('msp-internal');
    expect(classifyWorkspace('msp-customers/foo')).toBe('msp-customers');
    expect(classifyWorkspace('_unsorted')).toBe('unsorted');
    expect(classifyWorkspace('random-string')).toBe('unsorted');
  });
});

describe('workspacesDir + resolveWorkspacePath', () => {
  it('produces the ADR-0031 layout', () => {
    const vault = '/tmp/v';
    expect(workspacesDir(vault).replace(/\\/g, '/')).toBe('/tmp/v/Claude-OS/workspaces');
    expect(resolveWorkspacePath(vault, 'personal').replace(/\\/g, '/')).toBe(
      '/tmp/v/Claude-OS/workspaces/personal',
    );
    expect(resolveWorkspacePath(vault, 'msp-customers/acme').replace(/\\/g, '/')).toBe(
      '/tmp/v/Claude-OS/workspaces/msp-customers/acme',
    );
  });

  it('refuses traversal in customer-id', () => {
    expect(() => resolveWorkspacePath('/tmp/v', 'msp-customers/../escape')).toThrow(
      InvalidWorkspaceIdError,
    );
  });
});

describe('listWorkspaces + workspaceExists', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'vault-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('returns just the default for a fresh vault', () => {
    const items = listWorkspaces(vault);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('personal');
    expect(items[0]?.path).toBeNull();
  });

  it('lists real workspaces from disk', () => {
    mkdirSync(join(vault, 'Claude-OS', 'workspaces', 'personal'), { recursive: true });
    mkdirSync(join(vault, 'Claude-OS', 'workspaces', 'msp-internal'), { recursive: true });
    mkdirSync(join(vault, 'Claude-OS', 'workspaces', 'msp-customers', 'acme'), {
      recursive: true,
    });
    const items = listWorkspaces(vault);
    const ids = items.map((w) => w.id).sort();
    expect(ids).toEqual(['msp-customers/acme', 'msp-internal', 'personal']);
  });

  it('still surfaces personal as virtual when only customers exist', () => {
    mkdirSync(join(vault, 'Claude-OS', 'workspaces', 'msp-customers', 'acme'), {
      recursive: true,
    });
    const items = listWorkspaces(vault);
    const personal = items.find((w) => w.id === 'personal');
    expect(personal).toBeDefined();
    expect(personal?.path).toBeNull();
  });

  it('skips invalid customer-id directories', () => {
    mkdirSync(join(vault, 'Claude-OS', 'workspaces', 'msp-customers', 'UPPER'), {
      recursive: true,
    });
    mkdirSync(join(vault, 'Claude-OS', 'workspaces', 'msp-customers', 'valid-one'), {
      recursive: true,
    });
    const ids = listWorkspaces(vault).map((w) => w.id);
    expect(ids).toContain('msp-customers/valid-one');
    expect(ids).not.toContain('msp-customers/UPPER');
  });

  it('workspaceExists reflects on-disk reality + id-validation', () => {
    mkdirSync(join(vault, 'Claude-OS', 'workspaces', 'personal'), { recursive: true });
    expect(workspaceExists(vault, 'personal')).toBe(true);
    expect(workspaceExists(vault, 'msp-internal')).toBe(false);
    expect(workspaceExists(vault, '../escape')).toBe(false);
  });
});
