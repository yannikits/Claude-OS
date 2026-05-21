/**
 * GitService — central simple-git abstraction per ADR-0008.
 *
 * All domain code MUST go through GitService; importing `simple-git`
 * directly outside this module is forbidden. This lets us drop in a
 * different backend later (e.g. Rust libgit2 sidecar per ADR-0008 §32)
 * without touching domain code.
 *
 * Error policy: simple-git's `GitError` is converted to the typed
 * hierarchy declared in `./types.ts`. Callers pattern-match on the
 * specific error subclass; raw stderr is never re-thrown.
 *
 * @module @core/git/git-service
 */
import { type SimpleGit, type SimpleGitOptions, simpleGit } from 'simple-git';
import {
  type CommitResult,
  type GitConfigScope,
  GitError,
  GitLockfileError,
  GitMergeConflictError,
  GitNotInstalledError,
  type GitStatusSummary,
  type PushResult,
} from './types.js';

interface GitServiceOpts {
  /** Inject a SimpleGit factory (primarily for tests). */
  readonly simpleGitFn?: typeof simpleGit;
  /** Suppress timeout-related retries. Default: no timeout option set. */
  readonly options?: Partial<SimpleGitOptions>;
}

/**
 * M7 (2026-05-21 code-review): validate `remote`/`branch`/`source`/`destination`
 * gegen argv-injection. simple-git uses child_process.spawn(git, args) ohne
 * shell — keine command-injection ueber Metachars. ABER git akzeptiert
 * `--upload-pack=<cmd>`-aehnliche Args wenn URLs/Refs mit `-` beginnen
 * (CVE-2024-32002-Familie). Allowlist verhindert das.
 *
 * Erlaubt: alphanumerisch + `.`, `_`, `/`, `-` (aber NICHT als erstes
 * Zeichen). URLs duerfen zusaetzlich `:`, `@`, `?`, `=`, `&`, `%`, `+`
 * fuer query-strings enthalten.
 */
/**
 * Refs (branches, remotes): conservative allowlist `[A-Za-z0-9_./-]+`
 * mit Verbot von '-' am Anfang. Git-ref-Konventionen erlauben mehr
 * (z. B. Slashes), aber das ist die safe-subset fuer unsere Use-Cases
 * (origin, main, master, feature/x).
 */
const GIT_REF_PATTERN = /^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/;

export class GitArgValidationError extends GitError {
  constructor(
    public readonly arg: string,
    public readonly value: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitArgValidationError';
  }
}

function validateRef(arg: string, value: string): void {
  if (value.length === 0) {
    throw new GitArgValidationError(arg, value, `git ${arg}: must be non-empty`);
  }
  if (value.startsWith('-')) {
    throw new GitArgValidationError(
      arg,
      value,
      `git ${arg}: refusing value starting with '-' (argv-injection guard): "${value}"`,
    );
  }
  if (!GIT_REF_PATTERN.test(value)) {
    throw new GitArgValidationError(
      arg,
      value,
      `git ${arg}: invalid characters (allow A-Za-z0-9_./-): "${value}"`,
    );
  }
}

/**
 * Clone-source/URL: minimal-guard — nur `-` am Anfang refusen (argv-
 * injection). Git akzeptiert URLs (https/ssh/git://), Windows + POSIX
 * file-paths sowie relative pfade — wir koennen den char-set nicht
 * sinnvoll einschraenken ohne legitime Use-Cases zu brechen.
 */
function validateUrl(arg: string, value: string): void {
  if (value.length === 0) {
    throw new GitArgValidationError(arg, value, `git ${arg}: must be non-empty`);
  }
  if (value.startsWith('-')) {
    throw new GitArgValidationError(
      arg,
      value,
      `git ${arg}: refusing value starting with '-' (argv-injection guard): "${value}"`,
    );
  }
}

