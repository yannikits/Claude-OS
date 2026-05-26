import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAuthHook } from '../../src/server/auth.js';
import { registerRpcRoutes } from '../../src/server/rpc-http.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

const TOKEN = 'test-token-' + 'a'.repeat(20);

function buildApp(): {
  app: ReturnType<typeof Fastify>;
  dispatcher: RpcDispatcher;
} {
  const app = Fastify({ logger: false });
  const dispatcher = new RpcDispatcher();
  dispatcher.register('ping', () => ({ pong: true }));
  dispatcher.register('echo', (params: unknown) => ({ echoed: params }));
  dispatcher.register('boom', () => {
    throw new Error('handler-failed');
  });
  dispatcher.register('badparams', () => {
    const e = new Error('value must be a string');
    e.name = 'ValidationError';
    throw e;
  });

  const authHook = makeAuthHook(TOKEN);
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    await authHook(req, reply);
  });

  registerRpcRoutes(app, dispatcher);
  return { app, dispatcher };
}

describe('rpc-http routes', () => {
  let appHandle: ReturnType<typeof buildApp>;

  beforeEach(() => {
    appHandle = buildApp();
  });
  afterEach(async () => {
    await appHandle.app.close();
  });

  it('401 on missing Authorization header', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/rpc',
      payload: { method: 'ping' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on wrong bearer token', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { method: 'ping' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('200 dispatches ping with correct token', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { method: 'ping' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { pong: true } });
  });

  it('echoes params through to the handler', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { method: 'echo', params: { x: 42 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { echoed: { x: 42 } } });
  });

  it('400 when method field is missing', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid-request');
  });

  it('404 with method-not-found for unknown method', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { method: 'no.such.method' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('method-not-found');
  });

  it('400 invalid-params when handler throws ValidationError', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { method: 'badparams' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('invalid-params');
  });

  it('500 internal-error when handler throws generic error', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { method: 'boom' },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.error.code).toBe('internal-error');
    expect(body.error.message).toBe('handler-failed');
  });

  it('verify endpoint returns ok with valid token', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('verify endpoint rejects without token', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
    });
    expect(res.statusCode).toBe(401);
  });

  it('SSE-path /api/events accepts query-string token (browser EventSource workaround)', async () => {
    const res = await appHandle.app.inject({
      method: 'GET',
      url: `/api/events?token=${encodeURIComponent(TOKEN)}`,
      // No Authorization header — must accept ?token= for this path.
      payloadAsStream: true,
    });
    // The route is not registered in buildApp() but the auth hook fires
    // first; we expect a 404 (route missing) NOT a 401 — proves the
    // query-token resolution worked. If auth had rejected, we'd see 401.
    expect(res.statusCode).toBe(404);
  });

  it('non-SSE routes refuse query-string token (header-only)', async () => {
    const res = await appHandle.app.inject({
      method: 'POST',
      url: `/api/rpc?token=${encodeURIComponent(TOKEN)}`,
      payload: { method: 'ping' },
    });
    expect(res.statusCode).toBe(401);
  });
});
