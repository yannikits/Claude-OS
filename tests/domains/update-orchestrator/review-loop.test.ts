import { describe, expect, it, vi } from 'vitest';
import {
  type FileToReview,
  type ReviewDecision,
  runReviewLoop,
} from '../../../src/domains/update-orchestrator/index.js';

function makeFile(overrides: Partial<FileToReview> & { relPath: string }): FileToReview {
  return {
    upstreamPath: `/u/${overrides.relPath}`,
    localPath: `/l/${overrides.relPath}`,
    zone: 'system',
    diff: {
      status: 'modified',
      addedLines: 1,
      removedLines: 1,
      unifiedDiff: 'diff',
      summary: `${overrides.relPath}: +1/-1`,
    },
    ...overrides,
  } as FileToReview;
}

describe('runReviewLoop', () => {
  it('auto-keeps locked files without calling decide', async () => {
    const decide = vi.fn();
    const applyUpgrade = vi.fn();
    const result = await runReviewLoop({
      files: [makeFile({ relPath: 'locked-skill/SKILL.md', zone: 'locked' })],
      decide,
      applyUpgrade,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(applyUpgrade).not.toHaveBeenCalled();
    expect(result.kept).toEqual(['locked-skill/SKILL.md']);
  });

  it('auto-keeps personal files without calling decide', async () => {
    const decide = vi.fn();
    const applyUpgrade = vi.fn();
    const result = await runReviewLoop({
      files: [makeFile({ relPath: 'mine/SKILL.md', zone: 'personal' })],
      decide,
      applyUpgrade,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(result.kept).toEqual(['mine/SKILL.md']);
  });

  it('auto-keeps unchanged system files', async () => {
    const decide = vi.fn();
    const applyUpgrade = vi.fn();
    const result = await runReviewLoop({
      files: [
        makeFile({
          relPath: 'x/SKILL.md',
          diff: {
            status: 'unchanged',
            addedLines: 0,
            removedLines: 0,
            unifiedDiff: '',
            summary: 'x: identical',
          },
        }),
      ],
      decide,
      applyUpgrade,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(result.kept).toEqual(['x/SKILL.md']);
  });

  it('auto-upgrades "added" files when autoAccept is true', async () => {
    const decide = vi.fn();
    const applyUpgrade = vi.fn().mockResolvedValue(undefined);
    const result = await runReviewLoop({
      files: [
        makeFile({
          relPath: 'new/SKILL.md',
          diff: {
            status: 'added',
            addedLines: 5,
            removedLines: 0,
            unifiedDiff: '',
            summary: 'new: +5',
          },
        }),
      ],
      decide,
      applyUpgrade,
      autoAccept: true,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(applyUpgrade).toHaveBeenCalledTimes(1);
    expect(result.upgraded).toEqual(['new/SKILL.md']);
  });

  it('calls decide for added files when autoAccept is false', async () => {
    const decide = vi
      .fn<(f: FileToReview) => Promise<ReviewDecision>>()
      .mockResolvedValue('upgrade');
    const applyUpgrade = vi.fn().mockResolvedValue(undefined);
    await runReviewLoop({
      files: [
        makeFile({
          relPath: 'new/SKILL.md',
          diff: {
            status: 'added',
            addedLines: 1,
            removedLines: 0,
            unifiedDiff: '',
            summary: 'new',
          },
        }),
      ],
      decide,
      applyUpgrade,
    });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('always calls decide for modified files even with autoAccept', async () => {
    const decide = vi.fn<(f: FileToReview) => Promise<ReviewDecision>>().mockResolvedValue('keep');
    const applyUpgrade = vi.fn();
    await runReviewLoop({
      files: [makeFile({ relPath: 'mod/SKILL.md' })],
      decide,
      applyUpgrade,
      autoAccept: true,
    });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('respects user keep/upgrade/skip decisions', async () => {
    const decisions: Record<string, ReviewDecision> = {
      'a.md': 'upgrade',
      'b.md': 'keep',
      'c.md': 'skip',
    };
    const decide = vi.fn<(f: FileToReview) => Promise<ReviewDecision>>((f) =>
      Promise.resolve(decisions[f.relPath] ?? 'skip'),
    );
    const applyUpgrade = vi.fn().mockResolvedValue(undefined);
    const result = await runReviewLoop({
      files: ['a.md', 'b.md', 'c.md'].map((relPath) => makeFile({ relPath })),
      decide,
      applyUpgrade,
    });
    expect(result.upgraded).toEqual(['a.md']);
    expect(result.kept).toEqual(['b.md']);
    expect(result.skipped).toEqual(['c.md']);
    expect(applyUpgrade).toHaveBeenCalledTimes(1);
  });

  it('moves an upgrade to skipped when applyUpgrade throws', async () => {
    const decide = vi
      .fn<(f: FileToReview) => Promise<ReviewDecision>>()
      .mockResolvedValue('upgrade');
    const applyUpgrade = vi.fn().mockRejectedValue(new Error('EACCES'));
    const result = await runReviewLoop({
      files: [makeFile({ relPath: 'fails.md' })],
      decide,
      applyUpgrade,
    });
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toEqual(['fails.md']);
  });

  it('keeps locally-removed files (does not auto-delete)', async () => {
    const decide = vi.fn();
    const applyUpgrade = vi.fn();
    const result = await runReviewLoop({
      files: [
        makeFile({
          relPath: 'old/SKILL.md',
          diff: {
            status: 'removed',
            addedLines: 0,
            removedLines: 5,
            unifiedDiff: '',
            summary: 'removed',
          },
        }),
      ],
      decide,
      applyUpgrade,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(result.kept).toEqual(['old/SKILL.md']);
  });
});
