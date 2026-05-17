import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateGitMetadata } from '../../../src/core/git-metadata/index.js';

describe('migrateGitMetadata', () => {
  let tmpBase: string;
  let rootPath: string;
  let vaultDir: string;
  let targetParent: string;
  let externalGitDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-mig-'));
    rootPath = join(tmpBase, 'root');
    vaultDir = join(rootPath, 'vault');
    targetParent = join(tmpBase, 'machine-data', 'git-metadata');
    externalGitDir = join(targetParent, 'vault.git');
    mkdirSync(rootPath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  async function initVaultRepo(): Promise<void> {
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, 'README.md'), '# vault\n');
    await simpleGit(vaultDir).init();
  }

  it('returns not-needed when the work-tree does not exist', async () => {
    const result = await migrateGitMetadata({
      rootPath,
      externalGitDirOverride: externalGitDir,
    });
    expect(result.state).toBe('not-needed');
    expect(result.workTree).toBe(vaultDir);
    expect(result.externalGitDir).toBe(externalGitDir);
  });

  it('returns no-git-dir when vault exists but has no .git', async () => {
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, 'note.md'), 'hello');
    const result = await migrateGitMetadata({
      rootPath,
      externalGitDirOverride: externalGitDir,
    });
    expect(result.state).toBe('no-git-dir');
  });

  it('migrates a directory-form .git to the external target', async () => {
    await initVaultRepo();
    expect(statSync(join(vaultDir, '.git')).isDirectory()).toBe(true);

    const result = await migrateGitMetadata({
      rootPath,
      externalGitDirOverride: externalGitDir,
    });

    expect(result.state).toBe('migrated');
    expect(result.error).toBeUndefined();

    // Post-condition: .git is now a file pointing at externalGitDir.
    const dotGit = join(vaultDir, '.git');
    expect(statSync(dotGit).isFile()).toBe(true);
    const gitfileContent = readFileSync(dotGit, 'utf8');
    expect(gitfileContent).toMatch(/^gitdir:\s+.+/);

    // External target has the moved metadata.
    expect(existsSync(join(externalGitDir, 'HEAD'))).toBe(true);
    expect(existsSync(join(externalGitDir, 'objects'))).toBe(true);
  });

  it('is idempotent — second call reports already-migrated', async () => {
    await initVaultRepo();
    const first = await migrateGitMetadata({
      rootPath,
      externalGitDirOverride: externalGitDir,
    });
    expect(first.state).toBe('migrated');

    const second = await migrateGitMetadata({
      rootPath,
      externalGitDirOverride: externalGitDir,
    });
    expect(second.state).toBe('already-migrated');
    expect(second.error).toBeUndefined();
  });

  it('errors when an existing gitfile points to an unexpected target', async () => {
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, '.git'), 'gitdir: /some/other/place\n');
    const result = await migrateGitMetadata({
      rootPath,
      externalGitDirOverride: externalGitDir,
    });
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/Refusing to overwrite/);
  });

  it('errors when an existing gitfile is malformed', async () => {
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, '.git'), 'not a real gitfile\n');
    const result = await migrateGitMetadata({
      rootPath,
      externalGitDirOverride: externalGitDir,
    });
    expect(result.state).toBe('error');
    expect(result.message).toMatch(/no parseable "gitdir:" line/);
  });

  it('refuses to clobber a non-empty external target', async () => {
    await initVaultRepo();
    mkdirSync(externalGitDir, { recursive: true });
    writeFileSync(join(externalGitDir, 'sentinel'), 'pre-existing');
    const result = await migrateGitMetadata({
      rootPath,
      externalGitDirOverride: externalGitDir,
    });
    expect(result.state).toBe('error');
    expect(result.message).toMatch(/already exists and is non-empty/);
    // .git/ in the vault must remain intact (untouched).
    expect(statSync(join(vaultDir, '.git')).isDirectory()).toBe(true);
  });

  it('honours a custom workTreeName', async () => {
    const altWorkTree = join(rootPath, 'notes-vault');
    mkdirSync(altWorkTree, { recursive: true });
    await simpleGit(altWorkTree).init();
    const altTarget = join(targetParent, 'notes-vault.git');
    const result = await migrateGitMetadata({
      rootPath,
      workTreeName: 'notes-vault',
      externalGitDirOverride: altTarget,
    });
    expect(result.state).toBe('migrated');
    expect(result.workTree).toBe(altWorkTree);
    expect(result.externalGitDir).toBe(altTarget);
  });
});
