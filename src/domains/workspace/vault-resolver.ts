/**
 * Resolves the Obsidian vault root from `.env` (`CLAUDE_OS_VAULT_PATH`).
 *
 * Orthogonal to `core/environment/root-resolver.ts` which resolves the
 * *install-tree* (claude-os-root, ADR-0002). The vault-root is a
 * separate concept (ADR-0031): the Obsidian vault location where
 * `Claude-OS/workspaces/<workspace-id>/` lives.
 *
 * @module @domains/workspace/vault-resolver
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAppEnv } from '../../core/config/index.js';
import { VaultPathNotConfiguredError, WorkspaceError } from './types.js';

interface VaultResolverOpts {
  /** Explicit vault-root override (skips env-load). Tests + CLI `--vault`. */
  readonly explicit?: string;
  /** Pre-loaded env (tests). Defaults to `loadAppEnv()`. */
  readonly env?: { readonly vaultPath?: string };
}

/**
 * Returns the absolute path to the vault-root. Throws if not configured
 * or if the path doesn't exist / isn't a directory.
 */
export function resolveVaultRoot(opts: VaultResolverOpts = {}): string {
  let raw = opts.explicit;
  if (raw === undefined || raw.length === 0) {
    const env = opts.env ?? loadAppEnv();
    raw = env.vaultPath;
  }
  if (raw === undefined || raw.length === 0) {
    throw new VaultPathNotConfiguredError();
  }
  const absolute = resolve(raw);
  if (!existsSync(absolute)) {
    throw new WorkspaceError(`CLAUDE_OS_VAULT_PATH points to "${absolute}" which does not exist.`);
  }
  try {
    if (!statSync(absolute).isDirectory()) {
      throw new WorkspaceError(
        `CLAUDE_OS_VAULT_PATH points to "${absolute}" which is not a directory.`,
      );
    }
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
    throw new WorkspaceError(
      `Cannot stat CLAUDE_OS_VAULT_PATH="${absolute}": ${(err as Error).message}`,
    );
  }
  return absolute;
}
