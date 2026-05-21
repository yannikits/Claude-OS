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
// ChatPage useEffect can install it without throwing.
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
});

describe('ChatPage', () => {
  it('mounts terminal-host and shows Spawn button', async () => {
    const { ChatPage } = await import('../src/pages');
    render(<ChatPage />);

    expect(await screen.findByTestId('terminal-host')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /spawn/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/claude args/i)).toBeInTheDocument();
  });

  it('Spawn click invokes pty.spawn with the trimmed args and current size', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params: unknown };
      if (method === 'pty.spawn') {
        // sanity-check the payload shape — args[], cols, rows.
        const p = params as { args: string[]; cols?: number; rows?: number };
        expect(p.args).toEqual(['--help']);
        expect(p.cols).toBe(80);
        expect(p.rows).toBe(24);
        return { sessionId: 'session-fake-uuid-0001' };
      }
      throw new Error(`unmocked RPC: ${method}`);
    });

    const { ChatPage } = await import('../src/pages');
    render(<ChatPage />);

    const spawnBtn = await screen.findByRole('button', { name: /^spawn/i });
    fireEvent.click(spawnBtn);

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

    const { ChatPage } = await import('../src/pages');
    render(<ChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^spawn/i }));

    expect(await screen.findByRole('button', { name: /stop/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^spawn$/i })).not.toBeInTheDocument();
  });

  it('surface RPC errors as banner-error', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('sidecar offline');
    });

    const { ChatPage } = await import('../src/pages');
    render(<ChatPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^spawn/i }));

    expect(await screen.findByText(/sidecar offline/)).toBeInTheDocument();
  });
});
