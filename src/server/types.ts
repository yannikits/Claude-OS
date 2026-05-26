/**
 * Server-Transport-Adapter — typed config for the headless HTTP variant of claude-os.
 *
 * Implements ADR-0032 (Server-Deployment: Headless HTTP). The HTTP-Adapter
 * wraps the existing sidecar `RpcDispatcher` and exposes the same domain
 * methods over Fastify routes. See `tasks/phase-server-web.md` Phase Web-1.
 *
 * @module @server/types
 */

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
}

export const DEFAULT_SERVER_CONFIG: Omit<ServerConfig, 'authToken' | 'staticDir'> = {
  host: '0.0.0.0',
  port: 3000,
  corsOrigin: null,
  sseHeartbeatMs: 30_000,
  trustProxy: 1,
};
