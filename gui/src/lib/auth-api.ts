/**
 * Email/Password auth API helpers (Phase Web-7-4 frontend).
 *
 * Cookie-mode endpoints. Browsers automatically attach `claude_os_session`
 * + `claude_os_csrf` cookies via `credentials: 'same-origin'`. CSRF header
 * is read from `claude_os_csrf` (not HTTP-only) and echoed back per ADR-
 * 0036 §CSRF double-submit.
 *
 * The Bearer-Token-Pfad (Stage 1) bleibt parallel verfügbar via
 * `lib/rpc-http.ts` `AuthCapableTransport`.
 *
 * @module @lib/auth-api
 */

export const CSRF_COOKIE_NAME = 'claude_os_csrf';
export const COOKIE_AUTH_FLAG_KEY = 'claude-os-cookie-auth';

/**
 * RBAC role (MC-A). Mirrors `UserRole` in `src/domains/users/types.ts`.
 * Ranked viewer < operator < admin. Drives nav-entry visibility — e.g.
 * "Claude Code" requires operator+ (MC-C).
 */
export type UserRole = 'viewer' | 'operator' | 'admin';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly tenantId: string;
  /** True wenn die Email in `CLAUDE_OS_ADMIN_EMAILS` allowlist ist (Web-7-7).
   *  Steuert Sichtbarkeit von Admin-only Nav-Entries (Audit-Trail, etc.). */
  readonly isAdmin?: boolean;
  /** Effektive RBAC-Rolle vom Server (`/api/auth/me`, MC-A). Default 'viewer'. */
  readonly role?: UserRole;
}

export interface MeResponse {
  readonly user: AuthUser | null;
  readonly allowRegistration: boolean;
}

export interface LoginSuccess {
  readonly user: AuthUser;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

/** Read a cookie value by name. `null` when not present or in non-DOM env. */
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const cookies = document.cookie.split(';');
  for (const raw of cookies) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    if (key === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function csrfHeader(): Record<string, string> {
  const csrf = readCookie(CSRF_COOKIE_NAME);
  return csrf !== null ? { 'x-csrf-token': csrf } : {};
}

function markCookieAuthed(value: boolean): void {
  if (typeof sessionStorage === 'undefined') return;
  if (value) sessionStorage.setItem(COOKIE_AUTH_FLAG_KEY, '1');
  else sessionStorage.removeItem(COOKIE_AUTH_FLAG_KEY);
}

/** Did a previous loginWithCredentials in this tab leave us cookie-authed? */
export function isCookieAuthed(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  return sessionStorage.getItem(COOKIE_AUTH_FLAG_KEY) === '1';
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AuthApiError(res.status, 'non-json', `non-JSON response (status ${res.status})`);
  }
  if (res.ok) return body as T;
  const err = (body as { error?: { code?: string; message?: string } }).error ?? {};
  throw new AuthApiError(res.status, err.code ?? 'unknown', err.message ?? `HTTP ${res.status}`);
}

/** POST /api/auth/login — email + password. On success, browser receives Set-Cookie. */
export async function loginWithCredentials(email: string, password: string): Promise<LoginSuccess> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email, password }),
  });
  const ok = await parseEnvelope<LoginSuccess>(res);
  markCookieAuthed(true);
  return ok;
}

/** POST /api/auth/register — conditional on server config. */
export async function register(email: string, password: string): Promise<{ user: AuthUser }> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email, password }),
  });
  return parseEnvelope<{ user: AuthUser }>(res);
}

/**
 * POST /api/auth/logout — revokes session, clears cookies.
 * Best-effort: a network failure is swallowed so the UI can always
 * progress to the unauthenticated state. The server-side session may
 * linger but expires via TTL.
 */
export async function logoutCookie(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      credentials: 'same-origin',
      body: '{}',
    });
  } catch {
    // network down / origin unreachable — fall through to the
    // local-cleanup step so the user isn't trapped in the UI.
  } finally {
    markCookieAuthed(false);
  }
}

/** GET /api/auth/me — public-ish (returns `user: null` for bearer-only or unauth). */
export async function authMe(): Promise<MeResponse> {
  const res = await fetch('/api/auth/me', {
    method: 'GET',
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    // Caller can interpret as "unauthenticated".
    markCookieAuthed(false);
    return { user: null, allowRegistration: false };
  }
  return parseEnvelope<MeResponse>(res);
}

/** POST /api/auth/change-password — cookie-auth required. */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeader() },
    credentials: 'same-origin',
    body: JSON.stringify({ oldPassword, newPassword }),
  });
  await parseEnvelope<{ ok: true }>(res);
}
