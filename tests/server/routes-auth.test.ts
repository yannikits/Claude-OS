import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRepository } from '../../src/domains/sessions/index.js';
import { UserRepository } from '../../src/domains/users/index.js';
import { makeCookieAuthHook } from '../../src/server/cookie-auth.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../src/server/cookies.js';
import { LoginRateLimiter } from '../../src/server/rate-limit.js';
import { registerAuthRoutes } from '../../src/server/routes-auth.js';

const FALLBACK_TOKEN = 'fallback-bearer-token-for-test-cli';
const STRONG = 'correct-horse-battery-staple';

interface HarnessOpts {
  readonly allowRegistration?: boolean;
}

interface Harness {
  app: FastifyInstance;
  userRepo: UserRepository;
  sessionRepo: SessionRepository;
  rateLimiter: LoginRateLimiter;
  registrationRateLimiter: LoginRateLimiter;
  dataDir: string;
}

async function buildHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'routes-auth-'));
  const userRepo = await UserRepository.open({ dataDir });
  const sessionRepo = new SessionRepository();
  const rateLimiter = new LoginRateLimiter({ capacity: 5 });
  const registrationRateLimiter = new LoginRateLimiter({ capacity: 3 });

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const hook = makeCookieAuthHook({
    expectedTokens: [FALLBACK_TOKEN],
    sessionRepo,
    userRepo,
  });
  app.addHook('preHandler', hook);

  registerAuthRoutes(app, {
    userRepo,
    sessionRepo,
    rateLimiter,
    insecureCookies: true,
    sessionMaxAgeSec: 60 * 60,
    ...(opts.allowRegistration === true
      ? { allowRegistration: true, registrationRateLimiter }
      : {}),
  });

  // Test endpoint behind auth — used to exercise CSRF + bearer paths.
  app.post('/api/test/echo', async (req, reply) => {
    reply.send({ ok: true, user: req.user?.id ?? null, tenant: req.tenant ?? null });
  });
  app.get('/api/test/get', async (req, reply) => {
    reply.send({ ok: true, user: req.user?.id ?? null });
  });

  return { app, userRepo, sessionRepo, rateLimiter, registrationRateLimiter, dataDir };
}

function extractCookieValue(
  setCookieHeader: string | string[] | undefined,
  name: string,
): string | null {
  if (setCookieHeader === undefined) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const m = h.match(new RegExp(`^${name}=([^;]*)`));
    if (m !== null) return m[1] ?? null;
  }
  return null;
}

let h: Harness;

beforeEach(async () => {
  h = await buildHarness();
});

afterEach(async () => {
  await h.app.close();
  h.userRepo.close();
  rmSync(h.dataDir, { recursive: true, force: true });
});

describe('POST /api/auth/login', () => {
  it('400 when email or password missing', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401 on unknown email', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: STRONG },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on wrong password (and debits rate-limit)', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const before = h.rateLimiter.remaining('127.0.0.1');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(h.rateLimiter.remaining('127.0.0.1')).toBe(before - 1);
  });

  it('200 + Set-Cookie on correct password', async () => {
    const user = await h.userRepo.createUser('alice@example.com', STRONG);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { id: string; email: string }; csrfToken: string };
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe('alice@example.com');
    expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/);

    const sessionVal = extractCookieValue(res.headers['set-cookie'], SESSION_COOKIE_NAME);
    expect(sessionVal).toMatch(/^[A-Za-z0-9_-]{40,48}$/);
    const csrfVal = extractCookieValue(res.headers['set-cookie'], CSRF_COOKIE_NAME);
    expect(csrfVal).toBe(body.csrfToken);
  });

  it('401 on disabled user', async () => {
    const user = await h.userRepo.createUser('alice@example.com', STRONG);
    h.userRepo.disable(user.id);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    expect(res.statusCode).toBe(401);
  });

  it('429 after rate-limit capacity is exhausted', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    for (let i = 0; i < 5; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'alice@example.com', password: 'wrong' },
      });
    }
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('successful login wipes prior failure history', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    for (let i = 0; i < 3; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'alice@example.com', password: 'wrong' },
      });
    }
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    expect(ok.statusCode).toBe(200);
    expect(h.rateLimiter.remaining('127.0.0.1')).toBe(5);
  });
});

describe('login is exempt from global auth hook', () => {
  it('does not require any cookie or bearer to call /api/auth/login', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('cookie-first authenticated requests', () => {
  it('GET /api/auth/me returns the current user when authenticated via cookie', async () => {
    const user = await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);

    const me = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { id: string } }).user.id).toBe(user.id);
  });

  it('rejects unsafe POST without CSRF header → 403', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);
    const csrf = extractCookieValue(login.headers['set-cookie'], CSRF_COOKIE_NAME);

    const denied = await h.app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}` },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
  });

  it('accepts unsafe POST with matching CSRF header', async () => {
    const user = await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);
    const csrf = extractCookieValue(login.headers['set-cookie'], CSRF_COOKIE_NAME);

    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
        'x-csrf-token': csrf ?? '',
      },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { user: string }).user).toBe(user.id);
  });

  it('GET requests do not require CSRF', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/test/get',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('bearer-token fallback', () => {
  it('GET /api/auth/me returns user:null when bearer-authenticated (no user-of-record)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${FALLBACK_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null, allowRegistration: false });
  });

  it('bearer-only POST skips CSRF entirely', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { authorization: `Bearer ${FALLBACK_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: string | null; tenant: string };
    expect(body.user).toBeNull();
    expect(body.tenant).toBeDefined();
  });

  it('401 when neither cookie nor bearer present', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/test/get',
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on invalid bearer token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/test/get',
      headers: { authorization: 'Bearer not-the-right-token-at-all-padding' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes session, clears cookies, returns ok', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);
    const csrf = extractCookieValue(login.headers['set-cookie'], CSRF_COOKIE_NAME);
    expect(h.sessionRepo.size()).toBe(1);

    const out = await h.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
        'x-csrf-token': csrf ?? '',
      },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    expect(h.sessionRepo.size()).toBe(0);

    const setCookies = out.headers['set-cookie'];
    expect(JSON.stringify(setCookies)).toContain('Max-Age=0');
  });
});

