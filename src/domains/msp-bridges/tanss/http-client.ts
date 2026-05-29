/**
 * Minimal fetch wrapper for TANSS.
 *
 * Responsibilities:
 *   - Set the `apiToken: <key>` header (case-sensitive, NOT `Authorization`)
 *   - AbortController-driven timeout
 *   - Return either parsed JSON OR a typed BridgeResult error
 *
 * Non-responsibilities (intentional):
 *   - No retry — that's a Phase-7-E aggregator concern
 *   - No caching — token rotation breaks caches; ADR-0038 wants per-call freshness
 *   - No body validation beyond "parse-able JSON" — `mapper.ts` is defensive
 *
 * @module @domains/msp-bridges/tanss/http-client
 */

import type { BridgeResult } from '../types.js';
import { classifyHttpStatus, classifyThrown } from './classify-error.js';
import type { TanssBridgeConfig } from './types.js';

export interface TanssHttpClient {
  /** GET an api-path (must start with `/`). Returns parsed JSON or a BridgeResult error. */
  getJson<T = unknown>(
    path: string,
    apiToken: string,
  ): Promise<{ ok: true; data: T } | { ok: false; error: BridgeResult<never> }>;
}

export function createTanssHttpClient(config: TanssBridgeConfig): TanssHttpClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const base = stripTrailingSlash(config.serverUrl);

  return {
    async getJson<T>(
      path: string,
      apiToken: string,
    ): Promise<{ ok: true; data: T } | { ok: false; error: BridgeResult<never> }> {
      if (!path.startsWith('/')) {
        return { ok: false, error: { kind: 'error', message: 'internal: path must start with /' } };
      }
      const url = `${base}${path}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            apiToken,
            Accept: 'application/json',
          },
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        return { ok: false, error: classifyThrown(err) };
      }
      clearTimeout(timer);

      if (!response.ok) {
        return {
          ok: false,
          error: classifyHttpStatus(response.status, response.headers.get('retry-after')),
        };
      }

      try {
        const data = (await response.json()) as T;
        return { ok: true, data };
      } catch (err) {
        return {
          ok: false,
          error: { kind: 'error', message: `invalid JSON: ${shortMessage(err)}` },
        };
      }
    },
  };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function shortMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return 'unknown';
}
