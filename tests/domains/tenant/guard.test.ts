import { describe, expect, it } from 'vitest';
import {
  assertActiveTenant,
  assertNoActiveTenant,
  CrossTenantAccessError,
  NoTenantContextError,
  resolveTenantContext,
} from '../../../src/domains/tenant/index.js';

describe('resolveTenantContext', () => {
  it('extracts tenant from msp-customers/<id>', () => {
    expect(resolveTenantContext('msp-customers/acme')).toEqual({
      workspace: 'msp-customers/acme',
      tenant: 'acme',
    });
  });

  it('returns null tenant for personal', () => {
    expect(resolveTenantContext('personal')).toEqual({
      workspace: 'personal',
      tenant: null,
    });
  });

  it('returns null tenant for msp-internal', () => {
    expect(resolveTenantContext('msp-internal')).toEqual({
      workspace: 'msp-internal',
      tenant: null,
    });
  });

  it('returns null tenant for empty customer suffix', () => {
    expect(resolveTenantContext('msp-customers/')).toEqual({
      workspace: 'msp-customers/',
      tenant: null,
    });
  });
});

describe('assertActiveTenant', () => {
  it('returns context when workspace tenant matches requested', () => {
    const ctx = assertActiveTenant({
      activeWorkspace: 'msp-customers/acme',
      requestedTenant: 'acme',
      actionLabel: 'tanss.tickets.list',
    });
    expect(ctx.tenant).toBe('acme');
  });

  it('throws NoTenantContextError when active workspace has no tenant', () => {
    expect(() =>
      assertActiveTenant({
        activeWorkspace: 'personal',
        requestedTenant: 'acme',
        actionLabel: 'tanss.tickets.list',
      }),
    ).toThrow(NoTenantContextError);
  });

  it('throws CrossTenantAccessError when active tenant differs from requested', () => {
    expect(() =>
      assertActiveTenant({
        activeWorkspace: 'msp-customers/acme',
        requestedTenant: 'other-customer',
        actionLabel: 'tanss.tickets.list',
      }),
    ).toThrow(CrossTenantAccessError);
  });

  it('error messages name the workspace, tenants, and action label', () => {
    try {
      assertActiveTenant({
        activeWorkspace: 'msp-customers/acme',
        requestedTenant: 'other',
        actionLabel: 'ninja.devices.list',
      });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('acme');
      expect((err as Error).message).toContain('other');
      expect((err as Error).message).toContain('ninja.devices.list');
    }
  });
});

describe('assertNoActiveTenant', () => {
  it('returns context when workspace has no tenant', () => {
    const ctx = assertNoActiveTenant({
      activeWorkspace: 'msp-internal',
      actionLabel: 'firmen-doku-write',
    });
    expect(ctx.tenant).toBeNull();
  });

  it('throws when a customer tenant is active', () => {
    expect(() =>
      assertNoActiveTenant({
        activeWorkspace: 'msp-customers/acme',
        actionLabel: 'firmen-doku-write',
      }),
    ).toThrow(CrossTenantAccessError);
  });
});
