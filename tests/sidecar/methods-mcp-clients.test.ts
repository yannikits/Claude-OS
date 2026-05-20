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

function fakeWatcher(snapshot: Map<string, WatcherStatusEntry>): WatcherHandle {
  return {
    snapshot: () => snapshot,
    stop: async () => {},
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
