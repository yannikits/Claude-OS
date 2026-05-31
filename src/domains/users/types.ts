/**
 * Users-Domain types (Phase Web-7-1, ADR-0033 §Stage 2 / ADR-0036 draft).
 *
 * The users-domain is parallel to `domains/tenant/`: it owns email/
 * password identities and the persistent user-store. The HTTP transport
 * (`src/server/`) and the CLI (`src/cli/commands/users.ts`) consume
 * this; the layering is domain → transport, never the other way (mirrors
 * the comment in `src/server/auth.ts`).
 *
 * The repository is sql.js-backed so we keep the no-native-dep
 * property established by ADR-0025 (memory-index) and avoided by the
 * Stage-1 token-list (ADR-0033 used in-process state). Web-7-1 introduces
 * a small persistent table — atomically saved on every mutation because
 * the table is small (one row per human user).
 *
 * @module @domains/users/types
 */

/**
 * Persisted user row. `passwordHash` is the algorithm-tagged scrypt
 * encoding from `password-hash.ts` — never the plaintext password.
 *
 * `tenantIdOverride` lets a power-user share a workspace with another
 * (Web-7-3 §Klärungspunkt). When null, the default deterministic
 * `'user-' + sha256(id).slice(0,12)` is used.
 */
/**
 * RBAC role (MC-A). Ordered least → most privileged:
 *   - viewer:   read-only dashboards (MSP-health, automation)
 *   - operator: viewer + operational mutations + (future) write-approvals
 *   - admin:    operator + arm rules, user-management, audit-log
 * The effective role at request-time is `max(db-role, allowlist-admin)` —
 * an email in `CLAUDE_OS_ADMIN_EMAILS` is always admin (anti-lockout override).
 */
export type UserRole = 'viewer' | 'operator' | 'admin';

export const USER_ROLES: readonly UserRole[] = ['viewer', 'operator', 'admin'];

export function isUserRole(value: unknown): value is UserRole {
  return value === 'viewer' || value === 'operator' || value === 'admin';
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  readonly disabled: boolean;
  readonly tenantIdOverride: string | null;
  /** RBAC role (MC-A). Defaults to 'viewer' for new + migrated users. */
  readonly role: UserRole;
}

/**
 * Schema-version stamped in the `meta` table. Bump on schema-shape changes.
 * v2 (MC-A): added `users.role` — migrated additively (ALTER TABLE), NOT a
 * drop-rebuild, so existing accounts survive.
 */
export const USERS_SCHEMA_VERSION = 2;

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export class UserNotFoundError extends UserError {
  constructor(identifier: string) {
    super(`User not found: "${identifier}"`);
    this.name = 'UserNotFoundError';
  }
}

export class DuplicateEmailError extends UserError {
  constructor(email: string) {
    super(`Email already registered: "${email}"`);
    this.name = 'DuplicateEmailError';
  }
}

export class InvalidEmailError extends UserError {
  constructor(value: string) {
    super(`Invalid email format: "${value}"`);
    this.name = 'InvalidEmailError';
  }
}

export class InvalidRoleError extends UserError {
  constructor(value: string) {
    super(`Invalid role: "${value}" (expected one of ${USER_ROLES.join(', ')})`);
    this.name = 'InvalidRoleError';
  }
}

/**
 * Refused a role change that would remove the last admin-role user (would
 * risk lockout). The `CLAUDE_OS_ADMIN_EMAILS` allowlist is the primary
 * anti-lockout net; this guard prevents the obvious DB-only footgun.
 */
export class LastAdminError extends UserError {
  constructor() {
    super('Refusing to demote the last admin user (would risk lockout)');
    this.name = 'LastAdminError';
  }
}

/**
 * Password did not meet `MIN_PASSWORD_LEN` or other strength rules.
 * Thrown by `hashPassword` (so it surfaces at user-creation /
 * password-rotation) — never by `verifyPassword`, which returns `false`
 * for any input that fails to match (preserves the user-enumeration
 * defense).
 */
export class WeakPasswordError extends UserError {
  constructor(reason: string) {
    super(`Password rejected: ${reason}`);
    this.name = 'WeakPasswordError';
  }
}

/**
 * Encoded password-hash string was not in the expected
 * `scrypt$N=...$r=...$p=...$<salt-b64>$<hash-b64>` format. Indicates
 * either corruption on disk or a programmer error feeding the wrong
 * string into `verifyPassword`.
 */
export class MalformedHashError extends UserError {
  constructor(reason: string) {
    super(`Malformed password hash: ${reason}`);
    this.name = 'MalformedHashError';
  }
}
