/**
 * Admin user-management HTTP routes (Phase Web-7-7).
 *
 * Mirrors the CLI surface of `claude-os users` (Phase Web-7-5) over HTTP
 * so a deployed Linux/Web instance can be operated without shell-access.
 *
 *   GET    /api/admin/users                         list all (incl. disabled)
 *   POST   /api/admin/users                         create
 *   POST   /api/admin/users/:idOrEmail/disable      flip disabled=1
 *   POST   /api/admin/users/:idOrEmail/enable       flip disabled=0
 *   POST   /api/admin/users/:idOrEmail/reset-password
 *
 * Gating: env-driven allowlist (`CLAUDE_OS_ADMIN_EMAILS`, comma-separated).
 * The cookie-auth hook has already populated `req.user`; the inline
 * `requireAdmin` guard checks the email belongs to the allowlist. When the
 * allowlist is empty, the routes are *not* registered at all — accidentally
 * leaving the server unconfigured cannot expose them.
 *
 * No-schema-migration decision: rather than add an `is_admin` column to
 * `users.sqlite` (touching ADR-0036) we read admin-emails from the env at
 * boot. Trade-off: changing admin set requires a restart. Acceptable for
 * the typical small-team deployment; revisit if/when the operator base
 * grows past single-digits.
 *
 * @module @server/routes-admin
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AuditLogger } from '../core/audit/index.js';
import type { SessionRepository } from '../domains/sessions/index.js';
import { userToTenantId } from '../domains/tenant/index.js';
import {
  DuplicateEmailError,
  InvalidEmailError,
  InvalidRoleError,
  LastAdminError,
  UserError,
  UserNotFoundError,
  type UserRepository,
  type UserRole,
  WeakPasswordError,
} from '../domains/users/index.js';
import { requireRole } from './rbac.js';

export interface AdminRoutesDeps {
  readonly userRepo: UserRepository;
  readonly sessionRepo: SessionRepository;
  readonly audit?: AuditLogger;
  /**
   * Lowercased + trimmed admin email allowlist. Empty array means the
   * routes are not registered at all (see module header).
   */
  readonly adminEmails: readonly string[];
}

interface CreateUserBody {
  email?: unknown;
  password?: unknown;
  tenantIdOverride?: unknown;
}

interface ResetPasswordBody {
  password?: unknown;
}

interface SafeUser {
  readonly id: string;
  readonly email: string;
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  readonly disabled: boolean;
  readonly tenantIdOverride: string | null;
  readonly role: UserRole;
}

function safe(u: {
  id: string;
  email: string;
  createdAt: number;
  lastLoginAt: number | null;
  disabled: boolean;
  tenantIdOverride: string | null;
  role: UserRole;
}): SafeUser {
  return {
    id: u.id,
    email: u.email,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    disabled: u.disabled,
    tenantIdOverride: u.tenantIdOverride,
    role: u.role,
  };
}

function hashedEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

