import { describe, expect, it } from 'vitest';
import { checkSophosConfig } from '../../../src/core/doctor/checks.js';

function probeMap(map: Record<string, string>) {
  return async (key: string) => map[key] ?? null;
}

describe('checkSophosConfig', () => {
  it('ok when no customer has bridges.sophos', async () => {
    const r = await checkSophosConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a'],
      getCustomerFn: async () => ({ bridges: { sophos: undefined } }),
      secretsProbe: probeMap({}),
    });
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('no customer-workspaces reference bridges.sophos');
  });

  it('ok when all hosts have both creds', async () => {
    const r = await checkSophosConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['mueller'],
      getCustomerFn: async () => ({
        bridges: { sophos: { firewallHostname: 'fw.mueller.local' } },
      }),
      secretsProbe: probeMap({
        'sophos/fw.mueller.local/username': 'svc',
        'sophos/fw.mueller.local/password': 'pw',
      }),
    });
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('1 host');
  });

  it('warn when host configured but creds missing — names the host', async () => {
    const r = await checkSophosConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['mueller'],
      getCustomerFn: async () => ({
        bridges: { sophos: { firewallHostname: 'fw.mueller.local' } },
      }),
      secretsProbe: probeMap({}),
    });
    expect(r.severity).toBe('warn');
    expect(r.detail).toContain('fw.mueller.local');
    expect(r.hint ?? '').toContain('claude-os secrets set sophos/');
  });

  it('warn when partial creds (only username, no password)', async () => {
    const r = await checkSophosConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['mueller'],
      getCustomerFn: async () => ({
        bridges: { sophos: { firewallHostname: 'fw.mueller.local' } },
      }),
      secretsProbe: probeMap({ 'sophos/fw.mueller.local/username': 'svc' }),
    });
    expect(r.severity).toBe('warn');
  });

  it('deduplicates hosts across customers (multiple customers on same firewall cluster)', async () => {
    const r = await checkSophosConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['a', 'b', 'c'],
      getCustomerFn: async () => ({
        bridges: { sophos: { firewallHostname: 'shared-fw.example.com' } },
      }),
      secretsProbe: probeMap({
        'sophos/shared-fw.example.com/username': 'svc',
        'sophos/shared-fw.example.com/password': 'pw',
      }),
    });
    expect(r.severity).toBe('ok');
    expect(r.message).toContain('1 host');
  });

  it('warn when 2 of 3 hosts missing creds', async () => {
    const mapping: Record<string, string> = {
      a: 'fw.a.local',
      b: 'fw.b.local',
      c: 'fw.c.local',
    };
    const r = await checkSophosConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => Object.keys(mapping),
      getCustomerFn: async (_, slug) => ({
        bridges: { sophos: { firewallHostname: mapping[slug] ?? '' } },
      }),
      secretsProbe: probeMap({
        'sophos/fw.a.local/username': 'svc',
        'sophos/fw.a.local/password': 'pw',
      }),
    });
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('2 of 3');
  });

  it('warn when secrets-probe throws', async () => {
    const r = await checkSophosConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['mueller'],
      getCustomerFn: async () => ({
        bridges: { sophos: { firewallHostname: 'fw.mueller.local' } },
      }),
      secretsProbe: async () => {
        throw new Error('keyring offline');
      },
    });
    expect(r.severity).toBe('warn');
  });

  it('never returns severity=fail (Sophos optional)', async () => {
    const r = await checkSophosConfig({
      vaultRoot: '/fake',
      listSlugsFn: () => ['x'],
      getCustomerFn: async () => ({ bridges: { sophos: { firewallHostname: 'h' } } }),
      secretsProbe: probeMap({}),
    });
    expect(r.severity).not.toBe('fail');
  });
});
