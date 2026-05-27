import { describe, expect, it } from 'vitest';
import { resolveTenantFromToken, tokenToTenantId } from '../../../src/domains/tenant/index.js';
import { tokenToTenantId as serverTokenToTenantId } from '../../../src/server/auth.js';

describe('tokenToTenantId', () => {
  it('returns a 12-hex prefix of sha256(token)', () => {
    const id = tokenToTenantId('alice');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic — same token → same id', () => {
    expect(tokenToTenantId('alice')).toBe(tokenToTenantId('alice'));
  });

  it('differs for different tokens', () => {
    expect(tokenToTenantId('alice')).not.toBe(tokenToTenantId('bob'));
  });

  it('throws on empty token', () => {
    expect(() => tokenToTenantId('')).toThrow(/non-empty/);
  });

  it('matches the server-auth re-export (single source of truth)', () => {
    // ServerAuth re-exports the canonical domain function — parity is
    // structural, but this test prevents accidental drift if anyone
    // ever inlines a second copy in the transport layer.
    const sample = 'b0_M3J4cKnsWp5q9rT2vXyZ8aD1fG4hL';
    expect(serverTokenToTenantId(sample)).toBe(tokenToTenantId(sample));
  });
});

describe('resolveTenantFromToken', () => {
  it('returns a ServerTenantContext with default workspace and null MSP tenant', () => {
    const ctx = resolveTenantFromToken('alice');
    expect(ctx.workspace).toBe('personal');
    expect(ctx.tenant).toBeNull();
    expect(ctx.tokenTenantId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('produces stable tokenTenantId across calls', () => {
    const a = resolveTenantFromToken('alice');
    const b = resolveTenantFromToken('alice');
    expect(a.tokenTenantId).toBe(b.tokenTenantId);
  });

  it('two different tokens produce different tokenTenantIds', () => {
    const a = resolveTenantFromToken('alice');
    const b = resolveTenantFromToken('bob');
    expect(a.tokenTenantId).not.toBe(b.tokenTenantId);
  });

  it('throws on empty token (no silent default-tenant fallback)', () => {
    expect(() => resolveTenantFromToken('')).toThrow(/non-empty/);
  });
});
