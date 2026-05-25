import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIndex, rebuildAll } from '../../../src/domains/memory-index/index.js';
import { type NoteFrontmatter, writeNote } from '../../../src/domains/notes/index.js';
import { searchWithFallback } from '../../../src/domains/retrieval/index.js';

const fm = (overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
  ...overrides,
});

describe('searchWithFallback', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'rd-disp-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('uses FTS path when db is provided and works', async () => {
    writeNote(vault, 'personal', 'a.md', fm(), 'kubernetes deployments');
    const opened = await openIndex({ vaultRoot: vault });
    rebuildAll(opened.db, vault);

    const r = searchWithFallback({
      vaultRoot: vault,
      workspaceId: 'personal',
      query: { text: 'kubernetes' },
      db: opened.db,
    });
    expect(r.kind).toBe('fts');
    expect(r.hits.length).toBe(1);
    opened.db.close();
  });

  it('uses linear-scan when db is null', () => {
    writeNote(vault, 'personal', 'a.md', fm(), 'kubernetes deployments');
    const r = searchWithFallback({
      vaultRoot: vault,
      workspaceId: 'personal',
      query: { text: 'kubernetes' },
      db: null,
    });
    expect(r.kind).toBe('linear-scan');
    expect(r.hits.length).toBe(1);
  });

  it('falls back to linear-scan when FTS throws + logs reason', async () => {
    writeNote(vault, 'personal', 'a.md', fm(), 'kubernetes deployments');
    const opened = await openIndex({ vaultRoot: vault });
    rebuildAll(opened.db, vault);
    // Drop the FTS table to simulate corruption — searchIndex will
    // throw on the JOIN against documents_fts.
    opened.db.exec('DROP TABLE documents_fts;');

    const messages: string[] = [];
    const r = searchWithFallback({
      vaultRoot: vault,
      workspaceId: 'personal',
      query: { text: 'kubernetes' },
      db: opened.db,
      log: (level, msg) => messages.push(`${level}: ${msg}`),
    });
    expect(r.kind).toBe('linear-scan');
    expect(r.hits.length).toBe(1); // linear-scan still finds it via on-disk read
    expect(r.fallbackReason).toBeDefined();
    expect(messages.some((m) => m.startsWith('warn: FTS search failed'))).toBe(true);
    opened.db.close();
  });
});
