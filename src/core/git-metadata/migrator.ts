/**
 * Migrates `<root>/vault/.git/` into a per-machine external location
 * (`%APPDATA%/claude-os/git-metadata/vault.git/`) using
 * `git init --separate-git-dir`. Per ADR-0002 — cloud-sync mounts must
 * not contain Git metadata directories.
 *
 * Idempotent: second invocation is a no-op (`already-migrated`).
 *
 * @module @core/git-metadata/migrator
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import { externalGitDirFor } from '../paths/index.js';
import type { MigrationResult, MigrationState } from './types.js';

interface MigrateOpts {
  /** Cloud-mount root (resolved {@link ResolvedRoot}.path). */
  readonly rootPath: string;
  /** Working-tree directory under `rootPath` (default: `vault`). */
  readonly workTreeName?: string;
  /** Override external target (rarely used outside tests). */
  readonly externalGitDirOverride?: string;
  /** Env-var source — forwarded to `externalGitDirFor` when override unset. */
  readonly env?: NodeJS.ProcessEnv;
  /** Platform — forwarded to `externalGitDirFor`. */
  readonly platform?: NodeJS.Platform;
  /** Home dir — forwarded to `externalGitDirFor`. */
  readonly home?: string;
}

const GITFILE_LINE = /^gitdir:\s*(.+?)\s*$/m;

/**
 * Normalises a path for equality comparison. Uses the platform-native
 * realpath which on Windows expands 8.3 short-name forms (e.g.
 * `REAPER~1` → `reapertakashi`) and on POSIX resolves symlinks.
 * Falls back to a plain `resolve()` when the path does not exist.
 */
function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

function buildResult(
  state: MigrationState,
  workTree: string,
  externalGitDir: string,
  message: string,
  startedAt: number,
  extras: { readonly detail?: string; readonly error?: string } = {},
): MigrationResult {
  return {
    state,
    workTree,
    externalGitDir,
    message,
    durationMs: Date.now() - startedAt,
    ...(extras.detail === undefined ? {} : { detail: extras.detail }),
    ...(extras.error === undefined ? {} : { error: extras.error }),
  };
}

/**
 * Reads a gitfile and returns the absolute `gitdir:` target it points to,
 * resolved against the gitfile's parent. Returns `null` if the file does
 * not contain a parseable `gitdir:` line.
 */
function readGitfileTarget(gitfilePath: string, workTree: string): string | null {
  const content = readFileSync(gitfilePath, 'utf8');
  const match = GITFILE_LINE.exec(content);
  if (match === null) return null;
  const raw = match[1];
  if (raw === undefined) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(workTree, raw);
}

/**
 * Returns true when `dir` exists and contains at least one entry.
 */
