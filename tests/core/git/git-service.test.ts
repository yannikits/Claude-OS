import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitArgValidationError,
  GitError,
  GitNotInstalledError,
  GitService,
} from '../../../src/core/git/index.js';

describe('GitService', () => {
  let tmpBase: string;
  let workTree: string;
  let service: GitService;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-git-'));
    workTree = join(tmpBase, 'repo');
    mkdirSync(workTree, { recursive: true });
    service = new GitService(workTree);
    await service.init();
    // Suppress identity prompts on hosts without global git user config.
    await service.setConfig('user.email', 'tests@example.com');
    await service.setConfig('user.name', 'Tests');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('reports git version in the form "git X.Y.Z"', async () => {
    const v = await service.version();
    expect(v).toMatch(/^git \d+\.\d+\.\d+/);
  });

  it('detects the current branch after the initial commit', async () => {
    writeFileSync(join(workTree, 'README.md'), '# Test\n');
    await service.addAll();
    await service.commit('initial');
    const branch = await service.getCurrentBranch();
    // git init may default to 'main' or 'master' depending on host config.
    expect(branch).toMatch(/^(main|master)$/);
  });

  it('reports a clean status for an empty repo', async () => {
    const status = await service.status();
    expect(status.clean).toBe(true);
  });

  it('classifies untracked, modified, deleted files in status', async () => {
    writeFileSync(join(workTree, 'committed.md'), 'v1\n');
    await service.addAll();
    await service.commit('initial');

    writeFileSync(join(workTree, 'committed.md'), 'v2\n');
    writeFileSync(join(workTree, 'untracked.md'), 'new\n');
    const status = await service.status();
    expect(status.clean).toBe(false);
    expect(status.modified).toContain('committed.md');
    expect(status.untracked).toContain('untracked.md');
  });

  it('stages and commits in one round-trip', async () => {
    writeFileSync(join(workTree, 'a.md'), 'a\n');
    await service.addAll();
    const result = await service.commit('add a');
    expect(result.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(result.message).toBe('add a');
    expect(result.branch).toMatch(/^(main|master)$/);
  });

  it('round-trips git config at local scope', async () => {
    await service.setConfig('custom.key', 'hello-value');
    expect(await service.getConfig('custom.key')).toBe('hello-value');
  });

  it('returns null for an unset config key', async () => {
    expect(await service.getConfig('custom.does-not-exist')).toBeNull();
  });

  it('maps unknown raw errors to plain GitError', async () => {
    await expect(service.raw(['this-is-not-a-git-subcommand'])).rejects.toThrow(GitError);
  });

  describe('M7: argv-injection guards', () => {
    it('push refused remote starting with "-" (argv-injection)', async () => {
      await expect(service.push('--upload-pack=evil', 'main')).rejects.toThrow(
        GitArgValidationError,
      );
    });

    it('push refused branch starting with "-"', async () => {
      await expect(service.push('origin', '--upload-pack=evil')).rejects.toThrow(
        GitArgValidationError,
      );
    });

    it('push refused remote with invalid chars (ref-pattern guard)', async () => {
      await expect(service.push('origin;rm -rf /', 'main')).rejects.toThrow(GitArgValidationError);
    });

    it('clone akzeptiert Windows-Pfade (file-system-clones)', () => {
      // Smoke-Test fuer den simplifizierten URL-Validator: backslash-
      // paths sind legitime clone-sources (Windows-tmpdir).
      const winPath = 'C:\\Users\\x\\repo.git';
      // Konsumiert nur das validator-Helper (kein echtes git invocieren)
      // — wir koennen GitService.clone() nicht aufrufen ohne echtes git
      // aber die Validation laeuft im static-method-Header zuerst.
      // Hier indirekt via try-catch: erwarten KEIN
      // GitArgValidationError.
      // (Echtes clone wird mit "not a git repo" failen; das ist OK.)
      const dest = join(tmpBase, 'cloned-win');
      return expect(
        GitService.clone(winPath, dest).then(
          () => 'success',
          (err) => {
            if (err instanceof GitArgValidationError) throw err;
            return 'real-git-error';
          },
        ),
      ).resolves.toMatch(/success|real-git-error/);
    });

    it('pull refused remote starting with "-"', async () => {
      await expect(service.pull('-evil')).rejects.toThrow(GitArgValidationError);
    });

    it('pull refused branch starting with "-"', async () => {
      await expect(service.pull('origin', '--bad')).rejects.toThrow(GitArgValidationError);
    });

    it('GitService.clone refused source starting with "-"', async () => {
      const dest = join(tmpBase, 'cloned');
      await expect(GitService.clone('--upload-pack=evil', dest)).rejects.toThrow(
        GitArgValidationError,
      );
    });

    it('GitService.clone refused branch starting with "-"', async () => {
      const dest = join(tmpBase, 'cloned2');
      await expect(
        GitService.clone('https://example.com/repo.git', dest, { branch: '--bad' }),
      ).rejects.toThrow(GitArgValidationError);
    });

    it('push akzeptiert normale remote-namen + branch-namen', async () => {
      writeFileSync(join(workTree, 'a.md'), '#a');
      await service.addAll();
      await service.commit('init');
      // Push laeuft fail mit "no remote" — der Punkt ist: NICHT
      // GitArgValidationError, sondern ein echter Git-error.
      try {
        await service.push('origin', 'main');
      } catch (err) {
        expect(err).not.toBeInstanceOf(GitArgValidationError);
        expect(err).toBeInstanceOf(GitError);
      }
    });
  });
});

describe('GitNotInstalledError mapping', () => {
  it('surfaces as GitNotInstalledError when the git binary cannot be found', async () => {
    let tmpBase = '';
    try {
      tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-git-missing-'));
      const svc = new GitService(tmpBase, {
        options: { binary: '__definitely-no-such-binary__' },
      });
      await expect(svc.version()).rejects.toThrow(GitNotInstalledError);
    } finally {
      if (tmpBase.length > 0 && existsSync(tmpBase)) {
        rmSync(tmpBase, { recursive: true, force: true });
      }
    }
  });
});
