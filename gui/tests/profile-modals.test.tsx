import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

vi.mock('../src/lib/sidecar-status', () => ({
  useSidecarOk: () => true,
  useSidecarStatus: () => ({ ok: true, failure: null }),
}));

beforeEach(() => {
  invokeMock.mockReset();
});

describe('ProfileCreateModal', () => {
  it('rejects invalid name (whitespace, slashes) — submit stays disabled', async () => {
    const { ProfileCreateModal } = await import('../src/components/profile-create-modal');
    render(<ProfileCreateModal onClose={() => {}} onSaved={() => {}} />);
    const input = screen.getByTestId('profile-name-input') as HTMLInputElement;
    const submit = screen.getByTestId('profile-create-submit') as HTMLButtonElement;

    // Initially disabled (empty)
    expect(submit.disabled).toBe(true);

    // Invalid: spaces
    fireEvent.change(input, { target: { value: 'has space' } });
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/Erlaubt: A-Z a-z 0-9/)).toBeInTheDocument();

    // Invalid: slash
    fireEvent.change(input, { target: { value: 'has/slash' } });
    expect(submit.disabled).toBe(true);

    // Valid
    fireEvent.change(input, { target: { value: 'work' } });
    expect(submit.disabled).toBe(false);
  });

  it('submit calls settings.createProfile with trimmed name', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params: unknown };
      if (method === 'settings.createProfile') {
        expect((params as { name: string }).name).toBe('work');
        return { name: 'work', configDir: '/tmp/work', active: false };
      }
      throw new Error(`unmocked: ${method}`);
    });

    const onSaved = vi.fn();
    const onClose = vi.fn();
    const { ProfileCreateModal } = await import('../src/components/profile-create-modal');
    render(<ProfileCreateModal onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByTestId('profile-name-input'), { target: { value: '  work  ' } });
    fireEvent.click(screen.getByTestId('profile-create-submit'));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('shows profile-exists error when duplicate', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('profile-exists: Profile "dup" already exists at /tmp/dup');
    });
    const { ProfileCreateModal } = await import('../src/components/profile-create-modal');
    render(<ProfileCreateModal onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByTestId('profile-name-input'), { target: { value: 'dup' } });
    fireEvent.click(screen.getByTestId('profile-create-submit'));
    expect(await screen.findByText(/Profil "dup" existiert bereits/)).toBeInTheDocument();
  });
});

describe('ProfileDeleteModal', () => {
  it('keeps delete button disabled until user types exact profile name', async () => {
    const { ProfileDeleteModal } = await import('../src/components/profile-delete-modal');
    render(
      <ProfileDeleteModal
        name="doomed"
        configDir="/tmp/doomed"
        onClose={() => {}}
        onDeleted={() => {}}
      />,
    );
    const confirmInput = screen.getByTestId('profile-confirm-input') as HTMLInputElement;
    const submit = screen.getByTestId('profile-delete-submit') as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    fireEvent.change(confirmInput, { target: { value: 'doome' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(confirmInput, { target: { value: 'doomed' } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(confirmInput, { target: { value: 'DOOMED' } });
    expect(submit.disabled).toBe(true); // case-sensitive
  });

  it('shows configDir in warn-banner', async () => {
    const { ProfileDeleteModal } = await import('../src/components/profile-delete-modal');
    render(
      <ProfileDeleteModal
        name="doomed"
        configDir="/abs/path/to/doomed"
        onClose={() => {}}
        onDeleted={() => {}}
      />,
    );
    expect(screen.getByTestId('profile-delete-warn').textContent).toMatch(
      /\/abs\/path\/to\/doomed/,
    );
  });

  it('submit calls settings.deleteProfile and triggers onDeleted+onClose', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params: unknown };
      if (method === 'settings.deleteProfile') {
        expect((params as { name: string }).name).toBe('doomed');
        return { name: 'doomed', deleted: true, configDir: '/tmp/doomed' };
      }
      throw new Error(`unmocked: ${method}`);
    });

    const onDeleted = vi.fn();
    const onClose = vi.fn();
    const { ProfileDeleteModal } = await import('../src/components/profile-delete-modal');
    render(
      <ProfileDeleteModal
        name="doomed"
        configDir="/tmp/doomed"
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.change(screen.getByTestId('profile-confirm-input'), { target: { value: 'doomed' } });
    fireEvent.click(screen.getByTestId('profile-delete-submit'));
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('shows specific error when active-profile-delete refused', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error(
        'settings.deleteProfile: cannot delete active profile "work"; switch to another profile first.',
      );
    });
    const { ProfileDeleteModal } = await import('../src/components/profile-delete-modal');
    render(
      <ProfileDeleteModal
        name="work"
        configDir="/tmp/work"
        onClose={() => {}}
        onDeleted={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('profile-confirm-input'), { target: { value: 'work' } });
    fireEvent.click(screen.getByTestId('profile-delete-submit'));
    expect(await screen.findByText(/Profil ist aktiv/)).toBeInTheDocument();
  });
});
