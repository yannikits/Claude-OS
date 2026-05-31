/**
 * Admin HTTP API tests (Phase Web-7-7).
 *
 * Exercises the gating logic (admin-allowlist), the four route handlers,
 * and the session-revoke side-effect on disable/reset-password.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type AuditEntry, AuditLogger } from '../../src/core/audit/index.js';
import { SessionRepository } from '../../src/domains/sessions/index.js';
import { UserRepository } from '../../src/domains/users/index.js';
import { makeCookieAuthHook } from '../../src/server/cookie-auth.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../src/server/cookies.js';
import { LoginRateLimiter } from '../../src/server/rate-limit.js';
import { parseAdminEmails, registerAdminRoutes } from '../../src/server/routes-admin.js';
import { registerAuthRoutes } from '../../src/server/routes-auth.js';

const STRONG = 'correct-horse-battery-staple-12+';
const ADMIN_EMAIL = 'admin@example.com';
const REGULAR_EMAIL = 'regular@example.com';
const FALLBACK_TOKEN = 'fallback-bearer-token-for-admin-test';

interface Harness {
  app: FastifyInstance;
  userRepo: UserRepository;
  sessionRepo: SessionRepository;
  dataDir: string;
}

async function buildHarness(
  adminEmails: readonly string[] = [ADMIN_EMAIL],
  audit?: AuditLogger,
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'routes-admin-'));
  const userRepo = await UserRepository.open({ dataDir });
  await userRepo.createUser(ADMIN_EMAIL, STRONG);
  await userRepo.createUser(REGULAR_EMAIL, STRONG);
  const sessionRepo = new SessionRepository();
  const rateLimiter = new LoginRateLimiter({ capacity: 50 });

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  app.addHook(
    'preHandler',
    makeCookieAuthHook({ expectedTokens: [FALLBACK_TOKEN], sessionRepo, userRepo }),
  );
  registerAuthRoutes(app, {
    userRepo,
    sessionRepo,
    rateLimiter,
    insecureCookies: true,
    sessionMaxAgeSec: 60 * 60,
  });
  registerAdminRoutes(app, { userRepo, sessionRepo, adminEmails, ...(audit ? { audit } : {}) });

  return { app, userRepo, sessionRepo, dataDir };
}

/** Build an AuditLogger that captures entries in-memory (no FS). */
function capturingAudit(): { logger: AuditLogger; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  const logger = new AuditLogger({ sink: () => {}, auditDir: '/tmp/unused' });
  const original = logger.append.bind(logger);
  logger.append = (input) => {
    const entry = original(input);
    entries.push(entry);
    return entry;
  };
  return { logger, entries };
}

function extractCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (setCookie === undefined) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const h of arr) {
    const m = h.match(new RegExp(`^${name}=([^;]*)`));
    if (m !== null) return m[1] ?? null;
  }
  return null;
}

async function loginAs(
  app: FastifyInstance,
  email: string,
): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: STRONG },
  });
  const setCookies = res.headers['set-cookie'];
  const sessionId = extractCookie(setCookies, SESSION_COOKIE_NAME);
  const csrf = extractCookie(setCookies, CSRF_COOKIE_NAME);
  if (sessionId === null || csrf === null) {
    throw new Error(`login as ${email} failed: ${res.body}`);
  }
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

let h: Harness;

afterEach(async () => {
  if (h !== undefined) {
    await h.app.close();
    h.userRepo.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  }
});

describe('parseAdminEmails', () => {
  it('returns empty array for undefined/empty', () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails('')).toEqual([]);
    expect(parseAdminEmails('   ')).toEqual([]);
  });
  it('lowercases + trims + drops blanks', () => {
    expect(parseAdminEmails('Alice@Example.COM ,, bob@Example.com,  ')).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
  });
});

describe('registerAdminRoutes — gating', () => {
  it('does not register routes when allowlist is empty', async () => {
    h = await buildHarness([]);
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(res.statusCode).toBe(401); // global auth hook rejects (route not registered → falls to 404 path which hits 401 first)
  });

  it('returns 401 when no auth cookie present', async () => {
    h = await buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when authed user is not in admin allowlist', async () => {
    h = await buildHarness();
    const { cookie } = await loginAs(h.app, REGULAR_EMAIL);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('forbidden');
  });
});

describe('GET /api/admin/users', () => {
  it('returns full list (including disabled) for admin', async () => {
    h = await buildHarness();
    const { cookie } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { users: { email: string; passwordHash?: string }[] };
    expect(body.users).toHaveLength(2);
    expect(body.users.map((u) => u.email).sort()).toEqual([ADMIN_EMAIL, REGULAR_EMAIL].sort());
    // safe() must NOT leak passwordHash
    for (const u of body.users) {
      expect(u.passwordHash).toBeUndefined();
    }
  });
});

