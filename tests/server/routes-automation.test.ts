import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFiredActionLog, type FiredActionLog } from '../../src/domains/automation/index.js';
import { registerAutomationRoutes } from '../../src/server/routes-automation.js';

const ADMIN_EMAIL = 'admin@example.com';
const USER_EMAIL = 'user@example.com';

const VALID_RULE = `id: sophos-offline-alert
trigger:
  bridge: sophos
  customers: all
condition:
  statusIn:
    - unreachable
actions:
  - type: dashboard-alert
    message: down
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'routes-automation-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(
  opts: { adminEmails?: readonly string[]; firedLog?: FiredActionLog } = {},
): FastifyInstance {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    const u = (req.query as { _u?: string })?._u;
    if (u !== undefined && u.length > 0) {
      (req as { user?: { email: string } }).user = { email: u };
    }
  });
  registerAutomationRoutes(app, {
    adminEmails: opts.adminEmails ?? [ADMIN_EMAIL],
    rulesDir: dir,
    firedLog: opts.firedLog ?? createFiredActionLog(),
  });
  return app;
}

describe('routes-automation — auth', () => {
  it('GET /api/automation/rules without user → 401', async () => {
    const app = makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/automation/rules' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/automation/rules with non-admin → 403', async () => {
    const app = makeApp();
    const r = await app.inject({ method: 'GET', url: `/api/automation/rules?_u=${USER_EMAIL}` });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  it('empty adminEmails → routes NOT registered (404)', async () => {
    const app = makeApp({ adminEmails: [] });
    const r = await app.inject({ method: 'GET', url: '/api/automation/rules' });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});

describe('routes-automation — payload', () => {
  it('GET /rules returns loaded rules + errors', async () => {
    writeFileSync(join(dir, 'sophos.yaml'), VALID_RULE);
    const app = makeApp();
    const r = await app.inject({ method: 'GET', url: `/api/automation/rules?_u=${ADMIN_EMAIL}` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { rules: { id: string }[]; errors: unknown[] };
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]?.id).toBe('sophos-offline-alert');
    expect(body.errors).toEqual([]);
    await app.close();
  });

  it('GET /firings returns recent firings newest-first', async () => {
    const firedLog = createFiredActionLog();
    firedLog.record({
      ruleId: 'r1',
      slug: 'acme',
      bridge: 'sophos',
      action: { type: 'dashboard-alert', message: 'down' },
    });
    const app = makeApp({ firedLog });
    const r = await app.inject({ method: 'GET', url: `/api/automation/firings?_u=${ADMIN_EMAIL}` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { firings: { ruleId: string; firedAt: string }[] };
    expect(body.firings).toHaveLength(1);
    expect(body.firings[0]?.ruleId).toBe('r1');
    expect(typeof body.firings[0]?.firedAt).toBe('string');
    await app.close();
  });
});
