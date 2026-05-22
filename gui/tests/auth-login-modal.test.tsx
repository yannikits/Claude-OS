import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

class FakeTerminal {
  cols = 80;
  rows = 24;
  loadAddon = vi.fn();
  open = vi.fn();
  write = vi.fn();
  writeln = vi.fn();
  reset = vi.fn();
  dispose = vi.fn();
  onData(_cb: (data: string) => void): { dispose: () => void } {
    return { dispose: vi.fn() };
  }
}

class FakeFitAddon {
  fit = vi.fn();
}

class FakeWebLinksAddon {}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFitAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: FakeWebLinksAddon }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  invokeMock.mockReset();
  // biome-ignore lint/suspicious/noExplicitAny: test-stub for global polyfill
  (globalThis as any).ResizeObserver = FakeResizeObserver;
});

describe('AuthLoginModal', () => {
  it('mounts terminal-host and auto-invokes auth.login', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'auth.login') return { sessionId: 'fake-login-uuid' };
      throw new Error(`unmocked RPC: ${method}`);
    });

    const { AuthLoginModal } = await import('../src/components/auth-login-modal');
    render(<AuthLoginModal onClose={() => {}} />);

    expect(screen.getByTestId('auth-terminal-host')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /anthropic login/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'rpc_call',
        expect.objectContaining({ method: 'auth.login' }),
      );
    });
  });

  it('calls onClose when × header button clicked, kills active session', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'auth.login') return { sessionId: 'login-session-x' };
      if (method === 'pty.kill') return { ok: true };
      throw new Error(`unmocked RPC: ${method}`);
    });

    const onClose = vi.fn();
    const { AuthLoginModal } = await import('../src/components/auth-login-modal');
    render(<AuthLoginModal onClose={onClose} />);

    // Wait for auth.login to be invoked + session-id to land in ref
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'rpc_call',
        expect.objectContaining({ method: 'auth.login' }),
      );
    });

    fireEvent.click(screen.getByTitle(/schliessen/i));
    expect(onClose).toHaveBeenCalledTimes(1);
    // pty.kill should fire before close (best-effort cleanup)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'rpc_call',
        expect.objectContaining({ method: 'pty.kill', params: { sessionId: 'login-session-x' } }),
      );
    });
  });

  it('shows error banner when auth.login fails', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('sidecar offline');
    });

    const { AuthLoginModal } = await import('../src/components/auth-login-modal');
    render(<AuthLoginModal onClose={() => {}} />);

    expect(await screen.findByText(/sidecar offline/)).toBeInTheDocument();
  });
});
