import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

type Handler = (event: { payload: unknown }) => void;
const eventBus = new Map<string, Set<Handler>>();
const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: Handler) => {
    const set = eventBus.get(event) ?? new Set<Handler>();
    set.add(handler);
    eventBus.set(event, set);
    return () => {
      set.delete(handler);
    };
  },
}));

function emit(event: string, payload: unknown): void {
  const set = eventBus.get(event);
  if (set === undefined) return;
  for (const h of set) h({ payload });
}

describe('McpClientsPage', () => {
  it('rendert die mcp.clients.status-Antwort als Tabelle', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'mcp.clients.status') {
        return {
          count: 2,
          entries: [
            {
              key: 'claude-desktop:alpha',
              entry: {
                name: 'alpha',
                host: 'claude-desktop',
                sourcePath: '/fake/alpha.json',
                command: 'node',
                args: [],
                enabled: true,
              },
              result: {
                kind: 'alive',
                toolsCount: 5,
                durationMs: 23,
                protocolVersion: '2024-11-05',
              },
              probedAt: '2026-05-20T12:00:00.000Z',
            },
            {
              key: 'claude-code-user:broken',
              entry: {
                name: 'broken',
                host: 'claude-code-user',
                sourcePath: '/fake/broken.json',
                command: 'node',
                args: [],
                enabled: true,
              },
              result: { kind: 'crashed', durationMs: 5, exitCode: 1, stderr: 'boom' },
              probedAt: '2026-05-20T12:00:00.000Z',
            },
          ],
        };
      }
      throw new Error(`unmocked: ${method}`);
    });
    const { McpClientsPage } = await import('../src/pages');
    render(<McpClientsPage />);
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeInTheDocument();
    });
    expect(screen.getByText('alive')).toBeInTheDocument();
    expect(screen.getByText('crashed')).toBeInTheDocument();
    expect(screen.getByText(/5 Tools/)).toBeInTheDocument();
  });

  it('zeigt empty-state wenn keine Server entdeckt', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'mcp.clients.status') return { count: 0, entries: [] };
      throw new Error(`unmocked: ${method}`);
    });
    const { McpClientsPage } = await import('../src/pages');
    render(<McpClientsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Noch keine MCP-Server entdeckt/)).toBeInTheDocument();
    });
  });

  it('refetched bei status-changed-Event', async () => {
    eventBus.clear();
    let callCount = 0;
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'mcp.clients.status') {
        callCount++;
        return { count: 0, entries: [] };
      }
      throw new Error(`unmocked: ${method}`);
    });
    const { McpClientsPage } = await import('../src/pages');
    render(<McpClientsPage />);
    await waitFor(() => {
      expect(callCount).toBe(1);
    });
    emit('mcp-client://event', {
      type: 'status-changed',
      timestamp: '2026-05-20T12:00:00.000Z',
      serverKey: 'x:y',
      kind: 'alive',
    });
    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });
});
