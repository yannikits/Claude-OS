/**
 * Automation HTTP routes (Phase MC-B) — read-only.
 *
 *   GET /api/automation/rules    → { rules, errors }  (live load from rulesDir)
 *   GET /api/automation/firings  → { firings }        (recent firings, newest-first)
 *
 * Admin-gated via the same `CLAUDE_OS_ADMIN_EMAILS` allowlist pattern as
 * routes-msp-health / routes-audit. Empty allowlist → routes not registered.
 *
 * @module @server/routes-automation
 */
import type { FastifyInstance } from 'fastify';
import { type FiredActionLog, loadRules } from '../domains/automation/index.js';

export interface AutomationRoutesDeps {
  /** Lowercased + trimmed admin email allowlist. Empty → routes NOT registered. */
  readonly adminEmails: readonly string[];
  /** Directory holding the `*.yaml` rule files. */
  readonly rulesDir: string;
  /** In-memory log of recent rule firings. */
  readonly firedLog: FiredActionLog;
}

export function registerAutomationRoutes(app: FastifyInstance, deps: AutomationRoutesDeps): void {
  if (deps.adminEmails.length === 0) return;
  const allowlist = new Set(deps.adminEmails);

  const requireAdmin = (
    req: { user?: { email: string } },
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ): string | null => {
    if (req.user === undefined) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'cookie-auth required' } });
      return null;
    }
    const email = req.user.email.toLowerCase();
    if (!allowlist.has(email)) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'admin role required' } });
      return null;
    }
    return req.user.email;
  };

  app.get('/api/automation/rules', async (req, reply) => {
    if (requireAdmin(req, reply) === null) return;
    const { rules, errors } = loadRules(deps.rulesDir);
    reply.send({ rules, errors });
  });

  app.get('/api/automation/firings', async (req, reply) => {
    if (requireAdmin(req, reply) === null) return;
    reply.send({ firings: deps.firedLog.recent() });
  });
}
