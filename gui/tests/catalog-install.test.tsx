import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

describe('CatalogPage Install-Form', () => {
  it('zeigt das Install-Form nach Klick auf "+ Install"', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'catalog.list') {
        return {
          catalogPath: '/tmp/catalog.json',
          lockPath: '/tmp/catalog.lock.json',
          lockResolvedAt: null,
          entries: [],
        };
      }
      throw new Error(`unmocked: ${method}`);
    });
    const { CatalogPage } = await import('../src/pages');
    render(<CatalogPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '+ Install' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Install' }));
    expect(screen.getByPlaceholderText('github:acme/my-plugin')).toBeInTheDocument();
    expect(screen.getByText('Install mit Auto-Deps')).toBeInTheDocument();
  });

  it('zeigt Success-Banner nach erfolgreichem Install', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method, params } = args as { method: string; params: unknown };
      if (method === 'catalog.list') {
        return {
          catalogPath: '/tmp/catalog.json',
          lockPath: '/tmp/catalog.lock.json',
          lockResolvedAt: null,
          entries: [],
        };
      }
      if (method === 'catalog.installAutoDeps') {
        const p = params as { source: string };
        return {
          ok: true,
          target: { id: 'my-plugin', version: '1.0.0' },
          newEntries: [],
          iterations: 1,
          catalogPath: '/tmp/catalog.json',
          lockPath: '/tmp/catalog.lock.json',
          lockWarnings: [],
          applied: 1,
          skipped: 0,
          errors: [],
          _source: p.source,
        };
      }
      throw new Error(`unmocked: ${method}`);
    });
    const { CatalogPage } = await import('../src/pages');
    render(<CatalogPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '+ Install' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Install' }));
    fireEvent.change(screen.getByPlaceholderText('github:acme/my-plugin'), {
      target: { value: 'github:test/repo' },
    });
    fireEvent.change(screen.getByPlaceholderText('C:\\path\\to\\marketplace.json'), {
      target: { value: '/tmp/registry.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install mit Auto-Deps' }));
    await waitFor(() => {
      expect(screen.getByText(/my-plugin@1\.0\.0 installiert/)).toBeInTheDocument();
    });
  });

  it('zeigt Error-Banner bei Install-Failure', async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd !== 'rpc_call') return null;
      const { method } = args as { method: string };
      if (method === 'catalog.list') {
        return {
          catalogPath: '/tmp/catalog.json',
          lockPath: '/tmp/catalog.lock.json',
          lockResolvedAt: null,
          entries: [],
        };
      }
      if (method === 'catalog.installAutoDeps') {
        return { ok: false, code: 'missing-provider', message: 'no provider found' };
      }
      throw new Error(`unmocked: ${method}`);
    });
    const { CatalogPage } = await import('../src/pages');
    render(<CatalogPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '+ Install' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Install' }));
    fireEvent.change(screen.getByPlaceholderText('github:acme/my-plugin'), {
      target: { value: 'github:test/repo' },
    });
    fireEvent.change(screen.getByPlaceholderText('C:\\path\\to\\marketplace.json'), {
      target: { value: '/tmp/registry.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install mit Auto-Deps' }));
    await waitFor(() => {
      expect(screen.getByText(/missing-provider/)).toBeInTheDocument();
      expect(screen.getByText(/no provider found/)).toBeInTheDocument();
    });
  });
});
