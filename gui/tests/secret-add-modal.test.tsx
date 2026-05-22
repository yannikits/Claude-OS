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

describe('SecretAddModal', () => {
  it('renders warn-banner, key-input, password-type value-input, submit-button', async () => {
    const { SecretAddModal } = await import('../src/components/secret-add-modal');
    render(<SecretAddModal onClose={() => {}} onSaved={() => {}} />);

    expect(screen.getByTestId('secret-warn-banner').textContent).toMatch(/IPC/);
    expect(screen.getByTestId('secret-key-input')).toBeInTheDocument();
    const valueInput = screen.getByTestId('secret-value-input') as HTMLInputElement;
    expect(valueInput.type).toBe('password');
    expect(valueInput.autocomplete).toBe('new-password');
    expect(screen.getByTestId('secret-submit')).toBeInTheDocument();
  });

  it('submit calls secrets.set with key+value, then clears value-state and closes', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params: unknown };
      if (method === 'secrets.set') {
        const p = params as { key: string; value: string };
        expect(p.key).toBe('TEST_KEY');
        expect(p.value).toBe('super-secret-value');
        return { key: p.key, backend: 'encrypted-file', updated: false };
      }
      throw new Error(`unmocked: ${method}`);
    });

    const onClose = vi.fn();
    const onSaved = vi.fn();
    const { SecretAddModal } = await import('../src/components/secret-add-modal');
    render(<SecretAddModal onClose={onClose} onSaved={onSaved} />);

    const keyInput = screen.getByTestId('secret-key-input') as HTMLInputElement;
    const valueInput = screen.getByTestId('secret-value-input') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'TEST_KEY' } });
    fireEvent.change(valueInput, { target: { value: 'super-secret-value' } });
    fireEvent.click(screen.getByTestId('secret-submit'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'rpc_call',
        expect.objectContaining({ method: 'secrets.set' }),
      );
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('shows specific error message for secrets-backend-locked', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('secrets-backend-locked');
    });

    const { SecretAddModal } = await import('../src/components/secret-add-modal');
    render(<SecretAddModal onClose={() => {}} onSaved={() => {}} />);

    fireEvent.change(screen.getByTestId('secret-key-input'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('secret-value-input'), { target: { value: 'Y' } });
    fireEvent.click(screen.getByTestId('secret-submit'));

    expect(await screen.findByText(/CLAUDE_OS_SECRETS_KEY/)).toBeInTheDocument();
  });

  it('does not submit when key is empty', async () => {
    const onClose = vi.fn();
    const { SecretAddModal } = await import('../src/components/secret-add-modal');
    render(<SecretAddModal onClose={onClose} onSaved={() => {}} />);

    // value present, key empty
    fireEvent.change(screen.getByTestId('secret-value-input'), { target: { value: 'foo' } });
    const submit = screen.getByTestId('secret-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    // wait a tick to confirm no RPC fired
    await new Promise((r) => setTimeout(r, 50));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
