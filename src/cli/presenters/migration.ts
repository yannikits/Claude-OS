/**
 * Migration-result presenters for `claude-os doctor --migrate-git-metadata`.
 *
 * Mirrors the ASCII-marker style of the doctor presenter so the output
 * renders predictably in Windows cmd.exe.
 *
 * @module @cli/presenters/migration
 */
import type { MigrationResult, MigrationState } from '../../core/git-metadata/index.js';

const MARKER: Record<MigrationState, string> = {
  'not-needed': '[OK]  ',
  'no-git-dir': '[WARN]',
  'already-migrated': '[OK]  ',
  migrated: '[OK]  ',
  error: '[FAIL]',
};

export function formatMigrationResultText(result: MigrationResult): string {
  const lines: string[] = [];
  lines.push('claude-os doctor --migrate-git-metadata');
  lines.push('========================================');
  lines.push('');
  lines.push(`${MARKER[result.state]} ${result.state}: ${result.message}`);
  lines.push(`        work-tree:   ${result.workTree}`);
  lines.push(`        target:      ${result.externalGitDir}`);
  if (result.detail !== undefined) lines.push(`        ${result.detail}`);
  if (result.error !== undefined) lines.push(`        Error: ${result.error}`);
  lines.push(`        (${result.durationMs}ms)`);
  return lines.join('\n');
}

export function formatMigrationResultJson(result: MigrationResult): string {
  return JSON.stringify(result, null, 2);
}
