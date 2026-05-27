import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hostAllowed,
  installNetGuard,
  NetGuardError,
} from '../../../../src/domains/skill-lifecycle/sandbox/net-guard.js';

describe('hostAllowed', () => {
  it('matches exact hostnames', () => {
    expect(hostAllowed('api.anthropic.com', ['api.anthropic.com'])).toBe(true);
  });

  it('rejects unlisted hostnames', () => {
    expect(hostAllowed('evil.example.com', ['api.anthropic.com'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hostAllowed('API.Anthropic.com', ['api.anthropic.com'])).toBe(true);
    expect(hostAllowed('api.anthropic.com', ['API.Anthropic.COM'])).toBe(true);
  });

  it('ignores port-suffix', () => {
    expect(hostAllowed('localhost:3000', ['localhost'])).toBe(true);
    expect(hostAllowed('localhost', ['localhost:8080'])).toBe(true);
  });

  it('* wildcard allows everything', () => {
    expect(hostAllowed('evil.example.com', ['*'])).toBe(true);
    expect(hostAllowed('localhost', ['*'])).toBe(true);
  });

  it('empty allowlist denies everything', () => {
    expect(hostAllowed('localhost', [])).toBe(false);
    expect(hostAllowed('api.anthropic.com', [])).toBe(false);
  });

  it('empty host string denies', () => {
    expect(hostAllowed('', ['*'])).toBe(false);
  });
});

describe('installNetGuard', () => {
  let originalFetch: typeof globalThis.fetch;

  // Save + restore fetch so tests don't leak guard-state across each other.
  // Use an installed guard's `uninstall()` rather than direct fetch=original
  // assignment, but also save here as a safety net.
  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks fetch to host not in allowlist', async () => {
    originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const guard = installNetGuard(['api.anthropic.com']);
    try {
      await expect(globalThis.fetch('https://evil.example.com/exfil')).rejects.toThrow(
        NetGuardError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      guard.uninstall();
    }
  });

  it('allows fetch to host in allowlist', async () => {
    originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const guard = installNetGuard(['api.anthropic.com']);
    try {
      const r = await globalThis.fetch('https://api.anthropic.com/v1/messages');
      expect(r.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      guard.uninstall();
    }
  });

  it('blocks even when URL is malformed (defense-in-depth — fail-safe deny)', async () => {
    originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const guard = installNetGuard(['*']);
    try {
      // `fetch('not-a-url')` will throw inside URL constructor — guard
      // catches that and reports as denied.
      await expect(globalThis.fetch('not-a-url')).rejects.toThrow(NetGuardError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      guard.uninstall();
    }
  });

  it('* wildcard escape-hatch allows known + unknown hosts', async () => {
    originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const guard = installNetGuard(['*']);
    try {
      await globalThis.fetch('https://example.com/');
      await globalThis.fetch('https://another.example.org/');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      guard.uninstall();
    }
  });

  it('accepts URL object input', async () => {
    originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const guard = installNetGuard(['api.anthropic.com']);
    try {
      await globalThis.fetch(new URL('https://api.anthropic.com/v1/messages'));
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      guard.uninstall();
    }
  });

  it('blocks URL object to non-allowlisted host', async () => {
    originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const guard = installNetGuard(['api.anthropic.com']);
    try {
      await expect(globalThis.fetch(new URL('https://evil.example.com/x'))).rejects.toThrow(
        NetGuardError,
      );
    } finally {
      guard.uninstall();
    }
  });

  it('uninstall restores original fetch', async () => {
    originalFetch = globalThis.fetch;
    const guard = installNetGuard([]);
    expect(globalThis.fetch).not.toBe(originalFetch);
    guard.uninstall();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('NetGuardError carries host + api fields', async () => {
    originalFetch = globalThis.fetch;
    const guard = installNetGuard([]);
    try {
      try {
        await globalThis.fetch('https://evil.example.com/');
        throw new Error('expected rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(NetGuardError);
        expect((err as NetGuardError).host).toBe('evil.example.com');
        expect((err as NetGuardError).api).toBe('fetch');
      }
    } finally {
      guard.uninstall();
    }
  });
});
