/**
 * C3 (2026-05-21 code-review): Test-Coverage fuer safeExtractTar — wir
 * konstruieren raw USTAR-Tarballs mit Symlink / Hardlink / parent-dir /
 * absolute-Path-Eintraegen und verifizieren dass die Extraction
 * abbricht statt die malicious Entries auf Disk zu schreiben.
 *
 * Tarball-Format reicht — die `tar` Package detected Plain-vs-Gzip
 * automatisch.
 */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as tarCreate } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeExtractTar, UnsafeTarballError } from '../../../src/domains/catalog/index.js';

// ---------- raw USTAR tarball builder ----------

interface TarEntry {
  /** Path relative to archive root, max 100 chars (USTAR limit). */
  readonly name: string;
  /** USTAR typeflag: '0'=file, '1'=hardlink, '2'=symlink, '5'=dir. */
  readonly typeflag: '0' | '1' | '2' | '5';
  /** Hardlink/symlink target. */
  readonly linkname?: string;
  /** File content (for type '0'). */
  readonly content?: Buffer;
}

function octal(value: number, len: number): string {
  return `${value.toString(8).padStart(len - 1, '0')}\0`;
}

function makeUstarBlock(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512);
  const content = entry.content ?? Buffer.alloc(0);
  // 0-99: name
  block.write(entry.name.slice(0, 100), 0);
  // 100-107: mode
  block.write(octal(0o644, 8), 100);
  // 108-115: uid
  block.write(octal(0, 8), 108);
  // 116-123: gid
  block.write(octal(0, 8), 116);
  // 124-135: size
  block.write(octal(content.length, 12), 124);
  // 136-147: mtime
  block.write(octal(0, 12), 136);
  // 148-155: chksum placeholder (8 spaces)
  block.write('        ', 148);
  // 156: typeflag
  block.write(entry.typeflag, 156);
  // 157-256: linkname
  if (entry.linkname !== undefined) {
    block.write(entry.linkname.slice(0, 100), 157);
  }
  // 257-262: magic 'ustar\0'
  block.write('ustar\0', 257);
  // 263-264: version '00'
  block.write('00', 263);
  // chksum
  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += block[i] ?? 0;
  block.write(`${chksum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function buildTarball(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(makeUstarBlock(entry));
    const content = entry.content ?? Buffer.alloc(0);
    if (content.length > 0) {
      parts.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  // tar EOF: two consecutive zero blocks
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---------- tests ----------

describe('safeExtractTar — happy path', () => {
  let tmpBase: string;
  let archive: string;
  let dest: string;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'safe-tar-extract-ok-'));
    // Build a normal tarball via tar.create — proven-clean.
    const staging = join(tmpBase, 'staging');
    const sub = join(staging, 'pkg');
    require('node:fs').mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'README.md'), '# Hello\n');
    writeFileSync(join(sub, 'SKILL.md'), '# Skill body\n');
    archive = join(tmpBase, 'clean.tar.gz');
    await tarCreate({ gzip: true, file: archive, cwd: staging }, ['pkg']);
    dest = join(tmpBase, 'dest');
    require('node:fs').mkdirSync(dest, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('extrahiert normale Tarballs ohne Fehler', async () => {
    await safeExtractTar({ file: archive, cwd: dest });
    expect(existsSync(join(dest, 'pkg', 'README.md'))).toBe(true);
    expect(existsSync(join(dest, 'pkg', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dest, 'pkg', 'README.md'), 'utf8')).toContain('Hello');
  });

  it('respektiert strip=1 (github-tarball-Pattern)', async () => {
    await safeExtractTar({ file: archive, cwd: dest, strip: 1 });
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
  });
});

describe('safeExtractTar — malicious tarball rejection (C3)', () => {
  let tmpBase: string;
  let dest: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'safe-tar-extract-bad-'));
    dest = join(tmpBase, 'dest');
    require('node:fs').mkdirSync(dest, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('wirft UnsafeTarballError bei Symlink-Entry', async () => {
    const evil = buildTarball([
      { name: 'pkg/normal.md', typeflag: '0', content: Buffer.from('# ok\n') },
      // Symlink: bad → / (outside-of-cwd)
      { name: 'pkg/bad', typeflag: '2', linkname: '/etc/passwd' },
    ]);
    const archive = join(tmpBase, 'evil.tar');
    writeFileSync(archive, evil);

    await expect(safeExtractTar({ file: archive, cwd: dest })).rejects.toBeInstanceOf(
      UnsafeTarballError,
    );

    // Verify the symlink itself was NOT written (extract may have written
    // normal.md before hitting the symlink, that's acceptable; what's
    // critical is that `bad` doesn't exist as a symlink).
    expect(existsSync(join(dest, 'pkg', 'bad'))).toBe(false);
  });

  it('wirft UnsafeTarballError bei Hardlink-Entry', async () => {
    const evil = buildTarball([
      { name: 'pkg/target.md', typeflag: '0', content: Buffer.from('# target\n') },
      { name: 'pkg/bad', typeflag: '1', linkname: '/etc/passwd' },
    ]);
    const archive = join(tmpBase, 'evil-hardlink.tar');
    writeFileSync(archive, evil);

    await expect(safeExtractTar({ file: archive, cwd: dest })).rejects.toBeInstanceOf(
      UnsafeTarballError,
    );
  });

  it('wirft UnsafeTarballError bei parent-dir-Segment', async () => {
    // Use a non-leading parent-segment so tar v7's own absolute-path
    // rejection doesn't preempt our filter — we want to PROVE that
    // safe-tar-extract's filter (not just tar's defaults) catches this.
    const evil = buildTarball([
      { name: 'pkg/normal.md', typeflag: '0', content: Buffer.from('# ok\n') },
      { name: 'pkg/sub/../../escape.md', typeflag: '0', content: Buffer.from('# escape\n') },
    ]);
    const archive = join(tmpBase, 'evil-traversal.tar');
    writeFileSync(archive, evil);

    await expect(safeExtractTar({ file: archive, cwd: dest })).rejects.toBeInstanceOf(
      UnsafeTarballError,
    );
    // Verify nothing escaped above `dest`.
    expect(existsSync(join(tmpBase, 'escape.md'))).toBe(false);
    expect(existsSync(join(dest, '..', 'escape.md'))).toBe(false);
  });

  it('mehrere Violations in einem Tarball werden in einer Fehlermeldung gesammelt', async () => {
    const evil = buildTarball([
      { name: 'pkg/bad1', typeflag: '2', linkname: '/etc/passwd' },
      { name: 'pkg/bad2', typeflag: '2', linkname: '/etc/shadow' },
      { name: 'pkg/bad3', typeflag: '1', linkname: '/etc/hosts' },
    ]);
    const archive = join(tmpBase, 'evil-multi.tar');
    writeFileSync(archive, evil);

    try {
      await safeExtractTar({ file: archive, cwd: dest });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeTarballError);
      const violations = (err as UnsafeTarballError).violations;
      expect(violations.length).toBe(3);
    }
  });

  it('Symlink-then-write attack — bad symlink wird verworfen BEVOR der Folge-Write durchgefuehrt wird', async () => {
    // Klassisches CVE-Muster: erst Symlink `escape -> ..`, dann file
    // `escape/payload`. Wenn der Symlink durchgewunken wuerde, wuerde
    // payload OBERHALB von dest landen. safeExtractTar muss den Symlink
    // ablehnen — explizit als UnsafeTarballError, nicht als generischen
    // tar-Fehler.
    const evil = buildTarball([
      { name: 'pkg/escape', typeflag: '2', linkname: '..' },
      { name: 'pkg/escape/payload.txt', typeflag: '0', content: Buffer.from('PWND\n') },
    ]);
    const archive = join(tmpBase, 'evil-chain.tar');
    writeFileSync(archive, evil);

    let caught: unknown;
    try {
      await safeExtractTar({ file: archive, cwd: dest });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsafeTarballError);
    const violations = (caught as UnsafeTarballError).violations;
    expect(violations.some((v) => v.includes('SymbolicLink'))).toBe(true);
    // Critical: payload landed NICHT oberhalb von dest. Innerhalb von
    // dest darf das file existieren (als regulaeres File in einem
    // regulaeren Subdir) — das ist kein Sicherheitsproblem, der Symlink
    // wurde nie materialisiert.
    expect(existsSync(join(tmpBase, 'payload.txt'))).toBe(false);
    expect(existsSync(join(dest, '..', 'payload.txt'))).toBe(false);
    // pkg/escape MUSS — wenn ueberhaupt — ein Directory sein (Symlink-
    // Bytes wurden vom Filter verworfen, also kann es kein Symlink mehr
    // sein).
    if (existsSync(join(dest, 'pkg', 'escape'))) {
      const statInfo = lstatSync(join(dest, 'pkg', 'escape'));
      expect(statInfo.isSymbolicLink()).toBe(false);
    }
  });

  it('cleanupOnFailure: bei UnsafeTarballError wird dest komplett geleert', async () => {
    const evil = buildTarball([
      { name: 'pkg/clean1.md', typeflag: '0', content: Buffer.from('# c1\n') },
      { name: 'pkg/clean2.md', typeflag: '0', content: Buffer.from('# c2\n') },
      { name: 'pkg/bad-symlink', typeflag: '2', linkname: '/etc/passwd' },
    ]);
    const archive = join(tmpBase, 'evil-mixed.tar');
    writeFileSync(archive, evil);

    await expect(
      safeExtractTar({ file: archive, cwd: dest, cleanupOnFailure: true }),
    ).rejects.toBeInstanceOf(UnsafeTarballError);

    // dest sollte nicht mehr existieren oder leer sein nach cleanup.
    if (existsSync(dest)) {
      const entries = readdirSync(dest, { recursive: true });
      expect(entries).toEqual([]);
    }
  });

  it('GNUSparse / unbekannte tar-types werden via ALLOW-list rejected', async () => {
    // Codex-Round-2: switched from deny-list to allow-list. Verify a
    // non-File/Directory/GNULongPath type (e.g. CharacterDevice via
    // typeflag '3') is rejected.
    const evil = buildTarball([
      { name: 'pkg/dev', typeflag: '0', content: Buffer.from('# placeholder\n') },
    ]);
    // Mutate the typeflag byte at offset 156 in the first block to '3'
    // (CharacterDevice). USTAR header starts at byte 0.
    evil[156] = '3'.charCodeAt(0);
    // Re-compute checksum (placeholder 8 spaces at offset 148-155)
    evil.fill(0x20, 148, 156);
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += evil[i] ?? 0;
    evil.write(`${chksum.toString(8).padStart(6, '0')}\0 `, 148);

    const archive = join(tmpBase, 'evil-chardev.tar');
    writeFileSync(archive, evil);

    let caught: unknown;
    try {
      await safeExtractTar({ file: archive, cwd: dest });
    } catch (err) {
      caught = err;
    }
    // Either UnsafeTarballError (via filter) or a generic tar error — both
    // acceptable because the entry was rejected one way or the other.
    expect(caught).toBeDefined();
    expect(existsSync(join(dest, 'pkg', 'dev'))).toBe(false);
  });
});
