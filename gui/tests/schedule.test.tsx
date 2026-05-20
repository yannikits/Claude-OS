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

describe('SchedulePage', () => {
  it('rendert die schedule.list-Antwort als Tabelle', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'schedule.list') {
        return {
          count: 2,
          entries: [
            {
              id: 'morning-sync',
              cron: '0 8 * * *',
              command: 'claude-os vault snapshot',
              createdAt: '2026-05-20T00:00:00.000Z',
              enabled: true,
              next: '2026-05-21T08:00:00.000Z',
            },
            {
              id: 'weekly',
              cron: '0 18 * * 0',
              command: 'echo hi',
              createdAt: '2026-05-20T00:00:00.000Z',
              enabled: false,
              next: null,
            },
          ],
        };
      }
      throw new Error(`unmocked: ${method}`);
    });
    const { SchedulePage } = await import('../src/pages');
    render(<SchedulePage />);
    await waitFor(() => {
      expect(screen.getByText('morning-sync')).toBeInTheDocument();
    });
    expect(screen.getByText('0 8 * * *')).toBeInTheDocument();
    expect(screen.getByText('on')).toBeInTheDocument();
    expect(screen.getByText('off')).toBeInTheDocument();
  });

  it('zeigt empty-state wenn keine Eintraege', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'schedule.list') return { count: 0, entries: [] };
      throw new Error(`unmocked: ${method}`);
    });
    const { SchedulePage } = await import('../src/pages');
    render(<SchedulePage />);
    await waitFor(() => {
      expect(screen.getByText(/Noch keine Schedule-Eintraege/)).toBeInTheDocument();
    });
  });

  it('appended Live-Events aus dem schedule://event-Channel', async () => {
    eventBus.clear();
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'schedule.list') return { count: 0, entries: [] };
      throw new Error(`unmocked: ${method}`);
    });
    const { SchedulePage } = await import('../src/pages');
    render(<SchedulePage />);
    await waitFor(() => {
      expect(screen.getByText(/noch keine Events/i)).toBeInTheDocument();
    });
    emit('schedule://event', {
      type: 'fire',
      entryId: 'morning-sync',
      timestamp: '2026-05-21T08:00:00.000Z',
    });
    await waitFor(() => {
      expect(screen.getByText('morning-sync')).toBeInTheDocument();
      // 'fire' erscheint sowohl im Tag-Span als auch im Detail-td —
      // getAllByText reicht. Mindestens 1 Treffer = das Event ist eingetroffen.
      expect(screen.getAllByText('fire').length).toBeGreaterThan(0);
    });
  });
});
