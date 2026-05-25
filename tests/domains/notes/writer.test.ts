import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FrontmatterValidationError,
  type NoteFrontmatter,
  NotesError,
  writeNote,
} from '../../../src/domains/notes/index.js';

const baseFm = (): NoteFrontmatter => ({
  workspace: 'personal',
  classification: 'personal',
  schema_version: 1,
});

describe('writeNote', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'notes-w-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('writes a new note and stamps created+updated', () => {
    const before = Date.now();
    const res = writeNote(vault, 'personal', 'first.md', baseFm(), '# Hello\n');
    expect(res.created).toBe(true);
    expect(res.path.replace(/\\/g, '/').endsWith('/personal/first.md')).toBe(true);
    expect(existsSync(res.path)).toBe(true);
    expect(res.frontmatter.created).toBeDefined();
    expect(res.frontmatter.updated).toBeDefined();
    // Sanity: stamp is an ISO-8601 string parsed back to a roughly-now Date.
    expect(new Date(res.frontmatter.created as string).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('refuses to overwrite by default', () => {
    writeNote(vault, 'personal', 'collide.md', baseFm(), 'first');
    expect(() => writeNote(vault, 'personal', 'collide.md', baseFm(), 'second')).toThrow(
      NotesError,
    );
  });

  it('overwrites when {overwrite: true}', () => {
    writeNote(vault, 'personal', 'overlap.md', baseFm(), 'first');
    const res = writeNote(vault, 'personal', 'overlap.md', baseFm(), 'second', {
      overwrite: true,
    });
    expect(res.created).toBe(false);
    expect(readFileSync(res.path, 'utf8')).toContain('second');
  });

  it('preserves the original created stamp on overwrite', () => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const first = writeNote(vault, 'personal', 'preserve.md', baseFm(), 'a', {
      nowIso: t1,
    });
    expect(first.frontmatter.created).toBe(t1);

    const t2 = '2026-12-12T12:12:12.000Z';
    // Manually keep the previous created field — caller pattern: read,
    // mutate body, write back. Simulate that by passing it explicitly.
    const second = writeNote(vault, 'personal', 'preserve.md', { ...baseFm(), created: t1 }, 'b', {
      overwrite: true,
      nowIso: t2,
    });
    expect(second.frontmatter.created).toBe(t1);
    expect(second.frontmatter.updated).toBe(t2);
  });

  it('forces frontmatter.workspace to match the call site', () => {
    const res = writeNote(
      vault,
      'personal',
      'pin.md',
      { ...baseFm(), workspace: 'msp-internal' },
      'body',
    );
    expect(res.frontmatter.workspace).toBe('personal');
  });

  it('rejects invalid classification', () => {
    expect(() =>
      writeNote(
        vault,
        'personal',
        'bad.md',
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
        { ...baseFm(), classification: 'TOP-SECRET' as any },
        'x',
      ),
    ).toThrow(FrontmatterValidationError);
  });

  it('rejects schema_version < 1', () => {
    expect(() =>
      writeNote(vault, 'personal', 'sv.md', { ...baseFm(), schema_version: 0 }, 'x'),
    ).toThrow(FrontmatterValidationError);
  });

  it('requires tenant when workspace is msp-customers/<id>', () => {
    const fm: NoteFrontmatter = {
      ...baseFm(),
      workspace: 'msp-customers/acme',
      classification: 'customer-confidential',
    };
    expect(() => writeNote(vault, 'msp-customers/acme', 'no-tenant.md', fm, 'x')).toThrow(/tenant/);

    const ok = writeNote(
      vault,
      'msp-customers/acme',
      'with-tenant.md',
      { ...fm, tenant: 'acme' },
      'x',
    );
    expect(ok.frontmatter.tenant).toBe('acme');
  });

  it('writes atomically via tempfile + rename (no .tmp leftover)', () => {
    writeNote(vault, 'personal', 'atomic.md', baseFm(), 'body');
    const dir = join(vault, 'Claude-OS', 'workspaces', 'personal');
    const leftover = readDir(dir).filter((n) => n.includes('.tmp-'));
    expect(leftover).toEqual([]);
  });
});

function readDir(d: string): string[] {
  return [...require('node:fs').readdirSync(d)];
}
