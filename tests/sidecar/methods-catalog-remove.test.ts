import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

let tmpRoot: string;
let envBackup: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-cat-rm-'));
  writeFileSync(join(tmpRoot, '.claude-os-root'), '');
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'config', 'catalog.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'remove-me',
          kind: 'plugin',
          source: 'github:test/repo',
          enabled: true,
          scope: 'user',
        },
      ],
    }),
    'utf8',
  );
  envBackup = { ...process.env };
  process.env.CLAUDE_OS_ROOT = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = envBackup;
});

describe('catalog.removeEntry RPC', () => {
  it('entfernt einen existing Entry und gibt ok:true + removedEntry zurueck', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('catalog.removeEntry', { id: 'remove-me' })) as {
      ok: boolean;
      removedEntry?: { id: string; kind: string };
    };
    expect(result.ok).toBe(true);
    expect(result.removedEntry?.id).toBe('remove-me');
    expect(result.removedEntry?.kind).toBe('plugin');
  });

  it('gibt ok:false + unknown-id-Code fuer unknown id', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('catalog.removeEntry', { id: 'not-there' })) as {
      ok: boolean;
      code?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown-id');
  });

  it('wirft bei leerem oder fehlendem id', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    await expect(d.invoke('catalog.removeEntry', { id: '' })).rejects.toThrow(/non-empty string/);
    await expect(d.invoke('catalog.removeEntry', {})).rejects.toThrow(/non-empty string/);
  });
});
