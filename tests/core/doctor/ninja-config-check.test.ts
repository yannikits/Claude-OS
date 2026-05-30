import { describe, expect, it } from 'vitest';
import { checkNinjaConfig } from '../../../src/core/doctor/checks.js';

describe('checkNinjaConfig', () => {
  it('ok + skipped when neither secret is set', async () => {
    const r = await checkNinjaConfig({}, async () => null);
    expect(r.severity).toBe('ok');
    expect(r.message).toMatch(/not configured/i);
    expect(r.name).toBe('ninja-config');
  });

  it('ok when both clientId and clientSecret are present', async () => {
    const probe = async (k: string) =>
      k === 'ninja/clientId' || k === 'ninja/clientSecret' ? 'value' : null;
    const r = await checkNinjaConfig({}, probe);
    expect(r.severity).toBe('ok');
  });

  it('warn when only clientId is present', async () => {
    const probe = async (k: string) => (k === 'ninja/clientId' ? 'value' : null);
    const r = await checkNinjaConfig({}, probe);
    expect(r.severity).toBe('warn');
  });

  it('warn when only clientSecret is present', async () => {
    const probe = async (k: string) => (k === 'ninja/clientSecret' ? 'value' : null);
    const r = await checkNinjaConfig({}, probe);
    expect(r.severity).toBe('warn');
  });
});
