import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/core/git/index.js';
import { updateSkillsRepo } from '../../../src/domains/update-orchestrator/index.js';

describe('updateSkillsRepo', () => {
  let tmpBase: string;
  let bareDir: string;
  let upstream: string;
  let destination: string;
  let upstreamBranch: string;

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-skills-'));
    bareDir = join(tmpBase, 'skills.git');
    upstream = join(tmpBase, 'upstream-skills');
    destination = join(tmpBase, 'config', 'skills');
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(upstream, { recursive: true });

    await new GitService(bareDir).init(['--bare']);

    const author = new GitService(upstream);
    await author.init();
    await author.setConfig('user.email', 'a@example.com');
    await author.setConfig('user.name', 'A');
    await author.raw(['remote', 'add', 'origin', bareDir]);
    mkdirSync(join(upstream, 'thinking-partner'), { recursive: true });
    writeFileSync(
      join(upstream, 'thinking-partner', 'SKILL.md'),
      '# Thinking Partner\n\nseed skill\n',
    );
    await author.addAll();
    await author.commit('seed');
    upstreamBranch = await author.getCurrentBranch();
    await author.push('origin', upstreamBranch);
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  it('clones on first run when destination is absent', async () => {
    const result = await updateSkillsRepo({
      destination,
      source: bareDir,
      branch: upstreamBranch,
    });
    expect(result.state).toBe('cloned');
    expect(result.scope).toBe('skills');
    expect(existsSync(join(destination, 'thinking-partner', 'SKILL.md'))).toBe(true);
    expect(result.branch).toBe(upstreamBranch);
  });

  it('pulls --ff-only on subsequent runs', async () => {
    await updateSkillsRepo({ destination, source: bareDir, branch: upstreamBranch });

    const author = new GitService(upstream);
    mkdirSync(join(upstream, 'new-skill'), { recursive: true });
    writeFileSync(join(upstream, 'new-skill', 'SKILL.md'), '# new\n');
    await author.addAll();
    await author.commit('add new-skill');
    await author.push('origin', upstreamBranch);

    const result = await updateSkillsRepo({
      destination,
      source: bareDir,
      branch: upstreamBranch,
    });
    expect(result.state).toBe('updated');
    expect(existsSync(join(destination, 'new-skill', 'SKILL.md'))).toBe(true);
  });

  it('returns up-to-date when remote unchanged', async () => {
    await updateSkillsRepo({ destination, source: bareDir, branch: upstreamBranch });
    const result = await updateSkillsRepo({
      destination,
      source: bareDir,
      branch: upstreamBranch,
    });
    expect(result.state).toBe('up-to-date');
  });

  it('aborts when local skill files are dirty', async () => {
    await updateSkillsRepo({ destination, source: bareDir, branch: upstreamBranch });
    writeFileSync(
      join(destination, 'thinking-partner', 'SKILL.md'),
      '# Thinking Partner\n\nLOCAL MODIFICATION\n',
    );
    const result = await updateSkillsRepo({
      destination,
      source: bareDir,
      branch: upstreamBranch,
    });
    expect(result.state).toBe('aborted-dirty');
    expect(result.message).toMatch(/selective-merge needed/);
  });

  it('aborts on divergence between local commit and origin', async () => {
    await updateSkillsRepo({ destination, source: bareDir, branch: upstreamBranch });

    const local = new GitService(destination);
    await local.setConfig('user.email', 'l@example.com');
    await local.setConfig('user.name', 'L');
    writeFileSync(join(destination, 'local-only.md'), 'local\n');
    await local.addAll();
    await local.commit('local change');

    const author = new GitService(upstream);
    writeFileSync(join(upstream, 'upstream-only.md'), 'upstream\n');
    await author.addAll();
    await author.commit('upstream change');
    await author.push('origin', upstreamBranch);

    const result = await updateSkillsRepo({
      destination,
      source: bareDir,
      branch: upstreamBranch,
    });
    expect(result.state).toBe('aborted-diverged');
  });
});
