import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type NoteFrontmatter, writeNote } from '../../src/domains/notes/index.js';
import { MemoryIndexService } from '../../src/sidecar/memory-index-service.js';

const fm = (overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
  ...overrides,
});

describe('MemoryIndexService', () => {
  let vault: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    vault = mkdtempSync(join(tmpdir(), 'mi-svc-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    process.env = envBackup;
  });

  it('stays disabled when CLAUDE_OS_VAULT_PATH is unset', async () => {
    delete process.env.CLAUDE_OS_VAULT_PATH;
    const svc = new MemoryIndexService({ skipBootRebuild: true });
    await svc.start();
    const stats = svc.getStats();
    expect(stats.enabled).toBe(false);
    expect(stats.disabledReason).toMatch(/CLAUDE_OS_VAULT_PATH/);
    expect(svc.getDb()).toBeNull();
    await svc.stop();
  });

  it('boots with empty vault: enabled, fresh DB, no rebuild needed', async () => {
    process.env.CLAUDE_OS_VAULT_PATH = vault;
    const svc = new MemoryIndexService({ skipBootRebuild: true });
    await svc.start();
    const stats = svc.getStats();
    expect(stats.enabled).toBe(true);
    expect(stats.vaultPath).toBe(vault);
    expect(stats.index?.opened).toBe(true);
    expect(stats.index?.documentsRowCount).toBe(0);
    expect(svc.getDb()).not.toBeNull();
    await svc.stop();
  });

  it('runs initial rebuildAll when DB is fresh and notes exist', async () => {
    process.env.CLAUDE_OS_VAULT_PATH = vault;
    writeNote(vault, 'personal', 'a.md', fm(), 'note A');
    writeNote(vault, 'personal', 'b.md', fm(), 'note B');
    const svc = new MemoryIndexService();
    await svc.start();
    const stats = svc.getStats();
    expect(stats.index?.documentsRowCount).toBe(2);
    expect(stats.lastRebuild?.indexed).toBe(2);
    expect(stats.lastRebuild?.totalScanned).toBe(2);
    await svc.stop();
  });

  it('rebuild() re-walks the vault and updates lastRebuild', async () => {
    process.env.CLAUDE_OS_VAULT_PATH = vault;
    const svc = new MemoryIndexService({ skipBootRebuild: true });
    await svc.start();
    writeNote(vault, 'personal', 'a.md', fm(), 'A');
    const stats = svc.rebuild();
    expect(stats.indexed).toBe(1);
    expect(svc.getStats().lastRebuild?.indexed).toBe(1);
    await svc.stop();
  });

  it('rebuild() throws when service is disabled', async () => {
    delete process.env.CLAUDE_OS_VAULT_PATH;
    const svc = new MemoryIndexService({ skipBootRebuild: true });
    await svc.start();
    expect(() => svc.rebuild()).toThrow(/disabled/);
    await svc.stop();
  });

  it('persists the DB on stop()', async () => {
    process.env.CLAUDE_OS_VAULT_PATH = vault;
    writeNote(vault, 'personal', 'a.md', fm(), 'A');
    const first = new MemoryIndexService();
    await first.start();
    expect(first.getStats().index?.documentsRowCount).toBe(1);
    await first.stop();

    // Boot a second service against the same vault — it should re-load
    // the row from disk without needing rebuildAll (skip it explicitly).
    const second = new MemoryIndexService({ skipBootRebuild: true });
    await second.start();
    expect(second.getStats().index?.documentsRowCount).toBe(1);
    await second.stop();
  });
});

describe('MemoryIndexService disabled-mode', () => {
  it('disabledReason includes openIndex failure when DB is corrupt', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'mi-svc-corrupt-'));
    try {
      // Pre-create a corrupted .db file so openIndex throws.
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(vault, '.claude-os'), { recursive: true });
      writeFileSync(join(vault, '.claude-os', 'index.db'), 'not a sqlite file');
      const oldEnv = process.env.CLAUDE_OS_VAULT_PATH;
      process.env.CLAUDE_OS_VAULT_PATH = vault;
      try {
        const svc = new MemoryIndexService({ skipBootRebuild: true });
        await svc.start();
        const stats = svc.getStats();
        expect(stats.enabled).toBe(false);
        expect(stats.disabledReason).toMatch(/openIndex failed/);
        await svc.stop();
      } finally {
        if (oldEnv === undefined) delete process.env.CLAUDE_OS_VAULT_PATH;
        else process.env.CLAUDE_OS_VAULT_PATH = oldEnv;
      }
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
