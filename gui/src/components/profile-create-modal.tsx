/**
 * Modal fuer Anthropic-Profile-create (v1.x.+2).
 *
 * Wrapt `settings.createProfile` RPC. Name-Pattern wird im Frontend
 * leichtgewichtig regex-validiert; die finale Validation passiert
 * server-side (ProfileManager.NAME_PATTERN), wir spiegeln nur das
 * Pattern fuer schnelles UX-Feedback.
 *
 * @module gui/components/profile-create-modal
 */
import { useCallback, useState } from 'react';
import { createProfile } from '../lib/rpc';
import { useSidecarOk } from '../lib/sidecar-status';

export interface ProfileCreateModalProps {
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function ProfileCreateModal({ onClose, onSaved }: ProfileCreateModalProps) {
  const sidecarOk = useSidecarOk();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length > 0 && NAME_PATTERN.test(trimmedName);
  const canSubmit = sidecarOk && nameValid && !submitting;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setError(null);
      try {
        await createProfile(trimmedName);
        setName('');
        onSaved();
        onClose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('profile-exists')) {
          setError(`Profil "${trimmedName}" existiert bereits.`);
        } else {
          setError(msg);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, trimmedName, onClose, onSaved],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-target for close
    // biome-ignore lint/a11y/useKeyWithClickEvents: ESC handled on inner panel
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
        role="dialog"
        aria-label="Profil anlegen"
      >
        <header className="modal-header">
          <h2>Anthropic-Profil anlegen</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Schliessen">
            ×
          </button>
        </header>

        <p className="muted">
          Legt ein neues Profil-Verzeichnis unter <code>auth-profiles/</code> an. Du musst dich nach
          dem Create separat fuer dieses Profil bei Anthropic einloggen (Settings → Login).
        </p>

        {error !== null && <p className="banner banner-error">{error}</p>}

        <form onSubmit={handleSubmit}>
          <label className="modal-form-row">
            <span>Profil-Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z.B. work, personal, client-acme"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              data-testid="profile-name-input"
            />
            {trimmedName.length > 0 && !nameValid && (
              <span className="muted" style={{ color: 'var(--danger)', fontSize: '11px' }}>
                Erlaubt: A-Z a-z 0-9 . _ - (max 64 Zeichen)
              </span>
            )}
          </label>

          <footer className="modal-footer">
            <button type="button" onClick={onClose} disabled={submitting}>
              Abbrechen
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!canSubmit}
              data-testid="profile-create-submit"
            >
              {submitting ? 'Lege an …' : 'Anlegen'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
