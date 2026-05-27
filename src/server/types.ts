/**
 * Server-Transport-Adapter — typed config for the headless HTTP variant of claude-os.
 *
 * Implements ADR-0032 (Server-Deployment: Headless HTTP). The HTTP-Adapter
 * wraps the existing sidecar `RpcDispatcher` and exposes the same domain
 * methods over Fastify routes. See `tasks/phase-server-web.md` Phase Web-1.
 *
 * @module @server/types
 */
import type { AuditLogger } from '../core/audit/index.js';
import type { SessionRepository } from '../domains/sessions/index.js';
import type { UserRepository } from '../domains/users/index.js';
import type { LoginRateLimiter } from './rate-limit.js';

/**
 * Phase Web-7-2 multi-user-stage-2 config (per ADR-0036 draft). When
 * present, the server activates email/password login routes and the
 * cookie-first auth hook on top of the existing Stage-1 bearer-token
 * surface. When `undefined`, the server behaves exactly as before
 * (Stage 1 token-only — ADR-0033).
 */
export interface MultiUserConfig {
  readonly userRepo: UserRepository;
  readonly sessionRepo: SessionRepository;
  readonly rateLimiter: LoginRateLimiter;
  readonly audit?: AuditLogger;
  /** When true, drops the `Secure` flag on cookies (dev/localhost only). */
  readonly insecureCookies: boolean;
  /** Session-cookie `Max-Age=` in seconds. Default 30 days. */
  readonly sessionMaxAgeSec: number;
  /**
   * When true, exposes `POST /api/auth/register`. Off by default —
   * production deployments use the Admin-CLI (Web-7-5) for provisioning
   * and run behind Cloudflare Access / VPN.
   */
  readonly allowRegistration?: boolean;
  /**
   * Separate rate-limit bucket for registrations. Required when
   * `allowRegistration` is true. Default in `index.ts` is 3 attempts /
   * IP / hour.
   */
  readonly registrationRateLimiter?: LoginRateLimiter;
}

export interface ServerConfig {
  /** Bind host. `0.0.0.0` for container, `127.0.0.1` for local-only. */
  readonly host: string;
  /** TCP port. Default 3000. */
  readonly port: number;
  /**
   * Bearer-Token required on every `/api/*` request. Token validation is
   * constant-time via `crypto.timingSafeEqual`. **Server refuses to boot
   * when this is empty** — that prevents accidentally exposing an
   * unauthenticated service to the internet.
   */
  readonly authToken: string;
  /**
   * Absolute path to the Vite-built frontend (`gui/dist/`). When set the
   * server serves the SPA at `/` with index.html fallback. When `null` the
   * server is API-only (useful for tests or external static-host setups).
   */
  readonly staticDir: string | null;
  /**
   * Allowed origin for CORS. Default `null` = same-origin only (no CORS
   * header sent). Set when frontend is hosted elsewhere.
   */
  readonly corsOrigin: string | null;
  /**
   * Heartbeat-interval for SSE event-stream in ms. Default 30_000.
   * Cloudflare-proxied connections idle-timeout at 100s — keep below that.
   */
  readonly sseHeartbeatMs: number;
  /**
   * Trust proxy hop count. 1 for nginx-proxy-manager in front. 2 if also
   * behind Cloudflare. Fastify uses this for correct `req.ip` resolution.
   */
  readonly trustProxy: number | boolean;
  /**
   * Optional multi-user (Stage 2 per ADR-0033) configuration. When set,
   * enables email/password login + session-cookies on top of bearer
   * tokens. Unset (default) → behaviour identical to ADR-0032 single-user.
   */
  readonly multiUser?: MultiUserConfig;
}

export const DEFAULT_SERVER_CONFIG: Omit<ServerConfig, 'authToken' | 'staticDir'> = {
  host: '0.0.0.0',
  port: 3000,
  corsOrigin: null,
  sseHeartbeatMs: 30_000,
  trustProxy: 1,
};