function dirNonEmpty(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Migrate an in-mount working tree's Git metadata into the external
 * per-machine `git-metadata/` directory. Safe to run multiple times.
 */
export async function migrateGitMetadata(opts: MigrateOpts): Promise<MigrationResult> {
  const startedAt = Date.now();
  const workTreeName = opts.workTreeName ?? 'vault';
  const workTree = resolve(opts.rootPath, workTreeName);
  const externalGitDir =
    opts.externalGitDirOverride === undefined
      ? externalGitDirFor(workTreeName, {
          ...(opts.env === undefined ? {} : { env: opts.env }),
          ...(opts.platform === undefined ? {} : { platform: opts.platform }),
          ...(opts.home === undefined ? {} : { home: opts.home }),
        })
      : resolve(opts.externalGitDirOverride);

  if (!existsSync(workTree)) {
    return buildResult(
      'not-needed',
      workTree,
      externalGitDir,
      `No working tree at ${workTree} — nothing to migrate`,
      startedAt,
      { detail: 'Create the vault directory before migration is meaningful.' },
    );
  }

  const dotGit = join(workTree, '.git');

  if (!existsSync(dotGit)) {
    return buildResult(
      'no-git-dir',
      workTree,
      externalGitDir,
      `${dotGit} does not exist — vault is not yet a Git repository`,
      startedAt,
      { detail: 'Initialize the repo with `git init` inside the vault first, then re-run migration.' },
    );
  }

  let dotGitStat: ReturnType<typeof statSync>;
  try {
    dotGitStat = statSync(dotGit);
  } catch (err) {
    return buildResult('error', workTree, externalGitDir, `Cannot stat ${dotGit}`, startedAt, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Case A: .git is already a gitfile — possibly already migrated.
  if (dotGitStat.isFile()) {
    let pointsAt: string | null;
    try {
      pointsAt = readGitfileTarget(dotGit, workTree);
    } catch (err) {
      return buildResult('error', workTree, externalGitDir, `Cannot read gitfile ${dotGit}`, startedAt, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (pointsAt === null) {
      return buildResult(
        'error',
        workTree,
        externalGitDir,
        `Gitfile at ${dotGit} has no parseable "gitdir:" line`,
        startedAt,
        { error: 'Malformed gitfile — manual repair required.' },
      );
    }
    if (canonical(pointsAt) === canonical(externalGitDir)) {
      return buildResult(
        'already-migrated',
        workTree,
        externalGitDir,
        `Already migrated — .git → ${externalGitDir}`,
        startedAt,
      );
    }
    return buildResult(
      'error',
      workTree,
      externalGitDir,
      `Gitfile points elsewhere (${pointsAt}); expected ${externalGitDir}`,
      startedAt,
      {
        error:
          'Refusing to overwrite. Either move the existing metadata manually, ' +
          'or set $CLAUDE_OS_DATA_DIR to match the current target.',
      },
    );
  }

  // Case B: .git is a directory — perform the migration.
  if (!dotGitStat.isDirectory()) {
    return buildResult(
      'error',
      workTree,
      externalGitDir,
      `${dotGit} is neither a file nor a directory`,
      startedAt,
      { error: 'Unexpected filesystem state.' },
    );
  }

  // Pre-flight: external target must be absent or empty.
  if (dirNonEmpty(externalGitDir)) {
    return buildResult(
      'error',
      workTree,
      externalGitDir,
      `External target ${externalGitDir} already exists and is non-empty`,
      startedAt,
      {
        error:
          'Refusing to clobber. Inspect the target directory and remove it manually if obsolete.',
      },
    );
  }

  try {
    mkdirSync(externalGitDir, { recursive: true });
  } catch (err) {
    return buildResult(
      'error',
      workTree,
      externalGitDir,
      `Cannot create external git-metadata directory ${externalGitDir}`,
      startedAt,
      { error: err instanceof Error ? err.message : String(err) },
    );
  }

  try {
    const git = simpleGit(workTree);
    await git.init(['--separate-git-dir', externalGitDir]);
  } catch (err) {
    return buildResult(
      'error',
      workTree,
      externalGitDir,
      `git init --separate-git-dir failed for ${workTree}`,
      startedAt,
      { error: err instanceof Error ? err.message : String(err) },
    );
  }

  // Post-condition verification.
  const verifyTarget = readGitfileTarget(dotGit, workTree);
  if (verifyTarget === null || canonical(verifyTarget) !== canonical(externalGitDir)) {
    return buildResult(
      'error',
      workTree,
      externalGitDir,
      `Post-migration verification failed for ${dotGit}`,
      startedAt,
      {
        error: `Gitfile points to "${verifyTarget ?? 'unparseable'}", expected "${externalGitDir}"`,
      },
    );
  }
  if (!existsSync(join(externalGitDir, 'HEAD'))) {
    return buildResult(
      'error',
      workTree,
      externalGitDir,
      `External git-dir missing HEAD after migration: ${externalGitDir}`,
      startedAt,
      { error: 'Migration command reported success but the metadata layout is incomplete.' },
    );
  }

  return buildResult(
    'migrated',
    workTree,
    externalGitDir,
    `Moved .git/ → ${externalGitDir}; ${dotGit} now a gitfile`,
    startedAt,
  );
}
