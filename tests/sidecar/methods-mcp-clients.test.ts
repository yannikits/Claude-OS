import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  McpServerEntry,
  WatcherHandle,
  WatcherStatusEntry,
} from '../../src/domains/mcp-clients/index.js';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

let tmpRoot: string;
let envBackup: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-mcp-rpc-'));
  mkdirSync(tmpRoot, { recursive: true });
  writeFileSync(join(tmpRoot, '.claude-os-root'), '');
  envBackup = { ...process.env };
  process.env.CLAUDE_OS_ROOT = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = envBackup;
});

function makeEntry(name: string): McpServerEntry {
  return {
    name,
    host: 'claude-desktop',
    sourcePath: `/fake/${name}.json`,
    command: 'node',
    args: [],
    enabled: true,
  };
}

function fakeWatcher(
  snapshot: Map<string, WatcherStatusEntry>,
  reprobeImpl?: (k: string) => Promise<WatcherStatusEntry | null>,
): WatcherHandle {
  return {
    snapshot: () => snapshot,
    stop: async () => {},
    reprobe:
      reprobeImpl ??
      (async (key: string) => {
        return snapshot.get(key) ?? null;
      }),
  };
}

describe('mcp.clients.status RPC', () => {
  it('liefert empty count wenn Watcher noch nichts hat', async () => {
    const d = new RpcDispatcher();
    registerMethods(d, { mcpWatcher: fakeWatcher(new Map()) });
    const result = (await d.invoke('mcp.clients.status', {})) as {
      count: number;
      entries: unknown[];
    };
    expect(result.count).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('liefert Snapshot-Entries mit key/result/probedAt', async () => {
    const snapshot = new Map<string, WatcherStatusEntry>();
    snapshot.set('claude-desktop:alpha', {
      entry: makeEntry('alpha'),
      result: { kind: 'alive', toolsCount: 3, durationMs: 12, protocolVersion: '2024-11-05' },
      probedAt: '2026-05-20T12:00:00.000Z',
    });
    const d = new RpcDispatcher();
    registerMethods(d, { mcpWatcher: fakeWatcher(snapshot) });
    const result = (await d.invoke('mcp.clients.status', {})) as {
      count: number;
      entries: {
        key: string;
        result: { kind: string; toolsCount?: number };
        probedAt: string;
      }[];
    };
    expect(result.count).toBe(1);
    expect(result.entries[0]?.key).toBe('claude-desktop:alpha');
    expect(result.entries[0]?.result.kind).toBe('alive');
    expect(result.entries[0]?.result.toolsCount).toBe(3);
  });

  it('mcp.clients.status ist NICHT registriert wenn kein mcpWatcher-Opt mitgegeben', async () => {
    const d = new RpcDispatcher();
    registerMethods(d, {});
    await expect(d.invoke('mcp.clients.status', {})).rejects.toThrow(/MethodNotFound/);
  });
});

describe('mcp.clients.reprobe RPC', () => {
  it('triggered reprobe und gibt den neuen StatusEntry zurueck', async () => {
    const snapshot = new Map<string, WatcherStatusEntry>();
    snapshot.set('claude-desktop:alpha', {
      entry: makeEntry('alpha'),
      result: { kind: 'crashed', durationMs: 5, exitCode: 1, stderr: 'old' },
      probedAt: '2026-05-20T10:00:00.000Z',
    });
    const reprobeImpl = async (key: string) => {
      const prev = snapshot.get(key);
      if (prev === undefined) return null;
      // simulate reprobe that finds alive now
      const next: WatcherStatusEntry = {
        entry: prev.entry,
        result: { kind: 'alive', toolsCount: 2, durationMs: 7, protocolVersion: '2024-11-05' },
        probedAt: '2026-05-20T11:00:00.000Z',
      };
      snapshot.set(key, next);
      return next;
    };
    const d = new RpcDispatcher();
    registerMethods(d, { mcpWatcher: fakeWatcher(snapshot, reprobeImpl) });
    const result = (await d.invoke('mcp.clients.reprobe', {
      serverKey: 'claude-desktop:alpha',
    })) as {
      ok: boolean;
      key?: string;
      result?: { kind: string };
    };
    expect(result.ok).toBe(true);
    expect(result.key).toBe('claude-desktop:alpha');
    expect(result.result?.kind).toBe('alive');
  });

  it('liefert ok:false mit unknown-server-Code fuer nicht-existente serverKey', async () => {
    const d = new RpcDispatcher();
    registerMethods(d, { mcpWatcher: fakeWatcher(new Map()) });
    const result = (await d.invoke('mcp.clients.reprobe', { serverKey: 'nope' })) as {
      ok: boolean;
      code?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown-server');
  });

  it('wirft bei fehlendem oder leerem serverKey', async () => {
    const d = new RpcDispatcher();
    registerMethods(d, { mcpWatcher: fakeWatcher(new Map()) });
    await expect(d.invoke('mcp.clients.reprobe', { serverKey: '' })).rejects.toThrow(
      /non-empty string/,
    );
    await expect(d.invoke('mcp.clients.reprobe', {})).rejects.toThrow(/non-empty string/);
  });
});
