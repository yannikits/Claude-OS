import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../src/pages/login';

const verifyAuthMock = vi.fn<(token: string) => Promise<boolean>>();
const setAuthMock = vi.fn<(token: string) => void>();

vi.mock('../src/lib/rpc', () => ({
  getAuthTransport: () => ({
    verifyAuth: verifyAuthMock,
    setAuth: setAuthMock,
    hasAuth: () => false,
    clearAuth: () => {},
    call: async () => {
      throw new Error('not implemented in this test');
    },
    subscribe: async () => () => {},
  }),
}));

beforeEach(() => {
  verifyAuthMock.mockReset();
  setAuthMock.mockReset();
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.clear();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoginPage tabs', () => {
  it('renders both tabs with Email default-active', () => {
    render(<LoginPage onAuthenticated={() => {}} />);
    const emailTab = screen.getByRole('tab', { name: /Email \+ Passwort/ });
    const tokenTab = screen.getByRole('tab', { name: /API-Token/ });
    expect(emailTab.getAttribute('aria-selected')).toBe('true');
    expect(tokenTab.getAttribute('aria-selected')).toBe('false');
  });

  it('switching to token tab swaps form fields', () => {
    render(<LoginPage onAuthenticated={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /API-Token/ }));
    expect(screen.getByRole('tab', { name: /API-Token/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByPlaceholderText(/CLAUDE_OS_AUTH_TOKEN/)).toBeTruthy();
  });

  it('email-tab submit calls onAuthenticated with mode=cookie on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { id: 'u-1', email: 'alice@example.com', tenantId: 'user-abc' },
          csrfToken: 'a'.repeat(64),
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const onAuth = vi.fn();
    render(<LoginPage onAuthenticated={onAuth} />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Passwort'), {
      target: { value: 'correct-horse-battery-staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));

    await waitFor(() => {
      expect(onAuth).toHaveBeenCalledWith('cookie', expect.any(Object));
    });
  });

  it('token-tab submit calls setAuth and onAuthenticated with mode=token', async () => {
    verifyAuthMock.mockResolvedValueOnce(true);
    const onAuth = vi.fn();
    render(<LoginPage onAuthenticated={onAuth} />);

    fireEvent.click(screen.getByRole('tab', { name: /API-Token/ }));
    fireEvent.change(screen.getByPlaceholderText(/CLAUDE_OS_AUTH_TOKEN/), {
      target: { value: 'some-bearer-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));

    await waitFor(() => {
      expect(setAuthMock).toHaveBeenCalledWith('some-bearer-token');
      expect(onAuth).toHaveBeenCalledWith('token');
    });
  });

  it('shows successBanner when provided', () => {
    render(<LoginPage onAuthenticated={() => {}} successBanner="Account angelegt." />);
    expect(screen.getByText('Account angelegt.')).toBeTruthy();
  });

  it('shows Register-Link only when onSwitchToRegister callback is provided', () => {
    const onSwitch = vi.fn();
    const { rerender } = render(
      <LoginPage onAuthenticated={() => {}} onSwitchToRegister={onSwitch} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Registrieren' }));
    expect(onSwitch).toHaveBeenCalled();

    rerender(<LoginPage onAuthenticated={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Registrieren' })).toBeNull();
  });
});
