import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthApiError,
  authMe,
  changePassword,
  isCookieAuthed,
  loginWithCredentials,
  logoutCookie,
  readCookie,
  register,
} from '../src/lib/auth-api';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

let fetchMock: FetchMock;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem('claude-os-cookie-auth');
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loginWithCredentials', () => {
  it('POSTs email+password and flips the cookie-authed flag', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        user: { id: 'u-1', email: 'alice@example.com', tenantId: 'user-abc123' },
        csrfToken: 'a'.repeat(64),
        expiresAt: Date.now() + 60_000,
      }),
    );

    const result = await loginWithCredentials('alice@example.com', 'correct-horse-battery-staple');
    expect(result.user.email).toBe('alice@example.com');
    expect(isCookieAuthed()).toBe(true);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('/api/auth/login');
    const opts = call?.[1] as RequestInit;
    expect(opts.method).toBe('POST');
    expect(opts.credentials).toBe('same-origin');
    expect(JSON.parse(opts.body as string)).toEqual({
      email: 'alice@example.com',
      password: 'correct-horse-battery-staple',
    });
  });

  it('throws AuthApiError on 401 with code+message from server', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'unauthorized', message: 'invalid email or password' } }),
    );

    await expect(loginWithCredentials('a@b.c', 'wrong')).rejects.toBeInstanceOf(AuthApiError);
    expect(isCookieAuthed()).toBe(false);
  });
});

describe('register', () => {
  it('returns the created user on 201', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        user: { id: 'u-1', email: 'alice@example.com', tenantId: 'user-abc' },
      }),
    );
    const r = await register('alice@example.com', 'correct-horse-battery-staple');
    expect(r.user.email).toBe('alice@example.com');
  });

  it('throws AuthApiError for duplicate-email', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { code: 'duplicate-email', message: 'Email already registered' },
      }),
    );
    try {
      await register('alice@example.com', 'correct-horse-battery-staple');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthApiError);
      expect((err as AuthApiError).code).toBe('duplicate-email');
    }
  });
});

describe('authMe', () => {
  it('returns user + allowRegistration flag from server', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        user: { id: 'u-1', email: 'alice@example.com', tenantId: 'user-abc' },
        allowRegistration: true,
      }),
    );
    const me = await authMe();
    expect(me.user?.email).toBe('alice@example.com');
    expect(me.allowRegistration).toBe(true);
  });

  it('returns {user:null,allowRegistration:false} on 401 (treated as unauth)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    const me = await authMe();
    expect(me).toEqual({ user: null, allowRegistration: false });
    expect(isCookieAuthed()).toBe(false);
  });
});

describe('logoutCookie', () => {
  it('POSTs logout and clears the cookie-authed flag (even on network error)', async () => {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('claude-os-cookie-auth', '1');
    }
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await logoutCookie();
    expect(isCookieAuthed()).toBe(false);
  });

  it('attaches csrf header from cookie when present', async () => {
    Object.defineProperty(document, 'cookie', {
      value: 'claude_os_csrf=token-abc; other=x',
      configurable: true,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await logoutCookie();
    const call = fetchMock.mock.calls[0];
    const headers = (call?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('token-abc');
  });
});

describe('changePassword', () => {
  it('POSTs change-password and resolves on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(changePassword('old', 'new-much-longer-pass')).resolves.toBeUndefined();
  });

  it('throws AuthApiError on 401 wrong-old', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'unauthorized', message: 'old password incorrect' } }),
    );
    await expect(changePassword('wrong', 'new-much-longer-pass')).rejects.toBeInstanceOf(
      AuthApiError,
    );
  });
});

describe('readCookie', () => {
  it('returns named cookie value', () => {
    Object.defineProperty(document, 'cookie', {
      value: 'a=1; claude_os_csrf=abc123; b=2',
      configurable: true,
    });
    expect(readCookie('claude_os_csrf')).toBe('abc123');
    expect(readCookie('a')).toBe('1');
    expect(readCookie('missing')).toBeNull();
  });
});
