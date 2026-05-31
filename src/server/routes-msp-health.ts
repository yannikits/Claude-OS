/**
 * MSP-Health HTTP routes (Phase 7-E, ADR-0041).
 *
 * Three admin-gated endpoints over the aggregator:
 *
 *   GET  /api/msp-health/rows     → AggregateSnapshot (cache-hit-friendly)
 *   GET  /api/msp-health/config   → { registeredBridges, customerCount, cacheAgeMs }
 *   POST /api/msp-health/refresh  → invalidates cache, runs fresh probe
 *
 * Admin-gating follows the existing routes-audit.ts pattern:
 * env-driven `CLAUDE_OS_ADMIN_EMAILS` allowlist. Empty list → routes are
 * not registered (safe-by-default).
 *
 * Why GET for /rows + /config (not POST): same cache + DSGVO-investigation
 * rationale as ADR-0037 audit — filter-state should be URL-shareable
 * and access-log-greppable. Only the explicit cache-bust uses POST.
 *
 * @module @server/routes-msp-health
 */
import type { FastifyInstance } from 'fastify';
import type { MspHealthAggregator } from '../domains/msp-aggregate/index.js';
import { requireRole } from './rbac.js';

export interface MspHealthRoutesDeps {
  /** Lowercased + trimmed admin email allowlist (admin-override). Empty → routes NOT registered. */
  readonly adminEmails: readonly string[];
  /** Aggregator singleton owned by the serve()-bootstrap. */
  readonly aggregator: MspHealthAggregator;
}

/**
 * RBAC (MC-A): reading the dashboard (`/rows`, `/config`) requires `viewer`;
 * the cache-busting `/refresh` mutation requires `operator`.
 */
export function registerMspHealthRoutes(app: FastifyInstance, deps: MspHealthRoutesDeps): void {
  if (deps.adminEmails.length === 0) return;
  const allowlist = new Set(deps.adminEmails);
  const aggregator = deps.aggregator;

  app.get('/api/msp-health/rows', async (req, reply) => {
    if (requireRole('viewer', allowlist, req, reply) === null) return;
    const snap = await aggregator.getSnapshot();
    reply.send(snap);
  });

  app.get('/api/msp-health/config', async (req, reply) => {
    if (requireRole('viewer', allowlist, req, reply) === null) return;
    const peek = aggregator.peek();
    reply.send({
      registeredBridges: peek?.registeredBridges ?? [],
      customerCount: peek?.rows.length ?? null,
      cacheAgeMs: aggregator.cachedSnapshotAgeMs(),
    });
  });

  app.post('/api/msp-health/refresh', async (req, reply) => {
    if (requireRole('operator', allowlist, req, reply) === null) return;
    const snap = await aggregator.forceRefresh();
    reply.send(snap);
  });
}