function userErrorToCode(err: UserError): { code: string; status: number } {
  if (err instanceof DuplicateEmailError) return { code: 'duplicate-email', status: 409 };
  if (err instanceof InvalidEmailError) return { code: 'invalid-email', status: 400 };
  if (err instanceof WeakPasswordError) return { code: 'weak-password', status: 400 };
  if (err instanceof InvalidRoleError) return { code: 'invalid-role', status: 400 };
  if (err instanceof LastAdminError) return { code: 'last-admin', status: 409 };
  if (err instanceof UserNotFoundError) return { code: 'not-found', status: 404 };
  return { code: 'user-error', status: 400 };
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  if (deps.adminEmails.length === 0) {
    return;
  }
  const allowlist = new Set(deps.adminEmails);

  // Admin gate — delegates to the shared RBAC guard (MC-A). Admin = an email in
  // the allowlist OR a stored role of 'admin'. Returns the verified email when
  // allowed (lets callers skip the non-null assertion for audit-payloads).
  const requireAdmin = (
    req: { user?: { email: string; role?: 'viewer' | 'operator' | 'admin' } },
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ): string | null => requireRole('admin', allowlist, req, reply);

  app.get('/api/admin/users', async (req, reply) => {
    if (requireAdmin(req, reply) === null) return;
    const rows = deps.userRepo.list({ includeDisabled: true });
    reply.send({ users: rows.map(safe) });
  });

  app.post('/api/admin/users', async (req, reply) => {
    const adminEmail = requireAdmin(req, reply);
    if (adminEmail === null) return;
    const body = (req.body ?? {}) as CreateUserBody;
    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const tenantIdOverride =
      typeof body.tenantIdOverride === 'string' && body.tenantIdOverride.length > 0
        ? body.tenantIdOverride
        : undefined;

    if (email.length === 0 || password.length === 0) {
      reply.code(400).send({
        error: { code: 'invalid-request', message: 'email and password required' },
      });
      return;
    }

    try {
      const created = await deps.userRepo.createUser(
        email,
        password,
        tenantIdOverride !== undefined ? { tenantIdOverride } : {},
      );
      deps.audit?.append({
        kind: 'admin.user.create',
        action: 'admin-create-user',
        workspace: 'system',
        tenant: userToTenantId(created),
        outcome: 'ok',
        details: { adminEmailHash: hashedEmail(adminEmail), createdId: created.id },
      });
      reply.code(201).send({ user: safe(created) });
    } catch (err) {
      if (err instanceof UserError) {
        const { code, status } = userErrorToCode(err);
        reply.code(status).send({ error: { code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  app.post<{ Params: { idOrEmail: string } }>(
    '/api/admin/users/:idOrEmail/disable',
    async (req, reply) => {
      const adminEmail = requireAdmin(req, reply);
      if (adminEmail === null) return;
      const target = req.params.idOrEmail;
      const flipped = deps.userRepo.disable(target);
      if (!flipped) {
        reply.code(404).send({
          error: { code: 'not-found-or-already-disabled', message: target },
        });
        return;
      }
      // Revoke active sessions so the disabled user is logged out everywhere.
      const user = deps.userRepo.findByEmail(target) ?? deps.userRepo.findById(target);
      const revoked = user !== null ? deps.sessionRepo.revokeAllForUser(user.id) : 0;
      deps.audit?.append({
        kind: 'admin.user.disable',
        action: 'admin-disable-user',
        workspace: 'system',
        outcome: 'ok',
        details: {
          adminEmailHash: hashedEmail(adminEmail),
          target,
          sessionsRevoked: revoked,
        },
      });
      reply.send({ ok: true, sessionsRevoked: revoked });
    },
  );

  app.post<{ Params: { idOrEmail: string } }>(
    '/api/admin/users/:idOrEmail/enable',
    async (req, reply) => {
      const adminEmail = requireAdmin(req, reply);
      if (adminEmail === null) return;
      const target = req.params.idOrEmail;
      const flipped = deps.userRepo.enable(target);
      if (!flipped) {
        reply.code(404).send({
          error: { code: 'not-found-or-already-enabled', message: target },
        });
        return;
      }
      deps.audit?.append({
        kind: 'admin.user.enable',
        action: 'admin-enable-user',
        workspace: 'system',
        outcome: 'ok',
        details: { adminEmailHash: hashedEmail(adminEmail), target },
      });
      reply.send({ ok: true });
    },
  );

  app.post<{ Params: { idOrEmail: string }; Body: ResetPasswordBody }>(
    '/api/admin/users/:idOrEmail/reset-password',
    async (req, reply) => {
      const adminEmail = requireAdmin(req, reply);
      if (adminEmail === null) return;
      const target = req.params.idOrEmail;
      const body = req.body ?? {};
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length === 0) {
        reply.code(400).send({
          error: {
            code: 'invalid-request',
            message: 'password required (no random generation over HTTP — pick one)',
          },
        });
        return;
      }
      try {
        await deps.userRepo.setPassword(target, password);
        // Revoke all sessions (admin reset means the old password is gone;
        // any active session that authenticated under it must re-login).
        const user = deps.userRepo.findByEmail(target) ?? deps.userRepo.findById(target);
        const revoked = user !== null ? deps.sessionRepo.revokeAllForUser(user.id) : 0;
        deps.audit?.append({
          kind: 'admin.user.reset-password',
          action: 'admin-reset-password',
          workspace: 'system',
          outcome: 'ok',
          details: {
            adminEmailHash: hashedEmail(adminEmail),
            target,
            sessionsRevoked: revoked,
          },
        });
        reply.send({ ok: true, sessionsRevoked: revoked });
      } catch (err) {
        if (err instanceof UserError) {
          const { code, status } = userErrorToCode(err);
          reply.code(status).send({ error: { code, message: err.message } });
          return;
        }
        throw err;
      }
    },
  );

  // Assign an RBAC role (MC-A). The only path that can mint an `operator`
  // (and thus the linchpin for every Write phase, MC-C+). Admin-only; the
  // before/after roles are captured in the audit-log. `setRole` enforces the
  // last-admin guard (LastAdminError → 409) and role validity (InvalidRoleError
  // → 400); a vanished target maps to 404.
  app.post<{ Params: { idOrEmail: string }; Body: { role?: unknown } }>(
    '/api/admin/users/:idOrEmail/role',
    async (req, reply) => {
      const adminEmail = requireAdmin(req, reply);
      if (adminEmail === null) return;
      const target = req.params.idOrEmail;
      const body = req.body ?? {};
      const role = typeof body.role === 'string' ? body.role : '';
      if (role.length === 0) {
        reply.code(400).send({
          error: { code: 'invalid-request', message: 'role required' },
        });
        return;
      }
      // Capture the previous role for the before/after audit trail.
      const current = target.includes('@')
        ? deps.userRepo.findByEmail(target)
        : deps.userRepo.findById(target);
      if (current === null) {
        reply.code(404).send({ error: { code: 'not-found', message: target } });
        return;
      }
      try {
        const updated = deps.userRepo.setRole(target, role as UserRole);
        deps.audit?.append({
          kind: 'admin.user.role',
          action: 'admin-set-role',
          workspace: 'system',
          outcome: 'ok',
          details: {
            adminEmailHash: hashedEmail(adminEmail),
            target,
            oldRole: current.role,
            newRole: updated.role,
          },
        });
        reply.send({ ok: true, user: safe(updated) });
      } catch (err) {
        if (err instanceof UserError) {
          const { code, status } = userErrorToCode(err);
          reply.code(status).send({ error: { code, message: err.message } });
          return;
        }
        throw err;
      }
    },
  );
}

/**
 * Parse `CLAUDE_OS_ADMIN_EMAILS` env-var ("a@b.com,c@d.com") into a
 * normalized lowercase array. Empty/undefined → empty array.
 */
export function parseAdminEmails(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}
