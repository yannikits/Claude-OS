import { EventEmitter, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  type McpServerEntry,
  probeServer,
  probeServers,
} from '../../../src/domains/mcp-clients/index.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: Writable & { write: (chunk: string) => boolean };
  killed: boolean;
  kill: (signal?: string) => boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  const writes: string[] = [];
  child.stdin = Object.assign(new Writable(), {
    write: (chunk: string | Buffer) => {
      writes.push(chunk.toString('utf8'));
      return true;
    },
  }) as FakeChild['stdin'];
  (child as { writes: string[] }).writes = writes;
  child.kill = vi.fn((_signal?: string) => {
    child.killed = true;
    setImmediate(() => child.emit('exit', 0, null));
    return true;
  });
  return child;
}

function makeEntry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name: 'test',
    host: 'claude-desktop',
    sourcePath: '/fake.json',
    command: 'node',
    args: ['server.js'],
    enabled: true,
    ...overrides,
  };
}

describe('probeServer — alive Pfad', () => {
  it('liefert kind:alive nach initialize + tools/list', async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild);

    // Simuliere MCP-Server-Responses kurz nach spawn.
    setImmediate(() => {
      fakeChild.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2024-11-05', capabilities: {} },
          })}\n`,
          'utf8',
        ),
      );
      setImmediate(() => {
        fakeChild.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: { tools: [{ name: 't1' }, { name: 't2' }, { name: 't3' }] },
            })}\n`,
            'utf8',
          ),
        );
      });
    });

    const result = await probeServer(makeEntry(), {
      spawnFn: spawnFn as never,
      timeoutMs: 2000,
    });
    expect(result.kind).toBe('alive');
    if (result.kind === 'alive') {
      expect(result.toolsCount).toBe(3);
      expect(result.protocolVersion).toBe('2024-11-05');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('probeServer — Fehler-Pfade', () => {
  it('init-timeout wenn keine Response innerhalb timeoutMs kommt', async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild);
    const result = await probeServer(makeEntry(), {
      spawnFn: spawnFn as never,
      timeoutMs: 100,
    });
    expect(result.kind).toBe('init-timeout');
  });

  it('crashed wenn Child vor Init-Response exited', async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild);
    setImmediate(() => {
      fakeChild.stderr.emit('data', Buffer.from('boom\n', 'utf8'));
      fakeChild.emit('exit', 1, null);
    });
    const result = await probeServer(makeEntry(), {
      spawnFn: spawnFn as never,
      timeoutMs: 2000,
    });
    expect(result.kind).toBe('crashed');
    if (result.kind === 'crashed') {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('boom');
    }
  });

  it('protocol-error wenn Server JSON-RPC-error zurueckgibt', async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild);
    setImmediate(() => {
      fakeChild.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32601, message: 'method not found' },
          })}\n`,
          'utf8',
        ),
      );
    });
    const result = await probeServer(makeEntry(), {
      spawnFn: spawnFn as never,
      timeoutMs: 2000,
    });
    expect(result.kind).toBe('protocol-error');
  });

  it('spawn-failed wenn spawn-Aufruf throws', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const result = await probeServer(makeEntry(), {
      spawnFn: spawnFn as never,
      timeoutMs: 2000,
    });
    expect(result.kind).toBe('spawn-failed');
    if (result.kind === 'spawn-failed') {
      expect(result.message).toMatch(/ENOENT/);
    }
  });

  it('ignoriert nicht-JSON-Output statt zu crashen', async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild);
    setImmediate(() => {
      fakeChild.stdout.emit('data', Buffer.from('garbage line\nmore garbage\n', 'utf8'));
      // Dann erst valid response
      setImmediate(() => {
        fakeChild.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } })}\n`,
            'utf8',
          ),
        );
        setImmediate(() => {
          fakeChild.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } })}\n`,
              'utf8',
            ),
          );
        });
      });
    });
    const result = await probeServer(makeEntry(), {
      spawnFn: spawnFn as never,
      timeoutMs: 2000,
    });
    expect(result.kind).toBe('alive');
  });
});

describe('probeServer — Cleanup (Codex-Finding HIGH #1)', () => {
  it('sendet SIGKILL wenn SIGTERM den Process nicht beendet (childExited-flag)', async () => {
    // FakeChild der SIGTERM ignoriert: kill('SIGTERM') setzt zwar killed=true,
    // emittiert aber KEIN exit-Event. Erst SIGKILL killed wirklich.
    const fakeChild = makeFakeChild();
    const killCalls: string[] = [];
    fakeChild.kill = vi.fn((signal?: string) => {
      killCalls.push(signal ?? 'SIGTERM');
      if (signal === 'SIGKILL') {
        // SIGKILL beendet wirklich
        setImmediate(() => fakeChild.emit('exit', null, 'SIGKILL'));
      }
      // SIGTERM: no-op, kein exit-Event
      return true;
    });
    const spawnFn = vi.fn(() => fakeChild);

    // Trigger init-timeout damit finish() laeuft
    const result = await probeServer(makeEntry(), {
      spawnFn: spawnFn as never,
      timeoutMs: 50,
    });
    expect(result.kind).toBe('init-timeout');

    // Warten bis der SIGKILL-Fallback (1s) gefeuert hat
    await new Promise((r) => setTimeout(r, 1100));
    expect(killCalls).toContain('SIGTERM');
    expect(killCalls).toContain('SIGKILL');
  });
});

describe('probeServers — parallel', () => {
  it('probt mehrere Server mit beschraenkter concurrency', async () => {
    const fake = () => {
      const c = makeFakeChild();
      setImmediate(() => {
        c.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } })}\n`,
            'utf8',
          ),
        );
        setImmediate(() => {
          c.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } })}\n`,
              'utf8',
            ),
          );
        });
      });
      return c;
    };
    const spawnFn = vi.fn(fake);
    const entries = [
      makeEntry({ name: 'a' }),
      makeEntry({ name: 'b' }),
      makeEntry({ name: 'c' }),
      makeEntry({ name: 'd' }),
    ];
    const results = await probeServers(entries, { spawnFn: spawnFn as never, concurrency: 2 });
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.result.kind === 'alive')).toBe(true);
  });
});
