import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureIndexDir,
  getIndexStats,
  IndexCorruptError,
  MEMORY_INDEX_SCHEMA_VERSION,
  MemoryIndexError,
  openIndex,
  resolveIndexDbPath,
  saveIndex,
} from '../../../src/domains/memory-index/index.js';

describe('openIndex', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'mi-db-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('creates a fresh DB when none exists', async () => {
    const opened = await openIndex({ vaultRoot: vault });
    expect(opened.fresh).toBe(true);
    expect(opened.rebuilt).toBe(false);
    expect(opened.dbPath.replace(/\\/g, '/')).toBe(
      `${vault.replace(/\\/g, '/')}/.claude-os/index.db`,
    );
    // Schema-version row stamped.
    const stmt = opened.db.prepare('SELECT value FROM meta WHERE key=$k;');
    stmt.bind({ $k: 'schema_version' });
    expect(stmt.step()).toBe(true);
    expect(stmt.get()[0]).toBe(String(MEMORY_INDEX_SCHEMA_VERSION));
    stmt.free();
    opened.db.close();
  });

  it('re-opens an existing DB without rebuild', async () => {
    const first = await openIndex({ vaultRoot: vault });
    first.db.run(
      `INSERT INTO documents(path, workspace, classification, frontmatter_json, body, mtime_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['/a.md', 'personal', 'personal', '{}', 'hello', 12345],
    );
    ensureIndexDir(vault);
    saveIndex(first.db, first.dbPath);
    first.db.close();

    const second = await openIndex({ vaultRoot: vault });
    expect(second.fresh).toBe(false);
    expect(second.rebuilt).toBe(false);
    const stats = getIndexStats(second.db, second.dbPath);
    expect(stats.documentsRowCount).toBe(1);
    second.db.close();
  });

  it('documents_fts is queryable when populated alongside documents (manual upsert)', async () => {
    const opened = await openIndex({ vaultRoot: vault });
    opened.db.run(
      `INSERT INTO documents(path, workspace, classification, frontmatter_json, body, mtime_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['/n.md', 'personal', 'personal', '{}', 'kubernetes deployment notes', 1],
    );
    // v1: indexer (Phase 3b) maintains both tables explicitly — no trigger
    // sync because FTS4-content-link triggers don't fit the sql.js shape we
    // settled on (see schema.ts deviation-note).
    opened.db.run(
      'INSERT INTO documents_fts(rowid, body) SELECT rowid, body FROM documents WHERE path=?',
      ['/n.md'],
    );
    const stmt = opened.db.prepare(
      "SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'kubernetes';",
    );
    expect(stmt.step()).toBe(true);
    stmt.free();
    opened.db.close();
  });

  it('rebuilds on schema-version drift when autoRebuildOnSchemaDrift is default-true', async () => {
    const first = await openIndex({ vaultRoot: vault });
    // Simulate a stale schema by overwriting the meta row.
    first.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '999');");
    first.db.run(
      `INSERT INTO documents(path, workspace, classification, frontmatter_json, body, mtime_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['/old.md', 'personal', 'personal', '{}', 'old body', 1],
    );
    saveIndex(first.db, first.dbPath);
    first.db.close();

    const second = await openIndex({ vaultRoot: vault });
    expect(second.rebuilt).toBe(true);
    expect(second.fresh).toBe(true);
    expect(getIndexStats(second.db, second.dbPath).documentsRowCount).toBe(0);
    second.db.close();
  });

  it('throws when autoRebuildOnSchemaDrift=false on stale schema', async () => {
    const first = await openIndex({ vaultRoot: vault });
    first.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '999');");
    saveIndex(first.db, first.dbPath);
    first.db.close();

    await expect(openIndex({ vaultRoot: vault, autoRebuildOnSchemaDrift: false })).rejects.toThrow(
      MemoryIndexError,
    );
  });

  it('throws IndexCorruptError on garbage on-disk bytes', async () => {
    ensureIndexDir(vault);
    writeFileSync(resolveIndexDbPath(vault), 'this is definitely not a sqlite file');
    await expect(openIndex({ vaultRoot: vault })).rejects.toThrow(IndexCorruptError);
  });
});

describe('saveIndex', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'mi-save-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('writes atomically via tempfile+rename and leaves no .tmp leftover', async () => {
    const opened = await openIndex({ vaultRoot: vault });
    opened.db.run(
      `INSERT INTO documents(path, workspace, classification, frontmatter_json, body, mtime_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['/save.md', 'personal', 'personal', '{}', 'persisted', 1],
    );
    saveIndex(opened.db, opened.dbPath);
    expect(existsSync(opened.dbPath)).toBe(true);
    expect(readFileSync(opened.dbPath).length).toBeGreaterThan(0);
    opened.db.close();
  });
});

describe('getIndexStats', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'mi-stats-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('returns opened=false when db is null', () => {
    const stats = getIndexStats(null, resolveIndexDbPath(vault));
    expect(stats.opened).toBe(false);
    expect(stats.documentsRowCount).toBe(0);
  });

  it('counts rows correctly', async () => {
    const opened = await openIndex({ vaultRoot: vault });
    for (let i = 0; i < 3; i++) {
      opened.db.run(
        `INSERT INTO documents(path, workspace, classification, frontmatter_json, body, mtime_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`/n${i}.md`, 'personal', 'personal', '{}', `body ${i}`, i],
      );
    }
    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(3);
    opened.db.close();
  });
});
