/**
 * Change-Password modal (Phase Web-7-4 — ADR-0036 §Frontend).
 *
 * Pattern aus `secret-add-modal.tsx`: type=password Inputs mit
 * `autoComplete="new-password"` + `spellCheck={false}`, beide Werte
 * werden nach Submit (auch bei Fehler) explizit auf '' gesetzt,
 * Warn-Banner über das DevTools-Risiko (Lesson 2026-05-22).
 *
 * @module gui/components/change-password-modal
 */
import { useCallback, useState } from 'react';
import { AuthApiError, changePassword } from '../lib/auth-api';

export interface ChangePasswordModalProps {
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

export function ChangePasswordModal({ onClose, onChanged }: ChangePasswordModalProps) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (oldPassword.length === 0 || newPassword.length === 0) {
        setError('Alle Felder müssen ausgefüllt sein.');
        return;
      }
      if (newPassword.length < 12) {
        setError('Neues Passwort muss mindestens 12 Zeichen lang sein.');
        return;
      }
      if (newPassword !== confirm) {
        setError('Neue Passwörter stimmen nicht überein.');
        return;
      }
      setSubmitting(true);
      try {
        await changePassword(oldPassword, newPassword);
        setOldPassword('');
        setNewPassword('');
        setConfirm('');
        onChanged();
      } catch (err) {
        if (err instanceof AuthApiError) {
          setError(
            err.code === 'weak-password'
              ? 'Neues Passwort zu schwach.'
              : err.status === 401
                ? 'Aktuelles Passwort falsch.'
                : err.message,
          );
        } else {
          setError(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
        }
        setOldPassword('');
        setNewPassword('');
        setConfirm('');
      } finally {
        setSubmitting(false);
      }
    },
    [oldPassword, newPassword, confirm, onChanged],
  );

  return (
    <div className="modal-backdrop">
      <button
        type="button"
        className="modal-backdrop-button"
        aria-label="Modal schließen"
        onClick={onClose}
      />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Passwort ändern">
        <h2>Passwort ändern</h2>
        <div className="modal-warn-banner" role="status">
          Hinweis: Passwörter sind während der Eingabe in Browser-DevTools sichtbar.
        </div>
        <form onSubmit={handleSubmit}>
          <label className="modal-form-row">
            <span>Aktuelles Passwort</span>
            <input
              type="password"
              autoComplete="current-password"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="modal-form-row">
            <span>Neues Passwort (mindestens 12 Zeichen)</span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="modal-form-row">
            <span>Neues Passwort bestätigen</span>
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
          <div className="modal-footer">
            <button type="button" onClick={onClose} disabled={submitting}>
              Abbrechen
            </button>
            <button type="submit" disabled={submitting}>
              {submitting ? 'Speichere …' : 'Passwort ändern'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
