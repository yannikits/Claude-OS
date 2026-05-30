import { describe, expect, it, vi } from 'vitest';
import { NinjaBridge } from '../../../../src/domains/msp-bridges/ninja/index.js';
import type {
  NinjaAlertRaw,
  NinjaBridgeConfig,
  NinjaDeviceRaw,
} from '../../../../src/domains/msp-bridges/ninja/types.js';
import type { CustomerRecord } from '../../../../src/domains/msp-customers/index.js';

const BASE = 'https://eu.ninjarmm.com';
const CREDS = { clientId: 'cid-123', clientSecret: 'secret-xyz' };

function customerWithNinja(organizationId = 7): CustomerRecord {
  return {
    slug: 'mueller-gmbh',
    displayName: 'Mueller GmbH',
    bridges: { ninja: { organizationId } },
  };
}

function customerWithout(): CustomerRecord {
  return { slug: 'naked', displayName: 'Naked' };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const tokenResponse = (): Response =>
  jsonResponse({ access_token: 'tok-abc', expires_in: 3600, token_type: 'bearer' });

/** fetch mock that routes by URL: token endpoint, devices, alerts. */
function routedFetch(handlers: {
  token?: () => Response;
  devices?: () => Response;
  alerts?: () => Response;
}) {
  return vi.fn(async (url: string) => {
    if (url.includes('/ws/oauth/token')) return (handlers.token ?? tokenResponse)();
    if (url.includes('/v2/devices')) {
      return (handlers.devices ?? (() => jsonResponse([])))();
    }
    if (url.includes('/v2/alerts')) {
      return (handlers.alerts ?? (() => jsonResponse([])))();
    }
    throw new Error(`unexpected url: ${url}`);
  });
}

function makeBridge(
  fetchMock: ReturnType<typeof vi.fn>,
  over: Partial<NinjaBridgeConfig> = {},
): NinjaBridge {
  return new NinjaBridge({
    baseUrl: BASE,
    getCredentials: async () => CREDS,
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    ...over,
  });
}

const DEVICES: NinjaDeviceRaw[] = [
  { id: 1, systemName: 'pc-1', offline: false },
  { id: 2, systemName: 'pc-2', offline: true },
  { id: 3, systemName: 'srv-1', offline: false },
];
// Mirrors real NinjaOne /v2/alerts: severity is a string, often 'NONE' for
// low-signal conditions (e.g. patch reminders). Only non-NONE counts as actionable.
const ALERTS: NinjaAlertRaw[] = [
  { uid: 'a1', severity: 'CRITICAL' },
  { uid: 'a2', severity: 'NONE' },
];

describe('NinjaBridge.probe', () => {
  it('returns misconfigured WITHOUT fetching when bridges.ninja is missing', async () => {
    const fetchMock = routedFetch({});
    const probe = await makeBridge(fetchMock).probe(customerWithout());
    expect(probe.result.kind).toBe('misconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns auth-failed WITHOUT fetching when getCredentials yields null', async () => {
    const fetchMock = routedFetch({});
    const probe = await makeBridge(fetchMock, { getCredentials: async () => null }).probe(
      customerWithNinja(),
    );
    expect(probe.result.kind).toBe('auth-failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path: client_credentials token → devices + alerts → ok with counts', async () => {
    const fetchMock = routedFetch({
      devices: () => jsonResponse(DEVICES),
      alerts: () => jsonResponse(ALERTS),
    });
    const probe = await makeBridge(fetchMock).probe(customerWithNinja(7));

    // token request shape
    const tokenCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes('/ws/oauth/token'),
    );
    expect(tokenCall).toBeDefined();
    const tokenOpts = tokenCall?.[1] as RequestInit;
    expect(tokenOpts.method).toBe('POST');
    expect(String(tokenOpts.body)).toContain('grant_type=client_credentials');
    expect(String(tokenOpts.body)).toContain('scope=monitoring');

    // devices request: bearer + org filter
    const devCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/v2/devices'));
    const devUrl = devCall?.[0] as string;
    const devOpts = devCall?.[1] as RequestInit & { headers: Record<string, string> };
    expect(devUrl).toContain('7');
    expect(devOpts.headers.Authorization).toBe('Bearer tok-abc');

    expect(probe.result.kind).toBe('ok');
    if (probe.result.kind === 'ok') {
      expect(probe.result.data.deviceCount).toBe(3);
      expect(probe.result.data.offlineCount).toBe(1);
      expect(probe.result.data.alertCount).toBe(2);
      expect(probe.result.data.actionableAlertCount).toBe(1);
    }
  });

  it('reuses the cached token across probes (one token request for two probes)', async () => {
    const fetchMock = routedFetch({
      devices: () => jsonResponse(DEVICES),
      alerts: () => jsonResponse(ALERTS),
    });
    const bridge = makeBridge(fetchMock);
    await bridge.probe(customerWithNinja());
    await bridge.probe(customerWithNinja());
    const tokenCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('/ws/oauth/token'),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('oauth 401 → auth-failed', async () => {
    const fetchMock = routedFetch({ token: () => new Response('', { status: 401 }) });
    const probe = await makeBridge(fetchMock).probe(customerWithNinja());
    expect(probe.result.kind).toBe('auth-failed');
  });

  it('devices 500 → unreachable', async () => {
    const fetchMock = routedFetch({ devices: () => new Response('', { status: 500 }) });
    const probe = await makeBridge(fetchMock).probe(customerWithNinja());
    expect(probe.result.kind).toBe('unreachable');
  });

  it('unexpected devices shape → error', async () => {
    const fetchMock = routedFetch({ devices: () => jsonResponse({ nope: true }) });
    const probe = await makeBridge(fetchMock).probe(customerWithNinja());
    expect(probe.result.kind).toBe('error');
  });

  it('alerts call failing (404) degrades gracefully → ok with alertCount null', async () => {
    const fetchMock = routedFetch({
      devices: () => jsonResponse(DEVICES),
      alerts: () => new Response('', { status: 404 }),
    });
    const probe = await makeBridge(fetchMock).probe(customerWithNinja());
    expect(probe.result.kind).toBe('ok');
    if (probe.result.kind === 'ok') {
      expect(probe.result.data.deviceCount).toBe(3);
      expect(probe.result.data.alertCount).toBeNull();
      expect(probe.result.data.actionableAlertCount).toBeNull();
    }
  });

  it('returns auth-failed (never throws) when getCredentials rejects', async () => {
    const fetchMock = routedFetch({});
    const probe = await makeBridge(fetchMock, {
      getCredentials: async () => {
        throw new Error('secrets locked');
      },
    }).probe(customerWithNinja());
    expect(probe.result.kind).toBe('auth-failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invalidates the cached token on a 401 so the next probe re-logins', async () => {
    let deviceCalls = 0;
    let tokenCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/ws/oauth/token')) {
        tokenCalls += 1;
        return tokenResponse();
      }
      if (url.includes('/v2/devices')) {
        deviceCalls += 1;
        return deviceCalls === 2 ? new Response('', { status: 401 }) : jsonResponse(DEVICES);
      }
      if (url.includes('/v2/alerts')) return jsonResponse(ALERTS);
      throw new Error(`unexpected url: ${url}`);
    });
    const bridge = makeBridge(fetchMock);
    await bridge.probe(customerWithNinja()); // login #1, devices ok
    const p2 = await bridge.probe(customerWithNinja()); // cached token, devices 401 -> invalidate
    expect(p2.result.kind).toBe('auth-failed');
    await bridge.probe(customerWithNinja()); // cache empty -> re-login
    expect(tokenCalls).toBe(2);
  });

  it('alerts HTTP-200 with unexpected shape → alertCount null (not 0)', async () => {
    const fetchMock = routedFetch({
      devices: () => jsonResponse(DEVICES),
      alerts: () => jsonResponse({ nope: true }),
    });
    const probe = await makeBridge(fetchMock).probe(customerWithNinja());
    expect(probe.result.kind).toBe('ok');
    if (probe.result.kind === 'ok') {
      expect(probe.result.data.alertCount).toBeNull();
      expect(probe.result.data.actionableAlertCount).toBeNull();
    }
  });
});
