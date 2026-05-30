/**
 * NinjaBridge — single-tenant-per-MSP Read-Bridge for NinjaOne.
 *
 * One `probe(customer)`:
 *   1. Reads customer.bridges.ninja.organizationId (else misconfigured)
 *   2. Fetches OAuth client-app credentials (else auth-failed)
 *   3. Uses cached token if fresh, else client_credentials login
 *   4. GET /v2/devices?df=org=<id>           → device + offline counts (required)
 *   5. GET /v2/alerts?df=org=<id>            → active-alert count (best-effort;
 *      an HTTP failure here degrades to alertCount=null, NOT a probe failure)
 *
 * ADR-0038 hard-rules: never throws, credentials fetched per probe, real
 * durationMs. One Ninja tenant for the whole MSP → one shared token cache.
 *
 * @module @domains/msp-bridges/ninja/bridge
 */
import type { CustomerRecord } from '../../msp-customers/index.js';
import type { BridgeKind, BridgeProbe, BridgeResult, ReadBridge } from '../types.js';
import { clientCredentialsLogin, NinjaTokenCache } from './auth.js';
import { ninjaGet } from './http-client.js';
import { extractArray, mapNinjaDevices } from './mapper.js';
import type {
  NinjaAlertRaw,
  NinjaBridgeConfig,
  NinjaCredentials,
  NinjaDeviceRaw,
  NinjaStatus,
} from './types.js';

const DEFAULT_SCOPE = 'monitoring';
const DEFAULT_TIMEOUT_MS = 15_000;

export class NinjaBridge implements ReadBridge<NinjaStatus> {
  readonly kind: BridgeKind = 'ninja';
  private readonly cache = new NinjaTokenCache();
  private readonly baseUrl: string;
  private readonly scope: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: NinjaBridgeConfig) {
    this.baseUrl = stripTrailingSlash(config.baseUrl);
    this.scope = config.scope ?? DEFAULT_SCOPE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async probe(customer: CustomerRecord): Promise<BridgeProbe<NinjaStatus>> {
    const probedAt = new Date().toISOString();
    const start = Date.now();

    const ids = customer.bridges?.ninja;
    if (!ids || typeof ids.organizationId !== 'number') {
      return done(customer, probedAt, start, {
        kind: 'misconfigured',
        message: 'customer.yaml has no bridges.ninja.organizationId',
      });
    }

    let creds: NinjaCredentials | null;
    try {
      creds = await this.config.getCredentials();
    } catch (err) {
      return done(customer, probedAt, start, {
        kind: 'auth-failed',
        message: `secrets-backend error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (creds === null || creds.clientId.length === 0 || creds.clientSecret.length === 0) {
      return done(customer, probedAt, start, {
        kind: 'auth-failed',
        message:
          'no NinjaOne client credentials in secrets-backend (ninja/clientId + ninja/clientSecret)',
      });
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    let token = this.cache.get();
    if (token === null) {
      const login = await clientCredentialsLogin({
        baseUrl: this.baseUrl,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        scope: this.scope,
        fetchImpl: this.fetchImpl,
        signal: ctrl.signal,
      });
      if (!login.ok) {
        clearTimeout(timer);
        return done(customer, probedAt, start, login.error);
      }
      this.cache.set(login.accessToken, login.expiresInSec);
      token = login.accessToken;
    }

    const orgFilter = encodeURIComponent(`org=${ids.organizationId}`);

    const devicesResp = await ninjaGet<unknown>(
      `${this.baseUrl}/v2/devices?df=${orgFilter}`,
      token,
      this.fetchImpl,
      ctrl.signal,
    );
    if (!devicesResp.ok) {
      clearTimeout(timer);
      return done(customer, probedAt, start, devicesResp.error);
    }
    const devices = extractArray<NinjaDeviceRaw>(devicesResp.data);
    if (devices === null) {
      clearTimeout(timer);
      return done(customer, probedAt, start, {
        kind: 'error',
        message: 'unexpected NinjaOne devices response — neither array nor {results:[...]}',
      });
    }
    const { deviceCount, offlineCount } = mapNinjaDevices(devices);

    // Alerts are best-effort: a failure here must not sink the whole probe.
    const alertsResp = await ninjaGet<unknown>(
      `${this.baseUrl}/v2/alerts?df=${orgFilter}`,
      token,
      this.fetchImpl,
      ctrl.signal,
    );
    clearTimeout(timer);
    const alertCount = alertsResp.ok
      ? (extractArray<NinjaAlertRaw>(alertsResp.data)?.length ?? null)
      : null;

    return done<NinjaStatus>(customer, probedAt, start, {
      kind: 'ok',
      data: { deviceCount, offlineCount, alertCount },
    });
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function done<T>(
  customer: CustomerRecord,
  probedAt: string,
  start: number,
  result: BridgeResult<T>,
): BridgeProbe<T> {
  return {
    bridgeKind: 'ninja',
    customerSlug: customer.slug,
    probedAt,
    durationMs: Date.now() - start,
    result,
  };
}
