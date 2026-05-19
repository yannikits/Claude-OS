import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

type Handler = (e: { payload: unknown }) => void;
const listeners = new Map<string, Handler>();
function emit(event: string, payload: unknown) {
  const h = listeners.get(event);
  if (h) h({ payload });
}

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: Handler) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
}));

describe('DragDrop → inbox.import', () => {
  it('ruft inbox.import bei files://dropped Event auf', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params?: unknown };
      if (method === 'ping') return { pong: true, ts: 1 };
      if (method === 'inbox.import') {
        const p = params as { paths: string[] };
        return { count: p.paths.length, paths: p.paths };
      }
      return {};
    });

    const { App } = await import('../src/App');
    render(<App />);

    await waitFor(() => {
      expect(listeners.has('files://dropped')).toBe(true);
    });

    emit('files://dropped', { paths: ['C:\\tmp\\a.txt', 'C:\\tmp\\b.txt'] });

    await waitFor(() => {
      const importCalls = invokeMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'rpc_call' && (args as { method: string }).method === 'inbox.import',
      );
      expect(importCalls).toHaveLength(1);
      const argsPart = importCalls[0]?.[1] as { params: { paths: string[] } };
      expect(argsPart.params.paths).toEqual(['C:\\tmp\\a.txt', 'C:\\tmp\\b.txt']);
    });
  });
});
