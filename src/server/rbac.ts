/**
 * RBAC helpers (MC-A). Central role-ranking + route guard shared by all
 * admin/operator/viewer-gated routes (replaces the per-file inline
 * `requireAdmin`). The effective role is `max(DB role, allowlist-admin)`:
 * an email in `CLAUDE_OS_ADMIN_EMAILS` is always admin (anti-lockout net).
 *
 * @module @server/rbac
 */
import type { UserRole } from '../domains/users/index.js';

const RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

export interface RbacUser {
  readonly email: string;
  readonly role: UserRole;
}

/** Reply shape — just enough of Fastify's reply for the guard. */
interface GuardReply {
  code: (n: number) => { send: (body: unknown) => void };
}

/** Request shape — `req.user` is populated by the cookie-auth hook. */
interface GuardRequest {
  user?: { email: string; role?: UserRole };
}

/** An allowlisted email is always admin; otherwise the user's stored role. */
export function effectiveRole(user: RbacUser, adminEmails: ReadonlySet<string>): UserRole {
  if (adminEmails.has(user.email.toLowerCase())) return 'admin';
  return user.role;
}

export function roleAtLeast(role: UserRole, min: UserRole): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * Route guard. Returns the authed email when the (effective) role meets `min`;
 * otherwise sends 401 (no user) or 403 (insufficient role) and returns null.
 */
export function requireRole(
  min: UserRole,
  adminEmails: ReadonlySet<string>,
  req: GuardRequest,
  reply: GuardReply,
): string | null {
  if (req.user === undefined) {
    reply.code(401).send({ error: { code: 'unauthorized', message: 'cookie-auth required' } });
    return null;
  }
  const role = effectiveRole(
    { email: req.user.email, role: req.user.role ?? 'viewer' },
    adminEmails,
  );
  if (!roleAtLeast(role, min)) {
    reply
      .code(403)
      .send({ error: { code: 'forbidden', message: `role '${min}' or higher required` } });
    return null;
  }
  return req.user.email;
}
