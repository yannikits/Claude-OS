/**
 * Login page — only rendered in the HTTP (web) build. The Tauri build
 * skips this entirely because authentication is the OS-local user-session.
 *
 * The user enters the bearer token configured on the server side via
 * `$CLAUDE_OS_AUTH_TOKEN`. We verify it against `/api/auth/verify` before
 * storing — that gives the user a clear pass/fail signal instead of a
 * generic "rpc 401" after the redirect.
 *
 * @module @pages/login
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthTransport } from '../lib/rpc';

interface LoginProps {
  /** Called after a successful verify+setAuth so App can re-render. */
  readonly onAuthenticated: () => void;
}

export function LoginPage({ onAuthenticated }: LoginProps) {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transport = getAuthTransport();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the token field on mount without the a11y-flagged autoFocus prop.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (transport === null) {
      // Shouldn't happen — Login only rendered in HTTP mode, but guard
      // anyway so a misconfigured build fails loud.
      setError('rpc transport does not support authentication (Tauri build?)');
    }
  }, [transport]);

  const handleSubmit = useCallback(
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
        onAuthenticated();
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
        <p className="login-subtitle">
          Server-Anmeldung — gib dein Bearer-Token ein. Das Token wird nur in dieser Browser-Session
          gespeichert (sessionStorage).
        </p>
        <form onSubmit={handleSubmit}>
          <label className="login-field">
            <span>Bearer-Token</span>
            <input
              ref={inputRef}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={submitting}
              placeholder="Wert aus $CLAUDE_OS_AUTH_TOKEN"
            />
          </label>
          {error !== null && <div className="login-error">{error}</div>}
          <button type="submit" disabled={submitting || token.trim().length === 0}>
            {submitting ? 'Prüfe …' : 'Anmelden'}
          </button>
        </form>
        <p className="login-hint">
          Token vergessen? Auf dem Server:&nbsp;
          <code>docker exec claude-os printenv CLAUDE_OS_AUTH_TOKEN</code>
        </p>
      </div>
    </div>
  );
}
