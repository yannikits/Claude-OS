/**
 * Phase 3f — RPC tests for memory.* methods (memory-index FTS lifecycle).
 *
 * Renamed from methods-memory.test.ts to avoid filename collision with
 * the Phase-2f tests for workspace.* / notes.* / retrieval.* RPCs that
 * live at that path on main. Both suites coexist now.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type NoteFrontmatter, writeNote } from '../../src/domains/notes/index.js';
import { MemoryIndexService } from '../../src/sidecar/memory-index-service.js';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

const fm = (overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
  ...overrides,
});

interface SetupResult {
  vault: string;
  envBackup: NodeJS.ProcessEnv;
  svc: MemoryIndexService;
  dispatcher: RpcDispatcher;
}

async function setup(): Promise<SetupResult> {
  const envBackup = { ...process.env };
  const vault = mkdtempSync(join(tmpdir(), 'cos-mem-svc-'));
  process.env.CLAUDE_OS_VAULT_PATH = vault;

  const svc = new MemoryIndexService({ skipBootRebuild: true });
  await svc.start();

  const dispatcher = new RpcDispatcher();
  registerMethods(dispatcher, { memoryIndex: svc });
  return { vault, envBackup, svc, dispatcher };
}

function cleanup(r: SetupResult): void {
  rmSync(r.vault, { recursive: true, force: true });
  process.env = r.envBackup;
}

describe('memory.* RPCs', () => {
  let r: SetupResult;

  beforeEach(async () => {
    r = await setup();
  });

  afterEach(async () => {
    await r.svc.stop();
    cleanup(r);
  });

  it('memory.stats returns enabled=true after successful boot', async () => {
    const stats = (await r.dispatcher.invoke('memory.stats', {})) as {
      enabled: boolean;
      vaultPath?: string;
      index?: { documentsRowCount: number };
    };
    expect(stats.enabled).toBe(true);
    expect(stats.vaultPath).toBe(r.vault);
    expect(stats.index?.documentsRowCount).toBe(0);
  });

  it('memory.rebuild walks the vault + updates stats', async () => {
    writeNote(r.vault, 'personal', 'a.md', fm(), 'note A');
    writeNote(r.vault, 'personal', 'b.md', fm(), 'note B');
    const stats = (await r.dispatcher.invoke('memory.rebuild', {})) as {
      indexed: number;
      totalScanned: number;
    };
    expect(stats.indexed).toBe(2);
    expect(stats.totalScanned).toBe(2);

    const after = (await r.dispatcher.invoke('memory.stats', {})) as {
      index?: { documentsRowCount: number };
      lastRebuild?: { indexed: number };
    };
    expect(after.index?.documentsRowCount).toBe(2);
    expect(after.lastRebuild?.indexed).toBe(2);
  });
});

describe('memory.* RPCs in disabled-mode', () => {
  it('memory.stats returns enabled=false when service has no vault', async () => {
    const envBackup = { ...process.env };
    delete process.env.CLAUDE_OS_VAULT_PATH;
    const svc = new MemoryIndexService({ skipBootRebuild: true });
    await svc.start();
    const d = new RpcDispatcher();
    registerMethods(d, { memoryIndex: svc });
    try {
      const stats = (await d.invoke('memory.stats', {})) as {
        enabled: boolean;
        disabledReason?: string;
      };
      expect(stats.enabled).toBe(false);
      expect(stats.disabledReason).toMatch(/CLAUDE_OS_VAULT_PATH/);
    } finally {
      await svc.stop();
      process.env = envBackup;
    }
  });

  it('memory.rebuild throws when service is disabled', async () => {
    const envBackup = { ...process.env };
    delete process.env.CLAUDE_OS_VAULT_PATH;
    const svc = new MemoryIndexService({ skipBootRebuild: true });
    await svc.start();
    const d = new RpcDispatcher();
    registerMethods(d, { memoryIndex: svc });
    try {
      await expect(d.invoke('memory.rebuild', {})).rejects.toThrow(/disabled/);
    } finally {
      await svc.stop();
      process.env = envBackup;
    }
  });
});
