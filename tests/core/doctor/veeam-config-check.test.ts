import { describe, expect, it } from 'vitest';
import { checkVeeamConfig } from '../../../src/core/doctor/checks.js';

function probeMap(map: Record<string, string>) {
  return async (key: string) => map[key] ?? null;
}

describe('checkVeeamConfig', () => {
  it('ok when no customer-workspaces reference bridges.veeam', async () => {
    const r = await checkVeeamConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a', 'b'],
      getCustomerFn: async (_, slug) => ({
        bridges: slug === 'a' ? { veeam: undefined } : undefined,
      }),
      secretsProbe: probeMap({}),
    });
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('no customer-workspaces reference bridges.veeam');
  });

  it('ok when one host configured + both creds present', async () => {
    const r = await checkVeeamConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['mueller-gmbh'],
      getCustomerFn: async () => ({ bridges: { veeam: { serverHostname: 'vbr.mueller.local' } } }),
      secretsProbe: probeMap({
        'veeam/vbr.mueller.local/username': 'svc',
        'veeam/vbr.mueller.local/password': 'pw',
      }),
    });
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('1 host');
  });

  it('warn when host configured but creds missing — names the host', async () => {
    const r = await checkVeeamConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['mueller-gmbh'],
      getCustomerFn: async () => ({ bridges: { veeam: { serverHostname: 'vbr.mueller.local' } } }),
      secretsProbe: probeMap({}),
    });
    expect(r.severity).toBe('warn');
    expect(r.detail).toContain('vbr.mueller.local');
    expect(r.hint ?? '').toContain('claude-os secrets set veeam/');
  });

  it('warn when partial creds (only username, no password)', async () => {
    const r = await checkVeeamConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['mueller-gmbh'],
      getCustomerFn: async () => ({ bridges: { veeam: { serverHostname: 'vbr.mueller.local' } } }),
      secretsProbe: probeMap({ 'veeam/vbr.mueller.local/username': 'svc' }),
    });
    expect(r.severity).toBe('warn');
  });

  it('deduplicates hosts across customers (e.g. two customers on same VBR cluster)', async () => {
    const r = await checkVeeamConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a', 'b', 'c'],
      getCustomerFn: async () => ({ bridges: { veeam: { serverHostname: 'shared.example.com' } } }),
      secretsProbe: probeMap({
        'veeam/shared.example.com/username': 'svc',
        'veeam/shared.example.com/password': 'pw',
      }),
    });
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('1 host');
  });

  it('warn when 2 of 3 hosts missing creds', async () => {
    const mapping: Record<string, string> = {
      'a-corp': 'vbr.a.local',
      'b-corp': 'vbr.b.local',
      'c-corp': 'vbr.c.local',
    };
    const r = await checkVeeamConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => Object.keys(mapping),
      getCustomerFn: async (_, slug) => ({
        bridges: { veeam: { serverHostname: mapping[slug] ?? '' } },
      }),
      secretsProbe: probeMap({
        'veeam/vbr.a.local/username': 'svc',
        'veeam/vbr.a.local/password': 'pw',
      }),
    });
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('2 of 3');
  });

  it('warn when secrets-probe throws', async () => {
    const r = await checkVeeamConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['mueller-gmbh'],
      getCustomerFn: async () => ({ bridges: { veeam: { serverHostname: 'vbr.mueller.local' } } }),
      secretsProbe: async () => {
        throw new Error('keyring offline');
      },
    });
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('secrets-store probe failed');
  });

  it('never returns severity=fail (Veeam optional)', async () => {
    const all = await Promise.all([
      checkVeeamConfig({
        vaultRoot: '/fake',
        listSlugsFn: () => [],
        getCustomerFn: async () => null,
        secretsProbe: probeMap({}),
      }),
      checkVeeamConfig({
        vaultRoot: '/fake',
        listSlugsFn: () => ['x'],
        getCustomerFn: async () => ({ bridges: { veeam: { serverHostname: 'h' } } }),
        secretsProbe: probeMap({}),
      }),
    ]);
    for (const r of all) expect(r.severity).not.toBe('fail');
  });
});
