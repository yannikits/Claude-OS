/**
 * Individual doctor checks. Each check is independent and returns
 * a structured CheckResult; failures are reported as 'fail' severity
 * rather than thrown exceptions so the runner can present them
 * uniformly.
 *
 * @module @core/doctor/checks
 */

import { exec } from 'node:child_process';
import { accessSync, existsSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ResolvedRoot } from '../environment/index.js';
import type { CheckFn, CheckResult } from './types.js';

const execAsync = promisify(exec);

const MIN_NODE_MAJOR = 20;

async function timed(name: string, fn: CheckFn): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      severity: 'fail',
      message: `Check threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

export async function checkNodeVersion(): Promise<CheckResult> {
  return timed('node-version', () => {
    const versionStr = process.versions.node;
    const majorStr = versionStr.split('.')[0] ?? '0';
    const major = Number.parseInt(majorStr, 10);
    if (major >= MIN_NODE_MAJOR) {
      return Promise.resolve({
        name: 'node-version',
        severity: 'ok',
        message: `Node v${versionStr}`,
      });
    }
    return Promise.resolve({
      name: 'node-version',
      severity: 'fail',
      message: `Node v${versionStr} below required v${MIN_NODE_MAJOR}`,
      hint: `Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org`,
    });
  });
}

export async function checkGitAvailable(): Promise<CheckResult> {
  return timed('git-available', async () => {
    try {
      const { stdout } = await execAsync('git --version');
      return {
        name: 'git-available',
        severity: 'ok',
        message: stdout.trim(),
      };
    } catch {
      return {
        name: 'git-available',
        severity: 'fail',
        message: 'System `git` not found in PATH',
        hint: 'Install Git: `winget install Git.Git` (Win) | `brew install git` (mac) | `apt install git` (Linux)',
      };
    }
  });
}

export async function checkClaudeBinary(rootPath: string): Promise<CheckResult> {
  return timed('claude-binary', () => {
    const win = join(rootPath, 'bin', 'claude.exe');
    const posix = join(rootPath, 'bin', 'claude');
    if (existsSync(win)) {
      return Promise.resolve({
        name: 'claude-binary',
        severity: 'ok',
        message: `Anthropic claude binary present at bin/claude.exe`,
      });
    }
    if (existsSync(posix)) {
      return Promise.resolve({
        name: 'claude-binary',
        severity: 'ok',
        message: `Anthropic claude binary present at bin/claude`,
      });
    }
    return Promise.resolve({
      name: 'claude-binary',
      severity: 'warn',
      message: 'Anthropic claude binary not found in bin/',
      detail: `Checked ${win} and ${posix}`,
      hint: '`claude-os ai` will fail until the Anthropic CLI is installed in bin/',
    });
  });
}

export async function checkMountReachable(root: ResolvedRoot): Promise<CheckResult> {
  return timed('mount-reachable', () => {
    if (!existsSync(root.path)) {
      return Promise.resolve({
        name: 'mount-reachable',
        severity: 'fail',
        message: `Root path "${root.path}" does not exist`,
        hint: 'Check $CLAUDE_OS_ROOT, your cloud-sync client (OneDrive/rclone/Drive), or run from within a claude-os repo',
      });
    }
    return Promise.resolve({
      name: 'mount-reachable',
      severity: 'ok',
      message: `${root.path} (source=${root.source}, cloud=${root.cloudProvider})`,
    });
  });
}

export async function checkWindowsLongPaths(): Promise<CheckResult> {
  return timed('windows-long-paths', async () => {
    if (process.platform !== 'win32') {
      return {
        name: 'windows-long-paths',
        severity: 'ok',
        message: 'not applicable (non-Windows)',
      };
    }
    try {
      const { stdout } = await execAsync('git config --global --get core.longpaths');
      const value = stdout.trim().toLowerCase();
      if (value === 'true') {
        return {
          name: 'windows-long-paths',
          severity: 'ok',
          message: 'git core.longpaths=true (vault deep-tree paths supported)',
        };
      }
      return {
        name: 'windows-long-paths',
        severity: 'warn',
        message: `git core.longpaths="${value}" — paths >260 chars may fail`,
        hint: 'Run: git config --global core.longpaths true',
      };
    } catch {
      // Non-zero exit usually means the key is unset.
      return {
        name: 'windows-long-paths',
        severity: 'warn',
        message: 'git core.longpaths is unset — paths >260 chars may fail',
        hint: 'Run: git config --global core.longpaths true',
      };
    }
  });
}

/**
 * Server-mode pre-flight (Phase Web-5 per ADR-0032 §"Akzeptanzkriterien" #1).
 *
 * Runs from `docker/entrypoint.sh` before `claude-os serve` boots —
 * fails loud so the container exits with a usable error message
 * instead of starting in a half-configured state.
 *
 * Three boundaries this check protects:
 *  1. `CLAUDE_OS_AUTH_TOKEN` set → otherwise the server's
 *     `makeAuthHook` would refuse-boot anyway, but later in startup
 *     and with a less-greppable message.
 *  2. `CLAUDE_OS_SECRETS_BACKEND=file` → headless containers have no
 *     keyring/DBus; the encrypted-file backend is the only viable
 *     choice. Catching a mis-set `=keyring` here saves a confusing
 *     runtime crash on the first `secrets.set` call.
 *  3. `CLAUDE_OS_VAULT_PATH` directory exists and is writable →
 *     otherwise vault-sync, note-write, and FTS-indexer fail later
 *     with cryptic ENOENT/EACCES errors deep in `methods.ts`.
 *
 * Skips with `ok` outside server-mode (no `CLAUDE_OS_AUTH_TOKEN`
 * present), so Tauri-desktop `claude-os doctor` runs are unaffected.
 */
export async function checkServerEnv(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  return timed('server-env', () => {
    const token = env.CLAUDE_OS_AUTH_TOKEN;
    if (token === undefined || token.length === 0) {
      return Promise.resolve({
        name: 'server-env',
        severity: 'ok',
        message: 'not in server mode (skipped — $CLAUDE_OS_AUTH_TOKEN unset)',
      });
    }

    const problems: string[] = [];

    const backend = env.CLAUDE_OS_SECRETS_BACKEND ?? '';
    if (backend !== 'file') {
      problems.push(
        `CLAUDE_OS_SECRETS_BACKEND="${backend}" — must be "file" in headless containers (keyring backends need a desktop session)`,
      );
    }

    const vaultPath = env.CLAUDE_OS_VAULT_PATH ?? '';
    if (vaultPath.length === 0) {
      problems.push('CLAUDE_OS_VAULT_PATH is unset — pre-flight expects a mounted vault directory');
    } else if (!existsSync(vaultPath)) {
      problems.push(`CLAUDE_OS_VAULT_PATH="${vaultPath}" does not exist (volume not mounted?)`);
    } else {
      try {
        accessSync(vaultPath, fsConstants.W_OK);
      } catch {
        problems.push(`CLAUDE_OS_VAULT_PATH="${vaultPath}" is not writable`);
      }
    }

    if (problems.length === 0) {
      return Promise.resolve({
        name: 'server-env',
        severity: 'ok',
        message: 'server-mode env complete (token + file-backend + writable vault)',
      });
    }

    return Promise.resolve({
      name: 'server-env',
      severity: 'fail',
      message: 'server-mode env incomplete',
      detail: problems.join(' | '),
      hint: 'See docs/server-deployment.md §"Schritt 2 — Claude-OS deployen" for the expected .env layout',
    });
  });
}

/**
 * Server-mode signing-keypair pre-flight (ADR-0035).
 *
 * Returns `warn` if no keypair is initialized — that's the lazy
 * happy-path for Tauri-desktop where Yannik hasn't yet run
 * `claude-os signing init`. The signing-keypair is required ONLY
 * when actually promoting a skill or signing an MSP-write-approval-
 * token; not having it shouldn't fail the boot.
 *
 * Returns `ok` once both `claude-os-signing-private-key` +
 * `claude-os-signing-public-key` are present in the SecretStore.
 *
 * Skipped (returns `ok`) outside server-mode (no `CLAUDE_OS_AUTH_TOKEN`)
 * — Tauri-desktop has its own init-flow via the GUI.
 */
export async function checkSigningKeypair(
  env: NodeJS.ProcessEnv = process.env,
  factory?: () => Promise<{
    readonly hasPublic: boolean;
    readonly hasPrivate: boolean;
    readonly backend: string;
  }>,
): Promise<CheckResult> {
  return timed('signing-keypair', async () => {
    if (env.CLAUDE_OS_AUTH_TOKEN === undefined || env.CLAUDE_OS_AUTH_TOKEN.length === 0) {
      return {
        name: 'signing-keypair',
        severity: 'ok',
        message: 'not in server mode (skipped — initialize via GUI or `claude-os signing init`)',
      };
    }
    let info: { hasPublic: boolean; hasPrivate: boolean; backend: string };
    if (factory !== undefined) {
      info = await factory();
    } else {
      // Lazy-load to avoid pulling secrets+skill-lifecycle when this
      // check isn't relevant (e.g. Tauri-desktop default doctor-run).
      const { createSecretStore } = await import('../../domains/secrets/index.js');
      const { SIGNING_KEY_NAMES } = await import('../../domains/skill-lifecycle/index.js');
      const store = createSecretStore();
      const [priv, pub] = await Promise.all([
        store.get(SIGNING_KEY_NAMES.PRIVATE),
        store.get(SIGNING_KEY_NAMES.PUBLIC),
      ]);
      info = { hasPrivate: priv !== null, hasPublic: pub !== null, backend: store.backend };
    }
    if (info.hasPrivate && info.hasPublic) {
      return {
        name: 'signing-keypair',
        severity: 'ok',
        message: `keypair present (backend=${info.backend})`,
      };
    }
    if (!info.hasPrivate && !info.hasPublic) {
      return {
        name: 'signing-keypair',
        severity: 'warn',
        message: 'signing keypair not initialized',
        hint: 'Run: claude-os signing init (needed for skill-promote + MSP-write approval-tokens)',
      };
    }
    // Half-state — one key but not the other. `loadOrCreateSigningKeypair`
    // would regenerate but only on its next call; surface it as a fail
    // so doctor highlights the inconsistency.
    return {
      name: 'signing-keypair',
      severity: 'fail',
      message: 'signing keypair half-state (one of private/public missing — corruption)',
      hint: 'Run: claude-os signing rotate --confirm  (regenerates fresh keypair)',
    };
  });
}

/**
 * Server-mode user-store pre-flight (Phase Web-7-3, ADR-0036 draft).
 *
 * Three outcomes:
 *   - `ok` when `users.sqlite` is absent (single-user Stage-1 token-only)
 *     OR present and openable with the expected schema-version.
 *   - `fail` when the file is present but unreadable, corrupt, or the
 *     schema-version mismatches (autoRebuildOnSchemaDrift=false so a
 *     drift surfaces here rather than silently dropping users).
 *   - Skipped (returns `ok`) outside server-mode.
 *
 * `dataDirOverride` lets tests target a tmp dir; production uses
 * `resolveMachinePaths().dataDir`.
 */
export async function checkUserStore(
  opts: { readonly env?: NodeJS.ProcessEnv; readonly dataDirOverride?: string } = {},
): Promise<CheckResult> {
  return timed('user-store', async () => {
    const env = opts.env ?? process.env;
    if (env.CLAUDE_OS_AUTH_TOKEN === undefined || env.CLAUDE_OS_AUTH_TOKEN.length === 0) {
      return {
        name: 'user-store',
        severity: 'ok',
        message: 'not in server mode (skipped — multi-user Stage-2 is server-only)',
      };
    }
    const { resolveMachinePaths } = await import('../paths/index.js');
    const { resolveUsersDbPath, UserRepository } = await import('../../domains/users/index.js');
    const dataDir = opts.dataDirOverride ?? resolveMachinePaths({ env }).dataDir;
    const dbPath = resolveUsersDbPath(dataDir);
    if (!existsSync(dbPath)) {
      return {
        name: 'user-store',
        severity: 'ok',
        message: 'no users.sqlite (Stage-1 token-only — multi-user via "claude-os users create")',
      };
    }
    try {
      const repo = await UserRepository.open({ dataDir, autoRebuildOnSchemaDrift: false });
      const n = repo.countAll();
      repo.close();
      return {
        name: 'user-store',
        severity: 'ok',
        message: `users.sqlite ok (${n} user${n === 1 ? '' : 's'})`,
      };
    } catch (err) {
      return {
        name: 'user-store',
        severity: 'fail',
        message: 'users.sqlite present but unreadable',
        detail: err instanceof Error ? err.message : String(err),
        hint: 'Restore from backup, or re-init via "claude-os users create --email <e> --password <p>" after removing the corrupt file.',
      };
    }
  });
}

export async function checkWritePermission(rootPath: string): Promise<CheckResult> {
  return timed('write-permission', () => {
    try {
      accessSync(rootPath, fsConstants.W_OK);
      return Promise.resolve({
        name: 'write-permission',
        severity: 'ok',
        message: `Writable: ${rootPath}`,
      });
    } catch {
      return Promise.resolve({
        name: 'write-permission',
        severity: 'fail',
        message: `Root path is not writable: ${rootPath}`,
        hint: 'Check filesystem permissions, cloud-sync read-only state, or disk-full condition',
      });
    }
  });
}
