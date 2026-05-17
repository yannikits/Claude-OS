import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsInAnyScope, mergeScopes } from '../../../src/domains/catalog/index.js';

describe('mergeScopes', () => {
  let tmpBase: string;
  let userRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-scope-'));
    userRoot = join(tmpBase, 'user');
    projectRoot = join(tmpBase, 'project');
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeFile(root: string, rel: string, content: string): void {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }

  it('returns user-only files when project root is missing', () => {
    writeFile(userRoot, 'skills/a/SKILL.md', '1');
    writeFile(userRoot, 'plugins/b.json', '2');
    const merged = mergeScopes({ userRoot, projectRoot });
    expect(merged.map((m) => m.relPath)).toEqual(['plugins/b.json', 'skills/a/SKILL.md']);
    expect(merged.every((m) => m.scope === 'user')).toBe(true);
  });

  it('returns project-only files when user root is missing', () => {
    writeFile(projectRoot, 'skills/a/SKILL.md', '1');
    const merged = mergeScopes({ userRoot, projectRoot });
    expect(merged.every((m) => m.scope === 'project')).toBe(true);
  });

  it('project wins over user when paths overlap', () => {
    writeFile(userRoot, 'skills/x/SKILL.md', 'user version');
    writeFile(projectRoot, 'skills/x/SKILL.md', 'project version');
    const merged = mergeScopes({ userRoot, projectRoot });
    const x = merged.find((f) => f.relPath === 'skills/x/SKILL.md');
    expect(x?.scope).toBe('project');
  });

  it('mixes user-only + project-only + override entries correctly', () => {
    writeFile(userRoot, 'only-user.md', 'u');
    writeFile(userRoot, 'shared.md', 'u');
    writeFile(projectRoot, 'shared.md', 'p');
    writeFile(projectRoot, 'only-project.md', 'p');
    const merged = mergeScopes({ userRoot, projectRoot });
    const map = new Map(merged.map((m) => [m.relPath, m.scope]));
    expect(map.get('only-user.md')).toBe('user');
    expect(map.get('only-project.md')).toBe('project');
    expect(map.get('shared.md')).toBe('project');
  });

  it('returns relative paths with forward-slashes regardless of host platform', () => {
    writeFile(userRoot, 'nested/dir/file.md', 'x');
    const merged = mergeScopes({ userRoot });
    expect(merged[0]?.relPath).toBe('nested/dir/file.md');
    expect(merged[0]?.relPath.includes('\\')).toBe(false);
  });

  it('returns empty array when neither root exists', () => {
    expect(mergeScopes({ userRoot, projectRoot })).toEqual([]);
  });

  it('sort order is stable across relPaths', () => {
    writeFile(userRoot, 'b.md', '');
    writeFile(userRoot, 'a.md', '');
    writeFile(projectRoot, 'c.md', '');
    const merged = mergeScopes({ userRoot, projectRoot });
    expect(merged.map((m) => m.relPath)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('existsInAnyScope returns true when present in project only', () => {
    writeFile(projectRoot, 'p-only.md', '');
    expect(existsInAnyScope('p-only.md', { userRoot, projectRoot })).toBe(true);
  });

  it('existsInAnyScope returns true when present in user only', () => {
    writeFile(userRoot, 'u-only.md', '');
    expect(existsInAnyScope('u-only.md', { userRoot, projectRoot })).toBe(true);
  });

  it('existsInAnyScope returns false otherwise', () => {
    expect(existsInAnyScope('nope.md', { userRoot, projectRoot })).toBe(false);
  });
});
