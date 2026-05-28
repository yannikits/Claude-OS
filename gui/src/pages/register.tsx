/**
 * Register page — conditional on server `allowRegistration` flag
 * (probed via `/api/auth/me`). Mounts only in the HTTP build; the
 * Tauri build never reaches here.
 *
 * Spec: Email + Password + Confirm-Password. Server-side rate-limit
 * (3 / IP / hour) — surfaced as 429 with retry-after.
 *
 * Sicherheits-Pattern (Lesson 2026-05-22): `type=password` +
 * `autoComplete="new-password"` + `spellCheck={false}`, `setValue('')`
 * nach Submit, prominenter Warn-Banner über DevTools-Risiko.
 *
 * @module @pages/register
 */
import { useCallback, useState } from 'react';
import { AuthApiError, register } from '../lib/auth-api';

interface RegisterProps {
  readonly onRegistered: (email: string) => void;
  readonly onCancel: () => void;
}

export function RegisterPage({ onRegistered, onCancel }: RegisterProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      const trimmedEmail = email.trim().toLowerCase();
      if (trimmedEmail.length === 0) {
        setError('Email darf nicht leer sein.');
        return;
      }
      if (password.length < 12) {
        setError('Passwort muss mindestens 12 Zeichen lang sein.');
        return;
      }
      if (password !== confirm) {
        setError('Passwörter stimmen nicht überein.');
        return;
      }

      setSubmitting(true);
      try {
        await register(trimmedEmail, password);
        setPassword('');
        setConfirm('');
        onRegistered(trimmedEmail);
      } catch (err) {
        if (err instanceof AuthApiError) {
          const msg =
            err.code === 'duplicate-email'
              ? 'Diese Email ist bereits registriert.'
              : err.code === 'invalid-email'
                ? 'Ungültiges Email-Format.'
                : err.code === 'weak-password'
                  ? 'Passwort zu schwach (mindestens 12 Zeichen).'
                  : err.code === 'rate-limited'
                    ? 'Zu viele Versuche. Bitte später erneut versuchen.'
                    : err.message;
          setError(msg);
        } else {
          setError(
            `Registrierung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        setSubmitting(false);
      }
    },
    [email, password, confirm, onRegistered],
  );

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>claude-os</h1>
        <p className="login-subtitle">Neuen Account anlegen.</p>
        <div className="modal-warn-banner" role="status">
          Hinweis: das Passwort wird während der Eingabe vom Browser im Speicher gehalten. Auf
          Trusted-Network beschränken.
        </div>
        <form onSubmit={handleSubmit}>
          <label className="login-field">
            <span>Email</span>
            <input
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
            <span>Passwort (mindestens 12 Zeichen)</span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="login-field">
            <span>Passwort bestätigen</span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={submitting}
            />
          </label>
          {error !== null && <div className="login-error">{error}</div>}
          <div className="login-actions">
            <button type="submit" disabled={submitting}>
              {submitting ? 'Lege Account an …' : 'Registrieren'}
            </button>
            <button
              type="button"
              className="login-secondary"
              onClick={onCancel}
              disabled={submitting}
            >
              Zurück zum Login
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
