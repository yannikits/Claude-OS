import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AggregateCache, MspHealthAggregator } from '../../src/domains/msp-aggregate/index.js';
import { BridgeRegistry } from '../../src/domains/msp-bridges/index.js';
import type {
  BridgeKind,
  BridgeProbe,
  BridgeResult,
  ReadBridge,
} from '../../src/domains/msp-bridges/types.js';
import type { CustomerRecord } from '../../src/domains/msp-customers/index.js';
import { registerMspHealthRoutes } from '../../src/server/routes-msp-health.js';

const ADMIN_EMAIL = 'admin@example.com';
const USER_EMAIL = 'user@example.com';

class StubBridge<T> implements ReadBridge<T> {
  public probeCount = 0;
  constructor(
    public readonly kind: BridgeKind,
    private readonly result: BridgeResult<T>,
  ) {}
  async probe(c: CustomerRecord): Promise<BridgeProbe<T>> {
    this.probeCount += 1;
    return {
      bridgeKind: this.kind,
      customerSlug: c.slug,
      probedAt: new Date().toISOString(),
      durationMs: 5,
      result: this.result,
    };
  }
}

function makeApp(
  aggregator: MspHealthAggregator,
  opts: { adminEmails?: readonly string[]; userEmail?: string | undefined } = {},
): FastifyInstance {
  const app = Fastify();
  // Stand-in for cookie-auth: inject req.user from query-string.
  app.addHook('preHandler', async (req) => {
    const q = req.query as { _u?: string; _role?: string };
    if (q?._u !== undefined && q._u.length > 0) {
      (req as { user?: { email: string; role?: string } }).user = {
        email: q._u,
        ...(q._role !== undefined ? { role: q._role } : {}),
      };
    }
  });
  registerMspHealthRoutes(app, {
    adminEmails: opts.adminEmails ?? [ADMIN_EMAIL],
    aggregator,
  });
  return app;
}

function makeAggregator(
  bridges: ReadBridge<unknown>[] = [],
  customers: readonly CustomerRecord[] = [],
): MspHealthAggregator {
  const registry = new BridgeRegistry();
  for (const b of bridges) registry.register(b);
  return new MspHealthAggregator({
    registry,
    listCustomers: async () => customers,
    cache: new AggregateCache({ ttlSec: 60 }),
  });
}

describe('routes-msp-health — auth', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = makeApp(makeAggregator());
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET /api/msp-health/rows without user → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/msp-health/rows' });
    expect(r.statusCode).toBe(401);
  });

  it('GET /api/msp-health/rows with a viewer (non-admin) → 200 (RBAC: read allowed)', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/msp-health/rows?_u=${USER_EMAIL}` });
    expect(r.statusCode).toBe(200);
  });

  it('POST /api/msp-health/refresh requires operator (viewer → 403, operator → 200)', async () => {
    const viewer = await app.inject({
      method: 'POST',
      url: `/api/msp-health/refresh?_u=${USER_EMAIL}`,
    });
    expect(viewer.statusCode).toBe(403);
    const operator = await app.inject({
      method: 'POST',
      url: `/api/msp-health/refresh?_u=${USER_EMAIL}&_role=operator`,
    });
    expect(operator.statusCode).toBe(200);
  });

  it('GET /api/msp-health/rows with admin user → 200', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/msp-health/rows?_u=${ADMIN_EMAIL}` });
    expect(r.statusCode).toBe(200);
  });

  it('admin email match is case-insensitive (allowlist is lowercased; req.user too)', async () => {
    const app2 = makeApp(makeAggregator(), { adminEmails: ['admin@example.com'] });
    const r = await app2.inject({
      method: 'GET',
      url: '/api/msp-health/rows?_u=ADMIN@example.com',
    });
    expect(r.statusCode).toBe(200);
    await app2.close();
  });

  it('empty adminEmails → routes NOT registered (404)', async () => {
    const app2 = Fastify();
    registerMspHealthRoutes(app2, { adminEmails: [], aggregator: makeAggregator() });
    const r = await app2.inject({ method: 'GET', url: '/api/msp-health/rows' });
    expect(r.statusCode).toBe(404);
    await app2.close();
  });
});

describe('routes-msp-health — payload shape', () => {
  let app: FastifyInstance;
  const stub = new StubBridge('tanss', { kind: 'ok', data: { openCount: 3 } });
  const customers: CustomerRecord[] = [
    { slug: 'mueller', displayName: 'Mueller GmbH', bridges: { tanss: { customerId: 1 } } },
  ];

  beforeEach(() => {
    stub.probeCount = 0;
    app = makeApp(makeAggregator([stub], customers));
  });
  afterEach(async () => {
    await app.close();
  });

  it('/rows returns AggregateSnapshot shape', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/msp-health/rows?_u=${ADMIN_EMAIL}` });
    const body = r.json() as {
      snapshotAt: string;
      registeredBridges: string[];
      rows: { slug: string; cells: { tanss?: { kind: string } } }[];
    };
    expect(body.registeredBridges).toEqual(['tanss']);
    expect(body.rows[0]?.cells.tanss?.kind).toBe('ok');
    expect(stub.probeCount).toBe(1);
  });

  it('/rows second call within TTL hits cache (no new probe)', async () => {
    await app.inject({ method: 'GET', url: `/api/msp-health/rows?_u=${ADMIN_EMAIL}` });
    await app.inject({ method: 'GET', url: `/api/msp-health/rows?_u=${ADMIN_EMAIL}` });
    expect(stub.probeCount).toBe(1);
  });

  it('POST /refresh forces a new probe', async () => {
    await app.inject({ method: 'GET', url: `/api/msp-health/rows?_u=${ADMIN_EMAIL}` });
    await app.inject({ method: 'POST', url: `/api/msp-health/refresh?_u=${ADMIN_EMAIL}` });
    expect(stub.probeCount).toBe(2);
  });

  it('POST /refresh without auth → 401', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/msp-health/refresh' });
    expect(r.statusCode).toBe(401);
  });

  it('GET /config returns peek without triggering a probe', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/msp-health/config?_u=${ADMIN_EMAIL}` });
    const body = r.json() as {
      registeredBridges: string[];
      customerCount: number | null;
      cacheAgeMs: number | null;
    };
    expect(body.registeredBridges).toEqual([]); // no snapshot yet → empty peek
    expect(body.cacheAgeMs).toBeNull();
    expect(stub.probeCount).toBe(0);
  });

  it('GET /config AFTER a /rows call reports cacheAgeMs', async () => {
    await app.inject({ method: 'GET', url: `/api/msp-health/rows?_u=${ADMIN_EMAIL}` });
    const r = await app.inject({ method: 'GET', url: `/api/msp-health/config?_u=${ADMIN_EMAIL}` });
    const body = r.json() as { cacheAgeMs: number | null; customerCount: number | null };
    expect(body.cacheAgeMs).not.toBeNull();
    expect(body.customerCount).toBe(1);
  });
});

describe('routes-msp-health — concurrent /rows requests', () => {
  it('10 concurrent /rows hit the aggregator ONCE (cache stampede protection)', async () => {
    const stub = new StubBridge('tanss', { kind: 'ok', data: {} });
    const customers: CustomerRecord[] = [
      { slug: 'a', displayName: 'A', bridges: { tanss: { customerId: 1 } } },
    ];
    const app = makeApp(makeAggregator([stub], customers));
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({ method: 'GET', url: `/api/msp-health/rows?_u=${ADMIN_EMAIL}` }),
      ),
    );
    for (const r of results) expect(r.statusCode).toBe(200);
    expect(stub.probeCount).toBe(1);
    await app.close();
  });
});
