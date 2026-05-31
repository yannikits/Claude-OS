import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

// xterm.js + addons need canvas/measureText/etc. that happy-dom can't
// fully emulate. We mock the constructor surface to a stub-class so the
// React lifecycle runs but no real terminal-rendering happens.
const termWriteSpy = vi.fn();

class FakeTerminal {
  cols = 80;
  rows = 24;
  loadAddon = vi.fn();
  open = vi.fn();
  write = termWriteSpy;
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

vi.mock('../src/lib/sidecar-status', () => ({
  useSidecarOk: () => true,
  useSidecarStatus: () => ({ ok: true, failure: null }),
}));

// happy-dom doesn't ship ResizeObserver — provide a no-op so the
// terminal useEffect can install it without throwing.
class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}
beforeEach(() => {
  invokeMock.mockReset();
  termWriteSpy.mockReset();
  // biome-ignore lint/suspicious/noExplicitAny: test-stub for global polyfill
  (globalThis as any).ResizeObserver = FakeResizeObserver;
  // window.__TAURI_INTERNALS__ (Tauri transport) is set globally in
  // src/test/setup.ts.
});

// MC-C: "Claude Chat" — conversation only. No args input; spawns the locked
// `--tools ""` form and tags the call with mode:'chat'.
describe('ChatPage (chat mode)', () => {
  it('mounts terminal-host with Start button and NO args input', async () => {
    const { ChatPage } = await import('../src/pages');
    render(<ChatPage />);

    expect(await screen.findByTestId('terminal-host')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^start/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/claude args/i)).not.toBeInTheDocument();
  });

  it('Start spawns claude with --tools "" and mode:chat', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params: unknown };
      if (method === 'pty.spawn') {
        const p = params as { args: string[]; cols?: number; rows?: number; mode?: string };
        expect(p.args).toEqual(['--tools', '']);
        expect(p.mode).toBe('chat');
        expect(p.cols).toBe(80);
        expect(p.rows).toBe(24);
        return { sessionId: 'session-chat-0001' };
      }
      throw new Error(`unmocked RPC: ${method}`);
    });

    const { ChatPage } = await import('../src/pages');
    render(<ChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^start/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'rpc_call',
        expect.objectContaining({ method: 'pty.spawn' }),
      );
    });
  });

  it('surfaces RPC errors as banner-error', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('sidecar offline');
    });

    const { ChatPage } = await import('../src/pages');
    render(<ChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^start/i }));

    expect(await screen.findByText(/sidecar offline/)).toBeInTheDocument();
  });
});

// MC-C: "Claude Code" — full agent. Keeps the args input; spawns the
// free-text args and tags the call with mode:'code'.
describe('CodePage (code mode)', () => {
  it('mounts terminal-host with Spawn button and args input', async () => {
    const { CodePage } = await import('../src/pages');
    render(<CodePage />);

    expect(await screen.findByTestId('terminal-host')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^spawn/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/claude args/i)).toBeInTheDocument();
  });

  it('Spawn invokes pty.spawn with the trimmed args, size, and mode:code', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params: unknown };
      if (method === 'pty.spawn') {
        const p = params as { args: string[]; cols?: number; rows?: number; mode?: string };
        expect(p.args).toEqual(['--help']);
        expect(p.mode).toBe('code');
        expect(p.cols).toBe(80);
        expect(p.rows).toBe(24);
        return { sessionId: 'session-code-0001' };
      }
      throw new Error(`unmocked RPC: ${method}`);
    });

    const { CodePage } = await import('../src/pages');
    render(<CodePage />);

    fireEvent.click(await screen.findByRole('button', { name: /^spawn/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'rpc_call',
        expect.objectContaining({ method: 'pty.spawn' }),
      );
    });
  });

  it('shows running state and Stop button after spawn resolves', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'pty.spawn') return { sessionId: 'session-X' };
      if (method === 'pty.kill') return { ok: true };
      throw new Error(`unmocked RPC: ${method}`);
    });

    const { CodePage } = await import('../src/pages');
    render(<CodePage />);

    fireEvent.click(await screen.findByRole('button', { name: /^spawn/i }));

    expect(await screen.findByRole('button', { name: /stop/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^spawn$/i })).not.toBeInTheDocument();
  });
});
