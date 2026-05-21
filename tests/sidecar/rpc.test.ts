import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RpcDispatcher, runRpcServer } from '../../src/sidecar/rpc.js';

function makeStreams(lines: string[]) {
  const input = Readable.from(`${lines.join('\n')}\n`);
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf-8'));
      cb();
    },
  });
  return { input, output, chunks };
}

describe('RpcDispatcher', () => {
  it('returns -32700 (Parse error) on malformed JSON', async () => {
    const d = new RpcDispatcher();
    const r = await d.handle('not json');
    expect(r).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
  });

  it('returns -32600 (Invalid Request) when jsonrpc field is missing', async () => {
    const d = new RpcDispatcher();
    const r = await d.handle(JSON.stringify({ method: 'ping', id: 1 }));
    expect(r).toMatchObject({ id: 1, error: { code: -32600 } });
  });

  it('returns -32601 (Method not found) on unknown method', async () => {
    const d = new RpcDispatcher();
    const r = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unknown' }));
    expect(r).toMatchObject({ id: 1, error: { code: -32601 } });
  });

  it('dispatches a registered handler and returns its result', async () => {
    const d = new RpcDispatcher();
    d.register('ping', () => ({ pong: true }));
    const r = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' }));
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 42, result: { pong: true } });
  });

  it('passes params through to the handler', async () => {
    const d = new RpcDispatcher();
    d.register('echo', (params) => params);
    const r = await d.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'echo', params: { a: 1 } }),
    );
    expect(r).toMatchObject({ id: 7, result: { a: 1 } });
  });

  it('wraps thrown errors into -32000 with the error message', async () => {
    const d = new RpcDispatcher();
    d.register('boom', () => {
      throw new Error('kaboom');
    });
    const r = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'boom' }));
    expect(r).toMatchObject({ id: 1, error: { code: -32000, message: 'kaboom' } });
  });

  it('treats requests without id as notifications and returns null', async () => {
    const d = new RpcDispatcher();
    d.register('ping', () => 'ok');
    const r = await d.handle(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
    expect(r).toBeNull();
  });

  it('swallows handler errors for notifications without crashing', async () => {
    const d = new RpcDispatcher();
    d.register('boom', () => {
      throw new Error('silent');
    });
    const r = await d.handle(JSON.stringify({ jsonrpc: '2.0', method: 'boom' }));
    expect(r).toBeNull();
  });

  it('refuses duplicate method registration', () => {
    const d = new RpcDispatcher();
    d.register('ping', () => 'a');
    expect(() => d.register('ping', () => 'b')).toThrow(/already registered/);
  });

  it('list() returns sorted registered methods', () => {
    const d = new RpcDispatcher();
    d.register('z.last', () => null);
    d.register('a.first', () => null);
    expect(d.list()).toEqual(['a.first', 'z.last']);
  });
});

describe('runRpcServer', () => {
  it('reads NDJSON, writes responses, skips blank lines, ignores notifications', async () => {
    const d = new RpcDispatcher();
    d.register('echo', (params) => params);
    const { input, output, chunks } = makeStreams([
      '',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { hello: 'world' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'echo', params: 'notification' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: 42 }),
    ]);
    await runRpcServer({ dispatcher: d, input, output });
    const written = chunks
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ id: 1, result: { hello: 'world' } });
    expect(written[1]).toMatchObject({ id: 2, result: 42 });
  });

  it('exits cleanly when input ends with no requests', async () => {
    const d = new RpcDispatcher();
    const input = Readable.from('');
    const chunks: string[] = [];
    const output = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString('utf-8'));
        cb();
      },
    });
    await runRpcServer({ dispatcher: d, input, output });
    expect(chunks).toEqual([]);
  });

  describe('M8: nonce verification', () => {
    it('rejects requests OHNE nonce wenn setExpectedNonce gesetzt', async () => {
      const d = new RpcDispatcher();
      d.register('ping', () => ({ pong: true }));
      d.setExpectedNonce('expected-nonce-hex');
      const r = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
      expect(r).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32001, message: 'Invalid or missing nonce' },
      });
    });

    it('rejects requests mit FALSCHEM nonce', async () => {
      const d = new RpcDispatcher();
      d.register('ping', () => ({ pong: true }));
      d.setExpectedNonce('expected-nonce-hex');
      const r = await d.handle(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', nonce: 'wrong-nonce' }),
      );
      expect(r).toMatchObject({ error: { code: -32001 } });
    });

    it('akzeptiert requests mit korrektem nonce', async () => {
      const d = new RpcDispatcher();
      d.register('ping', () => ({ pong: true }));
      d.setExpectedNonce('expected-nonce-hex');
      const r = await d.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'ping',
          nonce: 'expected-nonce-hex',
        }),
      );
      expect(r).toMatchObject({ jsonrpc: '2.0', id: 1, result: { pong: true } });
    });

    it('back-compat: ohne setExpectedNonce werden alle requests akzeptiert', async () => {
      const d = new RpcDispatcher();
      d.register('ping', () => ({ pong: true }));
      const r = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
      expect(r).toMatchObject({ result: { pong: true } });
    });

    it('setExpectedNonce mit empty string wirft', () => {
      const d = new RpcDispatcher();
      expect(() => d.setExpectedNonce('')).toThrow(/non-empty/);
    });

    it('invoke() ignoriert nonce (in-process direct-call)', async () => {
      const d = new RpcDispatcher();
      d.register('ping', () => ({ pong: true }));
      d.setExpectedNonce('expected-nonce-hex');
      // invoke() ist der in-process-Pfad (MCP-Server, Tests) und braucht
      // keinen handshake. Wenn das hier throwt, hat M21 sidecar-test-
      // surface gebrochen.
      const result = await d.invoke('ping', {});
      expect(result).toMatchObject({ pong: true });
    });
  });
});