describe('POST /api/admin/users', () => {
  it('creates a new user (201) and returns safe shape', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: 'new@example.com', password: STRONG },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.user.email).toBe('new@example.com');
    expect(body.user.passwordHash).toBeUndefined();
    expect(h.userRepo.findByEmail('new@example.com')).not.toBeNull();
  });

  it('returns 400 on missing fields', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: 'x@y.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('invalid-request');
  });

  it('returns 409 on duplicate email', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: REGULAR_EMAIL, password: STRONG },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('duplicate-email');
  });

  it('returns 400 on weak password', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { email: 'weak@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('weak-password');
  });

  it('returns 403 when CSRF header is missing', async () => {
    h = await buildHarness();
    const { cookie } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: { email: 'csrftest@example.com', password: STRONG },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('csrf-failed');
  });
});

describe('POST /api/admin/users/:idOrEmail/disable + enable', () => {
  it('disables a user and revokes their sessions', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    // Regular user logs in → 1 session exists
    await loginAs(h.app, REGULAR_EMAIL);
    const userBefore = h.userRepo.findByEmail(REGULAR_EMAIL);
    if (userBefore === null) throw new Error('regular user vanished');
    expect(h.sessionRepo.listForUser(userBefore.id).length).toBeGreaterThan(0);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/disable`,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.sessionsRevoked).toBeGreaterThan(0);
    expect(h.userRepo.findByEmail(REGULAR_EMAIL)?.disabled).toBe(true);
    expect(h.sessionRepo.listForUser(userBefore.id)).toEqual([]);
  });

  it('returns 404 when target does not exist', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/users/nonexistent@example.com/disable',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(404);
  });

  it('re-enables a disabled user', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    h.userRepo.disable(REGULAR_EMAIL);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/enable`,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(200);
    expect(h.userRepo.findByEmail(REGULAR_EMAIL)?.disabled).toBe(false);
  });
});

describe('POST /api/admin/users/:idOrEmail/reset-password', () => {
  it('resets the password + revokes all sessions of the target user', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    await loginAs(h.app, REGULAR_EMAIL);

    const newPassword = 'brand-new-strong-password-9+';
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/reset-password`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { password: newPassword },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const target = h.userRepo.findByEmail(REGULAR_EMAIL);
    if (target === null) throw new Error('target vanished');
    expect(h.sessionRepo.listForUser(target.id)).toEqual([]);

    // Old password no longer works, new one does.
    expect(await h.userRepo.verifyPassword(REGULAR_EMAIL, STRONG)).toBeNull();
    const verified = await h.userRepo.verifyPassword(REGULAR_EMAIL, newPassword);
    expect(verified?.id).toBe(target.id);
  });

  it('returns 400 when password is missing', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/reset-password`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/admin/users — role field', () => {
  it('exposes the RBAC role (default viewer) in the safe shape', async () => {
    h = await buildHarness();
    const { cookie } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { users: { email: string; role: string }[] };
    for (const u of body.users) expect(u.role).toBe('viewer');
  });
});

describe('POST /api/admin/users/:idOrEmail/role', () => {
  it('assigns operator (200), returns new role, and audits before/after', async () => {
    const { logger, entries } = capturingAudit();
    h = await buildHarness([ADMIN_EMAIL], logger);
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/role`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.user.role).toBe('operator');
    expect(h.userRepo.findByEmail(REGULAR_EMAIL)?.role).toBe('operator');

    const roleEvents = entries.filter((e) => e.kind === 'admin.user.role');
    expect(roleEvents).toHaveLength(1);
    expect(roleEvents[0]?.details).toMatchObject({
      target: REGULAR_EMAIL,
      oldRole: 'viewer',
      newRole: 'operator',
    });
  });

  it('returns 403 when caller is not admin', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, REGULAR_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/role`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('forbidden');
  });

  it('returns 400 on an invalid role', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/role`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { role: 'superuser' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('invalid-role');
  });

  it('returns 400 when role is missing', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/role`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('invalid-request');
  });

  it('returns 404 when the target does not exist', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/users/nonexistent@example.com/role',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to demote the last db-admin (409 last-admin)', async () => {
    h = await buildHarness();
    const { cookie, csrf } = await loginAs(h.app, ADMIN_EMAIL);
    // Make REGULAR the only stored-admin, then try to demote it via the route.
    h.userRepo.setRole(REGULAR_EMAIL, 'admin');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/admin/users/${REGULAR_EMAIL}/role`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('last-admin');
  });
});
