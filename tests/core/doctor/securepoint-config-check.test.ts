import { describe, expect, it } from 'vitest';
import { checkSecurepointConfig } from '../../../src/core/doctor/checks.js';

function probeMap(map: Record<string, string>) {
  return async (key: string) => map[key] ?? null;
}

describe('checkSecurepointConfig', () => {
  it('ok when no customer references bridges.securepoint', async () => {
    const r = await checkSecurepointConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a'],
      getCustomerFn: async () => ({ bridges: { securepoint: undefined } }),
      secretsProbe: probeMap({}),
    });
    expect(r.severity).toBe('ok');
  });

  it('ok when N customer(s) reference and apiKey present', async () => {
    const r = await checkSecurepointConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a', 'b'],
      getCustomerFn: async (_, s) => ({
        bridges: { securepoint: { deviceId: `UTM-${s}` } },
      }),
      secretsProbe: probeMap({ 'securepoint/apiKey': 'eyJhbGc.SAMPLE' }),
    });
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('2 customer');
  });

  it('warn when customers reference but apiKey missing', async () => {
    const r = await checkSecurepointConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a'],
      getCustomerFn: async () => ({ bridges: { securepoint: { deviceId: 'UTM-A' } } }),
      secretsProbe: probeMap({}),
    });
    expect(r.severity).toBe('warn');
    expect(r.hint ?? '').toContain('securepoint/apiKey');
  });

  it('warn when secrets-probe throws', async () => {
    const r = await checkSecurepointConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a'],
      getCustomerFn: async () => ({ bridges: { securepoint: { deviceId: 'UTM-A' } } }),
      secretsProbe: async () => {
        throw new Error('keyring offline');
      },
    });
    expect(r.severity).toBe('warn');
  });

  it('never returns severity=fail (Securepoint optional)', async () => {
    const r = await checkSecurepointConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a'],
      getCustomerFn: async () => ({ bridges: { securepoint: { deviceId: 'UTM-A' } } }),
      secretsProbe: probeMap({}),
    });
    expect(r.severity).not.toBe('fail');
  });
});
