import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillReviewPage } from '../src/pages/skill-review';

type Fn = (...args: unknown[]) => unknown;
const rpcMocks: { listSkillQuarantined: Fn; proposeSkillReview: Fn } = {
  listSkillQuarantined: vi.fn() as Fn,
  proposeSkillReview: vi.fn() as Fn,
};

vi.mock('../src/lib/rpc', async () => {
  return {
    listSkillQuarantined: (...args: unknown[]) => rpcMocks.listSkillQuarantined(...args),
    proposeSkillReview: (...args: unknown[]) => rpcMocks.proposeSkillReview(...args),
  };
});

beforeEach(() => {
  rpcMocks.listSkillQuarantined = vi.fn();
  rpcMocks.proposeSkillReview = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SkillReviewPage', () => {
  it('shows the empty-state when no quarantined skills exist', async () => {
    (rpcMocks.listSkillQuarantined as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      workspace: 'personal',
      entries: [],
    });

    render(<SkillReviewPage />);
    await waitFor(() => {
      expect(screen.getByText(/Keine Pending-Reviews/)).toBeTruthy();
    });
  });

  it('renders the list and selects the newest entry by default', async () => {
    (rpcMocks.listSkillQuarantined as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      workspace: 'personal',
      entries: [
        { name: 'newer-skill', path: '/q/newer-skill', mtimeMs: 2_000, hasSandboxRun: false },
        { name: 'older-skill', path: '/q/older-skill', mtimeMs: 1_000, hasSandboxRun: false },
      ],
    });
    (rpcMocks.proposeSkillReview as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      name: 'newer-skill',
      classification: 'personal',
      beforeContent: '',
      afterContent: '---\nstate: quarantined\n---\nbody',
      diffHash: 'a'.repeat(64),
      sandboxRunSummary: null,
    });

    render(<SkillReviewPage />);
    await waitFor(() => {
      expect(screen.getByText('newer-skill')).toBeTruthy();
      expect(screen.getByText('older-skill')).toBeTruthy();
    });
    // newest selected by default → propose-review fetched
    await waitFor(() => {
      expect(rpcMocks.proposeSkillReview).toHaveBeenCalledWith('newer-skill');
    });
  });

  it('renders the customer-confidential warn-banner when classification matches', async () => {
    (rpcMocks.listSkillQuarantined as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      workspace: 'personal',
      entries: [{ name: 'sensitive', path: '/q', mtimeMs: 1, hasSandboxRun: false }],
    });
    (rpcMocks.proposeSkillReview as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      name: 'sensitive',
      classification: 'customer-confidential',
      beforeContent: '',
      afterContent: '---\nstate: quarantined\n---\nbody',
      diffHash: 'b'.repeat(64),
      sandboxRunSummary: null,
    });

    render(<SkillReviewPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText(/Customer-Confidential/)).toBeTruthy();
    });
  });

  it('renders sandbox-run summary when present', async () => {
    (rpcMocks.listSkillQuarantined as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      workspace: 'personal',
      entries: [{ name: 'with-run', path: '/q', mtimeMs: 1, hasSandboxRun: true }],
    });
    (rpcMocks.proposeSkillReview as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      name: 'with-run',
      classification: 'personal',
      beforeContent: '',
      afterContent: '---\nstate: quarantined\n---\nbody',
      diffHash: 'c'.repeat(64),
      sandboxRunSummary: {
        skillName: 'with-run',
        runAtIso: '2026-05-28T12:00:00Z',
        durationMs: 42,
        outcome: 'ok',
        output: null,
        killedBy: null,
        errorMessage: null,
      },
    });

    render(<SkillReviewPage />);
    await waitFor(() => {
      expect(screen.getByText('Sandbox-Run')).toBeTruthy();
      expect(screen.getByText('42 ms')).toBeTruthy();
    });
  });

  it('opens the sign-info modal on click and shows the CLI hint', async () => {
    (rpcMocks.listSkillQuarantined as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      workspace: 'personal',
      entries: [{ name: 'sign-test', path: '/q', mtimeMs: 1, hasSandboxRun: false }],
    });
    (rpcMocks.proposeSkillReview as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      name: 'sign-test',
      classification: 'personal',
      beforeContent: '',
      afterContent: '---\nstate: quarantined\n---\nbody',
      diffHash: 'd'.repeat(64),
      sandboxRunSummary: null,
    });

    render(<SkillReviewPage />);
    await waitFor(() => screen.getByText('sign-test'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Signieren \+ aktivieren/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Signieren \+ aktivieren/ }));
    expect(screen.getByRole('dialog', { name: 'Skill signieren' })).toBeTruthy();
    expect(screen.getByText(/--signed-envelope/)).toBeTruthy();
  });

  it('renders inline error envelope when proposeReview returns an error', async () => {
    (rpcMocks.listSkillQuarantined as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      workspace: 'personal',
      entries: [{ name: 'errored', path: '/q', mtimeMs: 1, hasSandboxRun: false }],
    });
    (rpcMocks.proposeSkillReview as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: 'not-found',
      message: 'quarantined skill "errored" not found',
    });

    render(<SkillReviewPage />);
    await waitFor(() => screen.getByText(/not-found/));
    expect(screen.getByText(/not-found/)).toBeTruthy();
  });
});
