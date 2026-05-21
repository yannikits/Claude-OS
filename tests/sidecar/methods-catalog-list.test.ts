/**
 * M11 (2026-05-21 code-review): `catalog.list` RPC darf File-Paths NICHT
 * via Error-Message zum GUI-Peer leaken. Bei InvalidCatalogError wird
 * stattdessen `{ok: false, code: 'invalid-catalog'}` zurueckgegeben.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

let tmpRoot: string;
let envBackup: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-cat-list-'));
  writeFileSync(join(tmpRoot, '.claude-os-root'), '');
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  envBackup = { ...process.env };
  process.env.CLAUDE_OS_ROOT = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = envBackup;
});

describe('catalog.list RPC — M11 file-path-leak Schutz', () => {
  it('happy path: gibt entries + paths zurueck', async () => {
    writeFileSync(
      join(tmpRoot, 'config', 'catalog.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'a',
            kind: 'plugin',
            source: 'github:test/repo',
            enabled: true,
            scope: 'user',
          },
        ],
      }),
      'utf8',
    );
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('catalog.list', {})) as {
      entries?: unknown[];
      catalogPath?: string;
      ok?: boolean;
    };
    expect(result.entries).toBeDefined();
    expect(result.entries?.length).toBe(1);
    expect(result.catalogPath).toContain('catalog.json');
  });

  it('gibt ok:false + code "invalid-catalog" bei korruptem catalog.json (KEIN File-Path-Leak)', async () => {
    writeFileSync(join(tmpRoot, 'config', 'catalog.json'), '{this is not valid json', 'utf8');
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('catalog.list', {})) as {
      ok?: boolean;
      code?: string;
      catalogPath?: string;
      entries?: unknown[];
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid-catalog');
    // Critical: kein File-Path im response.
    expect(result.catalogPath).toBeUndefined();
    expect(result.entries).toBeUndefined();
  });

  it('gibt ok:false bei schema-mismatch catalog.json (kein Detail-Leak)', async () => {
    writeFileSync(
      join(tmpRoot, 'config', 'catalog.json'),
      JSON.stringify({ version: 1, entries: [{ id: '!?invalid id chars' }] }),
      'utf8',
    );
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('catalog.list', {})) as {
      ok?: boolean;
      code?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid-catalog');
  });
});
