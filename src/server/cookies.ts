/**
 * Cookie-encoding for session + CSRF (Phase Web-7-2, ADR-0036 draft).
 *
 * The session cookie is HTTP-only + SameSite=Strict + Secure by default
 * — browser hands it off automatically with every same-origin request,
 * and JavaScript cannot read it (XSS mitigation). The dev-override
 * `$CLAUDE_OS_INSECURE_COOKIES=1` drops the `Secure` flag so localhost
 * (HTTP) testing works. Production deployments MUST run behind TLS.
 *
 * The CSRF cookie is the readable counterpart for the double-submit
 * pattern: a separate token also sent in `x-csrf-token` header. Same
 * origin reads the cookie via JS at boot and echoes it on writes;
 * cross-site CSRF cannot read it (SameSite=Strict) so the header value
 * cannot match. Bearer-only clients (no cookie) skip CSRF altogether.
 *
 * @module @server/cookies
 */

export const SESSION_COOKIE_NAME = 'claude_os_session';
export const CSRF_COOKIE_NAME = 'claude_os_csrf';
/** Header where clients echo the CSRF cookie for the double-submit check. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

export interface BuildSessionCookieOpts {
  readonly value: string;
  readonly maxAgeSec: number;
  readonly secure: boolean;
  readonly sameSite?: 'Strict' | 'Lax';
  readonly path?: string;
}

/**
 * Build a `Set-Cookie` header value for the session-cookie. HTTP-only
 * (no JS read), default SameSite=Strict. `Secure` is conditional on
 * the deployment having TLS terminated upstream.
 */
export function buildSessionCookie(opts: BuildSessionCookieOpts): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${opts.value}`,
    `Path=${opts.path ?? '/'}`,
    'HttpOnly',
    `SameSite=${opts.sameSite ?? 'Strict'}`,
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export interface BuildCsrfCookieOpts {
  readonly value: string;
  readonly maxAgeSec: number;
  readonly secure: boolean;
  readonly sameSite?: 'Strict' | 'Lax';
  readonly path?: string;
}

/**
 * Build a `Set-Cookie` header value for the CSRF-cookie. NOT HttpOnly
 * — by design the client needs to read it and echo it as a header.
 */
export function buildCsrfCookie(opts: BuildCsrfCookieOpts): string {
  const parts = [
    `${CSRF_COOKIE_NAME}=${opts.value}`,
    `Path=${opts.path ?? '/'}`,
    `SameSite=${opts.sameSite ?? 'Strict'}`,
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build a Set-Cookie value that clears the named cookie. Same
 * attributes as the original — most browsers require an exact match on
 * path + samesite + secure to delete.
 */
export function buildClearCookie(name: string, secure: boolean): string {
  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
