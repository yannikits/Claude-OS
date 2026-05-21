/**
 * C2 (2026-05-21 code-review): Tests for `inbox.import` RPC — path-
 * traversal + symlink-exfil protection.
 *
 * Reproduces:
 *  - happy path: copy a normal file from outside the deny-list works.
 *  - non-array params throws.
 *  - non-string path entry throws.
 *  - non-existent src throws.
 *  - symlink src is REJECTED (kein follow → kein exfil).
 *  - deny-root src (e.g. machine.dataDir, home/.claude, root) is REJECTED.
 *  - directory src is REJECTED.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { symlink as fspSymlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

describe('inbox.import RPC — C2 path-traversal/symlink-exfil-Schutz', () => {
  let tmpRoot: string; // cloud-mount root
  let tmpData: string; // machine dataDir parent
  let tmpHome: string; // fake $HOME
  let tmpOutside: string; // source files that should be ALLOWED
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-inbox-root-'));
    tmpData = mkdtempSync(join(tmpdir(), 'claude-os-inbox-data-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'claude-os-inbox-home-'));
    tmpOutside = mkdtempSync(join(tmpdir(), 'claude-os-inbox-outside-'));
    mkdirSync(join(tmpData, 'data'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    envBackup = { ...process.env };
    process.env.CLAUDE_OS_ROOT = tmpRoot;
    process.env.CLAUDE_OS_DATA_DIR = tmpData;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpOutside, { recursive: true, force: true });
    process.env = envBackup;
  });

  async function call(paths: unknown): Promise<unknown> {
    const d = new RpcDispatcher();
    registerMethods(d, { env: process.env, home: tmpHome });
    return await d.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'inbox.import', params: { paths } }),
    );
  }

  function getResult(response: unknown): Record<string, unknown> {
    return (response as { result: Record<string, unknown> }).result;
  }

  function getError(response: unknown): { code: number; message: string } | undefined {
    return (response as { error?: { code: number; message: string } }).error;
  }

  it('happy path: copy normales File aus erlaubtem Source', async () => {
    const srcFile = join(tmpOutside, 'note.md');
    writeFileSync(srcFile, '# Hello inbox\n');

    const response = await call([srcFile]);
    const result = getResult(response);
    expect(result.count).toBe(1);
    expect(Array.isArray(result.paths)).toBe(true);
    const inboxFiles = readdirSync(join(tmpRoot, 'inbox'));
    expect(inboxFiles.length).toBe(1);
    expect(inboxFiles[0]).toMatch(/-note\.md$/);
  });

  it('non-array params.paths wirft Fehler', async () => {
    const err = getError(await call('not-an-array'));
    expect(err?.message).toMatch(/paths must be a string\[\]/);
  });

  it('non-string path entry wirft Fehler', async () => {
    const err = getError(await call([123]));
    expect(err?.message).toMatch(/each path must be a non-empty string/);
  });

  it('non-existent src wirft Fehler', async () => {
    const err = getError(await call([join(tmpOutside, 'missing.md')]));
    expect(err?.message).toMatch(/cannot stat/);
  });

  it('symlink src wird abgelehnt (kein follow → kein exfil)', async () => {
    // Build sensitive target: simulated credential file under tmpHome/.claude
    const credsDir = join(tmpHome, '.claude');
    mkdirSync(credsDir, { recursive: true });
    const credsFile = join(credsDir, '.credentials.json');
    writeFileSync(credsFile, '{"secret":"NEVER_EXFIL_ME"}');
    // Build a symlink in tmpOutside pointing to the credential file.
    const symlinkPath = join(tmpOutside, 'innocent-looking.md');
    try {
      await fspSymlink(credsFile, symlinkPath, 'file');
    } catch (err) {
      // Skip on platforms where symlink creation needs elevated perms (Windows non-admin).
      // The fix is still tested via the deny-root case below.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return;
      throw err;
    }

    const err = getError(await call([symlinkPath]));
    expect(err?.message).toMatch(/refusing to copy symlink/);
    // Verify credential bytes did NOT land in inbox.
    const inboxFiles = existsSync(join(tmpRoot, 'inbox'))
      ? readdirSync(join(tmpRoot, 'inbox'))
      : [];
    expect(inboxFiles).toEqual([]);
  });

  it('deny-root: Pfad unter home/.claude wird abgelehnt', async () => {
    const credsDir = join(tmpHome, '.claude');
    mkdirSync(credsDir, { recursive: true });
    const credsFile = join(credsDir, '.credentials.json');
    writeFileSync(credsFile, '{"secret":"NEVER_EXFIL_ME"}');

    const err = getError(await call([credsFile]));
    expect(err?.message).toMatch(/refusing to copy from sensitive root/);
  });

  it('deny-root: Pfad unter machine.dataDir wird abgelehnt', async () => {
    const secretsFile = join(tmpData, 'data', 'secrets.enc');
    writeFileSync(secretsFile, 'fake encrypted secrets');

    const err = getError(await call([secretsFile]));
    expect(err?.message).toMatch(/refusing to copy from sensitive root/);
  });

  it('deny-root: Pfad unter cloud-mount root selbst wird abgelehnt (recursion-Schutz)', async () => {
    const innerFile = join(tmpRoot, 'vault', 'some.md');
    mkdirSync(join(tmpRoot, 'vault'), { recursive: true });
    writeFileSync(innerFile, '# inner\n');

    const err = getError(await call([innerFile]));
    expect(err?.message).toMatch(/refusing to copy from sensitive root/);
  });

  it('directory src wird abgelehnt (nur regular files)', async () => {
    const subdir = join(tmpOutside, 'dir');
    mkdirSync(subdir);
    const err = getError(await call([subdir]));
    expect(err?.message).toMatch(/not a regular file/);
  });

  it('multiple paths: partial-state — guter src wird kopiert BEVOR bad src mid-loop wirft', async () => {
    const goodFile = join(tmpOutside, 'good.md');
    writeFileSync(goodFile, '# good\n');
    const credsDir = join(tmpHome, '.claude');
    mkdirSync(credsDir, { recursive: true });
    const credsFile = join(credsDir, '.credentials.json');
    writeFileSync(credsFile, '{}');

    const err = getError(await call([goodFile, credsFile]));
    expect(err?.message).toMatch(/refusing to copy from sensitive root/);
    // Codex-Round-2 finding documented: partial-state EXPECTED (kein
    // transactional rollback). Goodfile landet im inbox, credsfile
    // bleibt aussen vor.
    const inboxFiles = readdirSync(join(tmpRoot, 'inbox'));
    expect(inboxFiles.length).toBe(1);
    expect(inboxFiles[0]).toMatch(/-good\.md$/);
    // credentials waren NIE im inbox.
    expect(inboxFiles.some((f) => f.includes('credentials'))).toBe(false);
  });

  it('Codex-Round-2: per-file counter im stamp verhindert basename-collision', async () => {
    const dirA = join(tmpOutside, 'a');
    const dirB = join(tmpOutside, 'b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    const fileA = join(dirA, 'note.md');
    const fileB = join(dirB, 'note.md');
    writeFileSync(fileA, '# A\n');
    writeFileSync(fileB, '# B\n');

    const response = await call([fileA, fileB]);
    const result = getResult(response);
    expect(result.count).toBe(2);
    const inboxFiles = readdirSync(join(tmpRoot, 'inbox')).sort();
    expect(inboxFiles.length).toBe(2);
    // Filenames muessen unique sein — verifying via -1- + -2- counter prefix
    expect(inboxFiles.some((f) => f.includes('-1-note.md'))).toBe(true);
    expect(inboxFiles.some((f) => f.includes('-2-note.md'))).toBe(true);
  });
});
