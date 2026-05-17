/**
 * Default `.gitignore` for vault working-trees.
 *
 * Curated from obsidian-git issue #114 + similar reports — the listed
 * patterns are the dominant sources of multi-device sync conflicts in
 * Obsidian/Logseq/Zettlr workflows. `applyDefaultGitignore` merges the
 * template into an existing `.gitignore` without disturbing
 * user-added entries.
 *
 * @module @domains/vault-sync/gitignore-template
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Marker lines that are always added to the vault `.gitignore`. */
export const DEFAULT_GITIGNORE_LINES: readonly string[] = [
  '# claude-os: default vault ignores (do not remove this header)',
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/cache',
  '.obsidian/cache/',
  '.trash/',
  'claudeos-machine-state/',
  '.DS_Store',
  'Thumbs.db',
  '*.tmp',
  '*.swp',
];

export interface ApplyGitignoreResult {
  readonly path: string;
  readonly added: readonly string[];
  readonly alreadyPresent: readonly string[];
  readonly created: boolean;
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/**
 * Adds any missing default lines to `<workTree>/.gitignore`. Atomic
 * write via tempfile + rename. Preserves all existing user lines and
 * their order; new lines are appended at the end.
 */
export function applyDefaultGitignore(workTree: string): ApplyGitignoreResult {
  const path = join(workTree, '.gitignore');
  const exists = existsSync(path);
  const existing = exists ? readFileSync(path, 'utf8') : '';
  const existingLines = splitLines(existing);
  const existingSet = new Set(
    existingLines.map((line) => line.trim()).filter((line) => line.length > 0),
  );

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const line of DEFAULT_GITIGNORE_LINES) {
    if (existingSet.has(line)) {
      alreadyPresent.push(line);
    } else {
      added.push(line);
    }
  }

  if (added.length === 0) {
    return { path, added, alreadyPresent, created: false };
  }

  const baseTrimmed = existing.replace(/\s+$/u, '');
  const prefix = baseTrimmed.length === 0 ? '' : `${baseTrimmed}\n\n`;
  const blob = `${prefix}${added.join('\n')}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, blob, { mode: 0o644 });
  renameSync(tmp, path);
  return { path, added, alreadyPresent, created: !exists };
}
