import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const listenMock = vi.fn(async () => () => {});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...(args as [])),
}));

async function loadApp() {
  const mod = await import('../src/App');
  return mod.App;
}

describe('App startup', () => {
  it('zeigt LoadingScreen während ping() noch nicht aufgelöst hat', async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));

    const App = await loadApp();
    render(<App />);

    expect(await screen.findByText(/claude-os startet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Dashboard/i)).not.toBeInTheDocument();
  });

  it('blendet LoadingScreen aus sobald ping() resolved', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'rpc_call') return { pong: true, ts: 42 };
      return null;
    });

    const App = await loadApp();
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText(/claude-os startet/i)).not.toBeInTheDocument();
    });
  });
});
