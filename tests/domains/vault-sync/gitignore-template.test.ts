import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyDefaultGitignore,
  DEFAULT_GITIGNORE_LINES,
} from '../../../src/domains/vault-sync/index.js';

describe('applyDefaultGitignore', () => {
  let tmpBase: string;
  let workTree: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-gitignore-'));
    workTree = join(tmpBase, 'vault');
    mkdirSync(workTree, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('creates a new .gitignore with all default lines when none exists', () => {
    const result = applyDefaultGitignore(workTree);
    expect(result.created).toBe(true);
    expect(result.added.length).toBe(DEFAULT_GITIGNORE_LINES.length);
    expect(result.alreadyPresent).toEqual([]);
    const content = readFileSync(join(workTree, '.gitignore'), 'utf8');
    for (const line of DEFAULT_GITIGNORE_LINES) {
      expect(content).toContain(line);
    }
  });

  it('merges into an existing .gitignore without removing user lines', () => {
    writeFileSync(join(workTree, '.gitignore'), 'node_modules/\nmy-secret.txt\n');
    const result = applyDefaultGitignore(workTree);
    expect(result.created).toBe(false);
    expect(result.added.length).toBe(DEFAULT_GITIGNORE_LINES.length);
    const content = readFileSync(join(workTree, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('my-secret.txt');
    for (const line of DEFAULT_GITIGNORE_LINES) {
      expect(content).toContain(line);
    }
  });

  it('is idempotent — second invocation reports zero additions', () => {
    applyDefaultGitignore(workTree);
    const second = applyDefaultGitignore(workTree);
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent.length).toBe(DEFAULT_GITIGNORE_LINES.length);
  });

  it('treats whitespace-trimmed matches as already-present', () => {
    writeFileSync(join(workTree, '.gitignore'), `  .trash/  \n.DS_Store\n`);
    const result = applyDefaultGitignore(workTree);
    expect(result.alreadyPresent).toContain('.trash/');
    expect(result.alreadyPresent).toContain('.DS_Store');
  });
});
