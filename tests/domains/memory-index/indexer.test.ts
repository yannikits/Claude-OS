import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getIndexedMtime,
  getIndexStats,
  indexNote,
  type OpenedIndex,
  openIndex,
  rebuildAll,
  removeNote,
  walkVaultNotes,
} from '../../../src/domains/memory-index/index.js';
import { type NoteFrontmatter, writeNote } from '../../../src/domains/notes/index.js';

const fm = (overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
  ...overrides,
});

describe('walkVaultNotes', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'mi-walk-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('returns [] for a fresh vault', () => {
    expect(walkVaultNotes(vault)).toEqual([]);
  });

  it('finds .md across workspaces', () => {
    writeNote(vault, 'personal', 'a.md', fm(), 'A');
    writeNote(vault, 'msp-internal', 'b.md', fm({ workspace: 'msp-internal' }), 'B');
    const paths = walkVaultNotes(vault)
      .map((p) => p.split(/[\\/]/).pop())
      .sort();
    expect(paths).toEqual(['a.md', 'b.md']);
  });

  it('skips dotfiles and non-md', () => {
    writeNote(vault, 'personal', 'n.md', fm(), 'X');
    const dir = join(vault, 'Claude-OS', 'workspaces', 'personal');
    writeFileSync(join(dir, '.hidden'), 'x');
    writeFileSync(join(dir, 'readme.txt'), 'x');
    const paths = walkVaultNotes(vault).map((p) => p.split(/[\\/]/).pop());
    expect(paths).toEqual(['n.md']);
  });
});

describe('indexNote + removeNote', () => {
  let vault: string;
  let opened: OpenedIndex;

  beforeEach(async () => {
    vault = mkdtempSync(join(tmpdir(), 'mi-idx-'));
    opened = await openIndex({ vaultRoot: vault });
  });

  afterEach(() => {
    opened.db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('upserts into both documents and documents_fts', () => {
    const written = writeNote(vault, 'personal', 'a.md', fm(), 'kubernetes notes');
    indexNote(opened.db, written.path, 1_000);

    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(1);

    // FTS hit confirms the row was mirrored into documents_fts.
    const stmt = opened.db.prepare(
      "SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'kubernetes';",
    );
    expect(stmt.step()).toBe(true);
    stmt.free();

    expect(getIndexedMtime(opened.db, written.path)).toBe(1_000);
  });

  it('overwrites existing row + keeps FTS in sync', () => {
    const wrote = writeNote(vault, 'personal', 'a.md', fm(), 'first body');
    indexNote(opened.db, wrote.path, 1_000);

    writeNote(vault, 'personal', 'a.md', fm(), 'replacement body about deployments', {
      overwrite: true,
    });
    indexNote(opened.db, wrote.path, 2_000);

    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(1);
    expect(getIndexedMtime(opened.db, wrote.path)).toBe(2_000);

    // Old term gone, new term present.
    const oldStmt = opened.db.prepare(
      "SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'first';",
    );
    expect(oldStmt.step()).toBe(false);
    oldStmt.free();

    const newStmt = opened.db.prepare(
      "SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'deployments';",
    );
    expect(newStmt.step()).toBe(true);
    newStmt.free();
  });

  it('removeNote returns true on hit, false on miss, and drops FTS row', () => {
    const wrote = writeNote(vault, 'personal', 'a.md', fm(), 'b');
    indexNote(opened.db, wrote.path, 1);

    expect(removeNote(opened.db, wrote.path)).toBe(true);
    expect(removeNote(opened.db, wrote.path)).toBe(false);
    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(0);
  });

  it('persists tenant + classification verbatim in documents', () => {
    const wrote = writeNote(
      vault,
      'msp-customers/acme',
      'tckt.md',
      fm({
        workspace: 'msp-customers/acme',
        classification: 'customer-confidential',
        tenant: 'acme',
      }),
      'body',
    );
    indexNote(opened.db, wrote.path, 1);

    const stmt = opened.db.prepare(
      'SELECT workspace, tenant, classification FROM documents WHERE path=?',
    );
    stmt.bind([wrote.path]);
    stmt.step();
    const row = stmt.get();
    expect(row[0]).toBe('msp-customers/acme');
    expect(row[1]).toBe('acme');
    expect(row[2]).toBe('customer-confidential');
    stmt.free();
  });
});

describe('rebuildAll', () => {
  let vault: string;
  let opened: OpenedIndex;

  beforeEach(async () => {
    vault = mkdtempSync(join(tmpdir(), 'mi-reb-'));
    opened = await openIndex({ vaultRoot: vault });
  });

  afterEach(() => {
    opened.db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('indexes everything on first run', () => {
    for (let i = 0; i < 5; i++) {
      writeNote(vault, 'personal', `n${i}.md`, fm(), `body ${i}`);
    }
    const stats = rebuildAll(opened.db, vault);
    expect(stats.indexed).toBe(5);
    expect(stats.skippedUnchanged).toBe(0);
    expect(stats.totalScanned).toBe(5);
    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(5);
  });

  it('is idempotent: second run skips unchanged notes', () => {
    writeNote(vault, 'personal', 'a.md', fm(), 'A');
    rebuildAll(opened.db, vault);
    const second = rebuildAll(opened.db, vault);
    expect(second.indexed).toBe(0);
    expect(second.skippedUnchanged).toBe(1);
  });

  it('re-indexes a touched file (mtime > indexed-mtime)', () => {
    const wrote = writeNote(vault, 'personal', 'a.md', fm(), 'A');
    rebuildAll(opened.db, vault);
    // Bump mtime to far-future so the indexer must re-pick.
    const future = new Date(Date.now() + 60_000);
    utimesSync(wrote.path, future, future);
    const second = rebuildAll(opened.db, vault);
    expect(second.indexed).toBe(1);
    expect(second.skippedUnchanged).toBe(0);
  });

  it('removes stale rows whose file vanished from disk', () => {
    const a = writeNote(vault, 'personal', 'a.md', fm(), 'A');
    writeNote(vault, 'personal', 'b.md', fm(), 'B');
    rebuildAll(opened.db, vault);
    rmSync(a.path);
    const stats = rebuildAll(opened.db, vault);
    expect(stats.removedStale).toBe(1);
    expect(getIndexStats(opened.db, opened.dbPath).documentsRowCount).toBe(1);
  });

  it('logs and counts malformed notes without aborting the batch', () => {
    const wrote = writeNote(vault, 'personal', 'ok.md', fm(), 'fine');
    // Hand-craft a broken note next to the good one.
    const dir = wrote.path.replace(/[\\/][^\\/]+$/, '');
    writeFileSync(join(dir, 'broken.md'), '---\nyaml: [unclosed\n---\nbody');

    const messages: string[] = [];
    const stats = rebuildAll(opened.db, vault, {
      log: (level, msg) => messages.push(`${level}: ${msg}`),
    });
    expect(stats.indexed).toBe(1);
    expect(stats.skippedMalformed).toBe(1);
    expect(messages.some((m) => m.includes('broken.md'))).toBe(true);
  });

  it('honours limit option (debug/testing)', () => {
    for (let i = 0; i < 10; i++) {
      writeNote(vault, 'personal', `n${i}.md`, fm(), `${i}`);
    }
    const stats = rebuildAll(opened.db, vault, { limit: 3 });
    expect(stats.indexed).toBe(3);
    expect(stats.totalScanned).toBe(10);
  });
});