function mapError(err: unknown, hint?: string): GitError {
  if (err instanceof GitError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  // `spawn ... ENOENT` from Node's child_process means the binary itself
  // is missing — when simple-git emits this it means our git binary cannot
  // be located, regardless of how it's named (PATH, customBinary, etc.).
  if (
    lower.includes('git: command not found') ||
    lower.includes('git was not found') ||
    /spawn .+ enoent/.test(lower)
  ) {
    return new GitNotInstalledError(
      `System git is not available: ${raw}${hint === undefined ? '' : ` (${hint})`}`,
    );
  }

  const lockMatch = /([^\s]*index\.lock|HEAD\.lock)/i.exec(raw);
  if (
    lower.includes('index.lock') ||
    lower.includes('head.lock') ||
    lower.includes('another git process')
  ) {
    return new GitLockfileError(`Git lockfile blocks operation: ${raw}`, lockMatch?.[1] ?? '');
  }

  if (
    lower.includes('conflict') ||
    lower.includes('automatic merge failed') ||
    lower.includes('merge conflict')
  ) {
    return new GitMergeConflictError(`Merge conflict: ${raw}`, []);
  }

  return new GitError(raw);
}

const CONFLICTED_PORCELAIN = new Set(['UU', 'AA', 'DD', 'UA', 'AU', 'DU', 'UD']);

function parsePorcelainLine(
  line: string,
  summary: {
    staged: string[];
    modified: string[];
    untracked: string[];
    conflicted: string[];
    deleted: string[];
  },
): void {
  if (line.length < 3) return;
  const idx = line[0] ?? ' ';
  const wt = line[1] ?? ' ';
  const path = line.slice(3).trim();
  if (path.length === 0) return;

  const xy = `${idx}${wt}`;
  if (CONFLICTED_PORCELAIN.has(xy)) {
    summary.conflicted.push(path);
    return;
  }
  if (idx === '?' && wt === '?') {
    summary.untracked.push(path);
    return;
  }
  if (idx !== ' ' && idx !== '?') summary.staged.push(path);
  if (wt === 'M') summary.modified.push(path);
  if (wt === 'D' || idx === 'D') summary.deleted.push(path);
}

export class GitService {
  readonly workTree: string;
  private readonly git: SimpleGit;

  constructor(workTree: string, opts: GitServiceOpts = {}) {
    this.workTree = workTree;
    const factory = opts.simpleGitFn ?? simpleGit;
    this.git = factory(workTree, opts.options);
  }

  async version(): Promise<string> {
    try {
      const v = await this.git.version();
      if (v.major === 0 && v.minor === 0 && v.patch === 0) {
        throw new GitNotInstalledError(
          'System git is not available: simple-git returned version 0.0.0 (binary not found or unparseable)',
        );
      }
      return `git ${v.major}.${v.minor}.${v.patch}`;
    } catch (err) {
      throw mapError(err, 'is `git` installed and on PATH?');
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim();
    } catch (err) {
      throw mapError(err);
    }
  }

  async status(): Promise<GitStatusSummary> {
    let raw: string;
    try {
      raw = await this.git.raw(['status', '--porcelain=v1']);
    } catch (err) {
      throw mapError(err);
    }
    const summary = {
      staged: [] as string[],
      modified: [] as string[],
      untracked: [] as string[],
      conflicted: [] as string[],
      deleted: [] as string[],
    };
    for (const line of raw.split(/\r?\n/)) {
      if (line.length === 0) continue;
      parsePorcelainLine(line, summary);
    }
    return {
      clean:
        summary.staged.length === 0 &&
        summary.modified.length === 0 &&
        summary.untracked.length === 0 &&
        summary.conflicted.length === 0 &&
        summary.deleted.length === 0,
      ...summary,
    };
  }

  async addAll(): Promise<void> {
    try {
      await this.git.add('.');
    } catch (err) {
      throw mapError(err);
    }
  }

  async commit(message: string): Promise<CommitResult> {
    try {
      const result = await this.git.commit(message);
      const branch = await this.getCurrentBranch();
      return { sha: result.commit, branch, message };
    } catch (err) {
      throw mapError(err);
    }
  }

  async push(remote = 'origin', branch?: string): Promise<PushResult> {
    validateRef('remote', remote);
    const target = branch ?? (await this.getCurrentBranch());
    validateRef('branch', target);
    try {
      await this.git.push(remote, target);
      return { pushed: true, remote, branch: target };
    } catch (err) {
      throw mapError(err);
    }
  }

  async pull(remote = 'origin', branch?: string, opts: { ffOnly?: boolean } = {}): Promise<void> {
    validateRef('remote', remote);
    const target = branch ?? (await this.getCurrentBranch());
    validateRef('branch', target);
    try {
      if (opts.ffOnly === true) {
        await this.git.raw(['pull', '--ff-only', remote, target]);
      } else {
        await this.git.pull(remote, target);
      }
    } catch (err) {
      throw mapError(err);
    }
  }

  /**
   * Clones `source` into `destination` and returns a GitService bound
   * to the freshly created working tree. Use when bootstrapping a
   * repo that does not yet exist (e.g. skills-repo first-time install).
   */
  static async clone(
    source: string,
    destination: string,
    opts: { branch?: string } = {},
  ): Promise<GitService> {
    validateUrl('clone-source', source);
    if (opts.branch !== undefined) validateRef('branch', opts.branch);
    const git = simpleGit();
    const args = opts.branch === undefined ? [] : ['--branch', opts.branch];
    try {
      await git.clone(source, destination, args);
    } catch (err) {
      throw mapError(err);
    }
    return new GitService(destination);
  }

  async setConfig(key: string, value: string, scope: GitConfigScope = 'local'): Promise<void> {
    try {
      const scopeFlag = scope === 'local' ? [] : [`--${scope}`];
      await this.git.raw(['config', ...scopeFlag, key, value]);
    } catch (err) {
      throw mapError(err);
    }
  }

  async getConfig(key: string, scope: GitConfigScope = 'local'): Promise<string | null> {
    try {
      const scopeFlag = scope === 'local' ? [] : [`--${scope}`];
      const value = await this.git.raw(['config', ...scopeFlag, '--get', key]);
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    } catch (err) {
      // simple-git returns non-zero exit for "key not found" — treat as null.
      if (err instanceof Error && /exit code 1/i.test(err.message)) return null;
      throw mapError(err);
    }
  }

  async init(args: readonly string[] = []): Promise<void> {
    try {
      await this.git.init([...args]);
    } catch (err) {
      throw mapError(err);
    }
  }

  /** Direct simple-git escape hatch (avoid in new code — prefer typed methods). */
  raw(args: readonly string[]): Promise<string> {
    return this.git.raw([...args]).catch((err) => {
      throw mapError(err);
    });
  }
}
