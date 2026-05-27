/**
 * Login page — HTTP build only.
 *
 * Two auth modes via tabs:
 *  - **Email + Passwort** (default, Phase Web-7-4) — POST /api/auth/login
 *    Server sets HTTP-only session cookie + readable CSRF cookie. We
 *    flag the session in sessionStorage so the AuthGate's next probe
 *    recognises the cookie-auth state.
 *  - **API-Token** (legacy, ADR-0033 Stage 1) — Bearer-Token saved to
 *    sessionStorage via existing AuthCapableTransport. Used by power-
 *    users and CI/CD.
 *
 * Optional registration link below the form when the server advertises
 * `allowRegistration: true` via `/api/auth/me`.
 *
 * Per Lesson 2026-05-22 — Web-Renderer secret-input: `type=password`,
 * `autoComplete="new-password"`, `spellCheck={false}`, `setValue('')`
 * on submit, prominent warn-banner about DevTools risk.
 *
 * @module @pages/login
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthApiError, type AuthUser, loginWithCredentials } from '../lib/auth-api';
import { getAuthTransport } from '../lib/rpc';

interface LoginProps {
  readonly onAuthenticated: (mode: 'cookie' | 'token', user?: AuthUser) => void;
  readonly onSwitchToRegister?: () => void;
  /** Banner shown above the form after a successful registration. */
  readonly successBanner?: string;
}

type TabMode = 'email' | 'token';

export function LoginPage({ onAuthenticated, onSwitchToRegister, successBanner }: LoginProps) {
  const [tab, setTab] = useState<TabMode>('email');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [token, setToken] = useState('');
  const [revealed, setRevealed] = useState(false);

  const transport = getAuthTransport();
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, [tab]);

  useEffect(() => {
    if (transport === null) {
      setError('rpc transport does not support authentication (Tauri build?)');
    }
  }, [transport]);

  const submitEmail = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (email.trim().length === 0 || password.length === 0) {
        setError('Email und Passwort dürfen nicht leer sein.');
        return;
      }
      setSubmitting(true);
      try {
        const result = await loginWithCredentials(email.trim().toLowerCase(), password);
        setPassword('');
        onAuthenticated('cookie', result.user);
      } catch (err) {
        if (err instanceof AuthApiError) {
          const msg =
            err.code === 'rate-limited'
              ? 'Zu viele Versuche. Bitte später erneut versuchen.'
              : err.status === 401
                ? 'Email oder Passwort falsch.'
                : err.message;
          setError(msg);
        } else {
          setError(`Anmeldung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [email, password, onAuthenticated],
  );

  const submitToken = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (transport === null) return;
      if (token.trim().length === 0) {
        setError('Token darf nicht leer sein.');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const ok = await transport.verifyAuth(token.trim());
        if (!ok) {
          setError('Token abgelehnt. Bitte überprüfe $CLAUDE_OS_AUTH_TOKEN auf dem Server.');
          return;
        }
        transport.setAuth(token.trim());
        onAuthenticated('token');
      } catch (err) {
        setError(`Verbindung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSubmitting(false);
      }
    },
    [token, transport, onAuthenticated],
  );

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>claude-os</h1>
        {successBanner !== undefined && (
          <div className="login-banner-success" role="status">
            {successBanner}
          </div>
        )}
        <div className="login-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'email'}
            className={tab === 'email' ? 'login-tab login-tab--active' : 'login-tab'}
            onClick={() => {
              setTab('email');
              setError(null);
            }}
          >
            Email + Passwort
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'token'}
            className={tab === 'token' ? 'login-tab login-tab--active' : 'login-tab'}
            onClick={() => {
              setTab('token');
              setError(null);
            }}
          >
            API-Token
          </button>
        </div>

        {tab === 'email' ? (
          <form onSubmit={submitEmail}>
            <p className="login-subtitle">Server-Anmeldung mit Email + Passwort.</p>
            <label className="login-field">
              <span>Email</span>
              <input
                ref={firstInputRef}
                type="email"
                autoComplete="email"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                placeholder="you@example.com"
              />
            </label>
            <label className="login-field">
              <span>Passwort</span>
              <input
                type="password"
                autoComplete="current-password"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </label>
            {error !== null && <div className="login-error">{error}</div>}
            <button type="submit" disabled={submitting}>
              {submitting ? 'Prüfe …' : 'Anmelden'}
            </button>
            {onSwitchToRegister !== undefined && (
              <p className="login-hint">
                Noch kein Account?{' '}
                <button type="button" className="login-link" onClick={onSwitchToRegister}>
                  Registrieren
                </button>
              </p>
            )}
          </form>
        ) : (
          <form onSubmit={submitToken}>
            <p className="login-subtitle">
              Server-Anmeldung mit Bearer-Token aus <code>$CLAUDE_OS_AUTH_TOKEN</code>.
            </p>
            <label className="login-field">
              <span>Bearer-Token</span>
              <div className="login-field-row">
                <input
                  ref={firstInputRef}
                  type={revealed ? 'text' : 'password'}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  name="claude-os-bearer-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData('text');
                    if (pasted.length > 0) {
                      e.preventDefault();
                      setToken(pasted.trim());
                    }
                  }}
                  disabled={submitting}
                  placeholder="Wert aus $CLAUDE_OS_AUTH_TOKEN"
                />
                <button
                  type="button"
                  className="login-reveal"
                  onClick={() => setRevealed((r) => !r)}
                  disabled={submitting}
                  aria-label={revealed ? 'Token verbergen' : 'Token anzeigen'}
                >
                  {revealed ? 'verbergen' : 'anzeigen'}
                </button>
              </div>
            </label>
            {error !== null && <div className="login-error">{error}</div>}
            <button type="submit" disabled={submitting || token.trim().length === 0}>
              {submitting ? 'Prüfe …' : 'Anmelden'}
            </button>
            <p className="login-hint">
              Token vergessen? Auf dem Server:&nbsp;
              <code>docker exec claude-os printenv CLAUDE_OS_AUTH_TOKEN</code>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