describe('POST /api/auth/refresh', () => {
  it('401 without cookie', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('200 + renewed Set-Cookie when called with valid session', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);

    const ref = await h.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
      payload: {},
    });
    expect(ref.statusCode).toBe(200);
    const body = ref.json() as { expiresAt: number };
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    const renewed = extractCookieValue(ref.headers['set-cookie'], SESSION_COOKIE_NAME);
    expect(renewed).toBe(sessionId);
  });
});

describe('POST /api/auth/register', () => {
  it('returns 404 by default (allowRegistration off)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    expect(res.statusCode).toBe(404);
  });

  describe('when allowRegistration is enabled', () => {
    let reg: Harness;

    beforeEach(async () => {
      reg = await buildHarness({ allowRegistration: true });
    });

    afterEach(async () => {
      await reg.app.close();
      reg.userRepo.close();
      rmSync(reg.dataDir, { recursive: true, force: true });
    });

    it('201 on a valid new registration', async () => {
      const res = await reg.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'alice@example.com', password: STRONG },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { user: { email: string } };
      expect(body.user.email).toBe('alice@example.com');
    });

    it('400 duplicate-email when the address is already registered', async () => {
      await reg.userRepo.createUser('alice@example.com', STRONG);
      const res = await reg.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'alice@example.com', password: STRONG },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('duplicate-email');
    });

    it('400 invalid-email when email format malformed', async () => {
      const res = await reg.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'not-an-email', password: STRONG },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('invalid-email');
    });

    it('400 weak-password when password is too short', async () => {
      const res = await reg.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'alice@example.com', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('weak-password');
    });

    it('429 after rate-limit capacity exhausted', async () => {
      // capacity=3 → fourth attempt blocked
      for (let i = 0; i < 3; i++) {
        await reg.app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { email: `bob${i}@example.com`, password: STRONG },
        });
      }
      const res = await reg.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'bob3@example.com', password: STRONG },
      });
      expect(res.statusCode).toBe(429);
    });
  });
});

describe('POST /api/auth/change-password', () => {
  const NEW_PW = 'new-extremely-secure-passphrase';

  it('401 when called without an active session-cookie', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { oldPassword: STRONG, newPassword: NEW_PW },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 when fields missing', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);
    const csrf = extractCookieValue(login.headers['set-cookie'], CSRF_COOKIE_NAME);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
        'x-csrf-token': csrf ?? '',
      },
      payload: { oldPassword: STRONG },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401 on wrong old password', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);
    const csrf = extractCookieValue(login.headers['set-cookie'], CSRF_COOKIE_NAME);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
        'x-csrf-token': csrf ?? '',
      },
      payload: { oldPassword: 'wrong-password', newPassword: NEW_PW },
    });
    expect(res.statusCode).toBe(401);
  });

  it('200 on success — old no longer verifies, new does', async () => {
    const user = await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);
    const csrf = extractCookieValue(login.headers['set-cookie'], CSRF_COOKIE_NAME);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
        'x-csrf-token': csrf ?? '',
      },
      payload: { oldPassword: STRONG, newPassword: NEW_PW },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(await h.userRepo.verifyPassword('alice@example.com', STRONG)).toBeNull();
    expect((await h.userRepo.verifyPassword('alice@example.com', NEW_PW))?.id).toBe(user.id);
  });

  it('400 weak-password when new password too short', async () => {
    await h.userRepo.createUser('alice@example.com', STRONG);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);
    const csrf = extractCookieValue(login.headers['set-cookie'], CSRF_COOKIE_NAME);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
        'x-csrf-token': csrf ?? '',
      },
      payload: { oldPassword: STRONG, newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('weak-password');
  });

  it('revokes all other sessions of the same user after successful change', async () => {
    const user = await h.userRepo.createUser('alice@example.com', STRONG);
    // Mint a "second" session — simulates the user logged in elsewhere.
    const otherSession = h.sessionRepo.issue({ userId: user.id });

    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: STRONG },
    });
    const sessionId = extractCookieValue(login.headers['set-cookie'], SESSION_COOKIE_NAME);
    const csrf = extractCookieValue(login.headers['set-cookie'], CSRF_COOKIE_NAME);

    expect(h.sessionRepo.listForUser(user.id).length).toBe(2);

    await h.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
        'x-csrf-token': csrf ?? '',
      },
      payload: { oldPassword: STRONG, newPassword: NEW_PW },
    });

    const remaining = h.sessionRepo.listForUser(user.id);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.id).toBe(sessionId);
    expect(h.sessionRepo.peek(otherSession.id)).toBeNull();
  });
});

describe('GET /api/auth/me allowRegistration flag', () => {
  it('returns allowRegistration:false by default', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${FALLBACK_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null, allowRegistration: false });
  });

  it('returns allowRegistration:true when feature is enabled', async () => {
    const reg = await buildHarness({ allowRegistration: true });
    try {
      const res = await reg.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${FALLBACK_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ user: null, allowRegistration: true });
    } finally {
      await reg.app.close();
      reg.userRepo.close();
      rmSync(reg.dataDir, { recursive: true, force: true });
    }
  });
});
