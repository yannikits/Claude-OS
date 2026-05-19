import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

function setupRpc() {
  invokeMock.mockImplementation(async (cmd, args) => {
    if (cmd !== 'rpc_call') return null;
    const { method } = args as { method: string };
    switch (method) {
      case 'ping':
        return { pong: true, ts: 1234 };
      case 'catalog.list':
        return {
          catalogPath: '/tmp/catalog.json',
          lockPath: '/tmp/catalog.lock.json',
          lockResolvedAt: null,
          entries: [
            { id: 'a', kind: 'skill', source: 'local:.', enabled: true, scope: 'user' },
            { id: 'b', kind: 'plugin', source: 'github:x/y', enabled: false, scope: 'project' },
          ],
        };
      case 'vault.status':
        return {
          vaultPath: '/tmp/vault',
          busy: null,
          config: { conflictMode: 'abort', scheduleEnabled: true, idleSeconds: 60 },
        };
      case 'agent.list':
        return { count: 7, items: [] };
      default:
        throw new Error(`unmocked RPC: ${method}`);
    }
  });
}

describe('Dashboard', () => {
  it('rendert alle 4 Cards mit RPC-Daten', async () => {
    setupRpc();
    const { Dashboard } = await import('../src/pages');

    render(<Dashboard />);

    expect(await screen.findByRole('heading', { level: 3, name: /sidecar/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /catalog/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /vault/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /agent runs/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/OK — ts 1234/)).toBeInTheDocument();
      expect(screen.getByText(/2 Einträge/)).toBeInTheDocument();
      expect(screen.getByText(/abort · busy=no/)).toBeInTheDocument();
      expect(screen.getByText(/7 aufgezeichnet/)).toBeInTheDocument();
    });
  });

  it('zeigt Error-Banner wenn RPC failed', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('sidecar offline');
    });
    const { Dashboard } = await import('../src/pages');

    render(<Dashboard />);

    const errors = await screen.findAllByText(/RPC-Fehler: sidecar offline/);
    expect(errors.length).toBe(4);
  });
});
