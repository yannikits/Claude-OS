/**
 * Resolves the on-disk path of the memory-index `.db` file.
 *
 * Per ADR-0025 + ARCHITECTURE.md §5.1, the index lives inside the vault
 * under `<vault>/.claude-os/index.db`. This keeps each vault self-
 * contained — when a vault moves to a new machine, the index is
 * present (subject to it being gitignored or not; recommended to
 * gitignore so each machine maintains its own).
 *
 * @module @domains/memory-index/paths
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_DIR = '.claude-os';
const INDEX_FILENAME = 'index.db';

/**
 * Returns the absolute path of the index `.db` file. Does NOT create
 * the parent directory — callers that need to write to it should call
 * `ensureIndexDir(vaultRoot)` first.
 */
export function resolveIndexDbPath(vaultRoot: string): string {
  return join(vaultRoot, INDEX_DIR, INDEX_FILENAME);
}

/**
 * Ensures `<vault>/.claude-os/` exists (lazy bootstrap). Idempotent.
 * Returns the dir path.
 */
export function ensureIndexDir(vaultRoot: string): string {
  const dir = join(vaultRoot, INDEX_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
