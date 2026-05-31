/**
 * Automation HTTP routes (Phase MC-B) — read-only.
 *
 *   GET /api/automation/rules    → { rules, errors }  (live load from rulesDir)
 *   GET /api/automation/firings  → { firings }        (recent firings, newest-first)
 *
 * RBAC (MC-A): both GETs require role `viewer` or higher. `adminEmails` is the
 * admin-override allowlist; an empty allowlist still means "no admins configured"
 * → routes not registered (a configured multi-user deployment sets it).
 *
 * @module @server/routes-automation
 */
import type { FastifyInstance } from 'fastify';
import { type FiredActionLog, loadRules } from '../domains/automation/index.js';
import { requireRole } from './rbac.js';

export interface AutomationRoutesDeps {
  /** Lowercased + trimmed admin email allowlist (admin-override). Empty → routes NOT registered. */
  readonly adminEmails: readonly string[];
  /** Directory holding the `*.yaml` rule files. */
  readonly rulesDir: string;
  /** In-memory log of recent rule firings. */
  readonly firedLog: FiredActionLog;
}

export function registerAutomationRoutes(app: FastifyInstance, deps: AutomationRoutesDeps): void {
  if (deps.adminEmails.length === 0) return;
  const allowlist = new Set(deps.adminEmails);

  app.get('/api/automation/rules', async (req, reply) => {
    if (requireRole('viewer', allowlist, req, reply) === null) return;
    const { rules, errors } = loadRules(deps.rulesDir);
    reply.send({ rules, errors });
  });

  app.get('/api/automation/firings', async (req, reply) => {
    if (requireRole('viewer', allowlist, req, reply) === null) return;
    reply.send({ firings: deps.firedLog.recent() });
  });
}
