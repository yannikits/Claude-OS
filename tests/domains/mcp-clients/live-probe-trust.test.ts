/**
 * M3 (2026-05-21 code-review): live-probe trust-gating tests —
 * verifiziert dass `probeServer(entry, {isTrusted, serverKey})` den
 * spawn-Pfad NICHT betritt wenn isTrusted(serverKey) false retourniert.
 */
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerEntry } from '../../../src/domains/mcp-clients/index.js';
import { probeServer, probeServers } from '../../../src/domains/mcp-clients/index.js';

function makeEntry(name: string): McpServerEntry {
  return {
    host: 'local',
    name,
    command: '/bin/never-spawned',
    args: [],
    enabled: true,
  };
}

describe('live-probe — M3 trust-gating', () => {
  it('returns trust-required ohne spawn wenn isTrusted false', async () => {
    const spawnSpy = vi.fn() as unknown as (...args: unknown[]) => ChildProcess;
    const entry = makeEntry('untrusted-server');
    const result = await probeServer(entry, {
      isTrusted: () => false,
      serverKey: 'local:untrusted-server',
      spawnFn: spawnSpy as unknown as typeof import('node:child_process').spawn,
    });
    expect(result.kind).toBe('trust-required');
    if (result.kind === 'trust-required') {
      expect(result.serverKey).toBe('local:untrusted-server');
      expect(result.message).toMatch(/User-Acknowledge erforderlich/);
    }
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('isTrusted true ueberspringt den trust-gate, spawn wird gerufen', async () => {
    let spawned = false;
    const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    const fakeChild = {
      stdin: { write: () => true, end: () => {} },
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, cb: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === 'exit') exitListeners.push(cb);
      },
      once: (event: string, cb: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === 'exit') exitListeners.push(cb);
      },
      kill: () => {
        setTimeout(() => {
          for (const cb of exitListeners) cb(0, null);
        }, 1);
        return true;
      },
      pid: 12345,
      killed: false,
    };
    const fakeSpawn = (() => {
      spawned = true;
      return fakeChild as unknown as ChildProcess;
    }) as unknown as typeof import('node:child_process').spawn;

    const result = await probeServer(makeEntry('trusted'), {
      isTrusted: () => true,
      serverKey: 'local:trusted',
      spawnFn: fakeSpawn,
      timeoutMs: 100,
    });
    expect(spawned).toBe(true);
    // Da der fake-child kein valider MCP-init liefert, kriegen wir
    // crashed/init-timeout — Hauptsache NICHT trust-required.
    expect(result.kind).not.toBe('trust-required');
  });

  it('isTrusted ohne serverKey → internal-bug spawn-failed (kein crash, kein spawn)', async () => {
    const spawnSpy = vi.fn() as unknown as (...args: unknown[]) => ChildProcess;
    const result = await probeServer(makeEntry('any'), {
      isTrusted: () => true,
      spawnFn: spawnSpy as unknown as typeof import('node:child_process').spawn,
    });
    expect(result.kind).toBe('spawn-failed');
    if (result.kind === 'spawn-failed') {
      expect(result.message).toMatch(/M3.*serverKey/);
    }
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('probeServers — M3 batch trust-gating', () => {
  it('per-entry serverKey via serverKeyFor; mixed trust-state', async () => {
    const spawned: string[] = [];
    const makeFakeChild = (): ChildProcess => {
      const exitListeners: Array<(c: number | null, s: NodeJS.Signals | null) => void> = [];
      return {
        stdin: { write: () => true, end: () => {} },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: (c: number | null, s: NodeJS.Signals | null) => void) => {
          if (event === 'exit') exitListeners.push(cb);
        },
        once: (event: string, cb: (c: number | null, s: NodeJS.Signals | null) => void) => {
          if (event === 'exit') exitListeners.push(cb);
        },
        kill: () => {
          setTimeout(() => {
            for (const cb of exitListeners) cb(0, null);
          }, 1);
          return true;
        },
        pid: 1,
        killed: false,
      } as unknown as ChildProcess;
    };
    const fakeSpawn = ((cmd: string) => {
      spawned.push(cmd);
      return makeFakeChild();
    }) as unknown as typeof import('node:child_process').spawn;

    const entries = [makeEntry('a'), makeEntry('b'), makeEntry('c')];
    const trusted = new Set(['local:a', 'local:c']);
    const results = await probeServers(entries, {
      isTrusted: (k) => trusted.has(k),
      serverKeyFor: (e) => `local:${e.name}`,
      spawnFn: fakeSpawn,
      timeoutMs: 50,
      concurrency: 1,
    });
    expect(results.length).toBe(3);
    const byName = new Map(results.map((r) => [r.entry.name, r.result.kind]));
    expect(byName.get('b')).toBe('trust-required');
    expect(byName.get('a')).not.toBe('trust-required');
    expect(byName.get('c')).not.toBe('trust-required');
    // spawn wurde fuer a und c gerufen, NICHT fuer b
    expect(spawned.length).toBe(2);
  });
});
