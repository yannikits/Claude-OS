/**
 * Modal fuer Anthropic-Profile-delete (v1.x.+2).
 *
 * GitHub-Style "type-to-confirm" UX: Loesch-Button bleibt disabled bis
 * der User den exakten Profilnamen ins confirm-Input typed. Defense
 * gegen mis-click bei einer irreversible Aktion.
 *
 * Backend refused den Delete wenn name == active() — wir surface'n den
 * Error im banner, falls jemand das trotzdem versucht. UI bietet
 * standardmaessig nur Trash-Icons fuer non-active profiles, also
 * sollte das nicht passieren.
 *
 * @module gui/components/profile-delete-modal
 */
import { useCallback, useState } from 'react';
import { deleteProfile } from '../lib/rpc';
import { useSidecarOk } from '../lib/sidecar-status';

export interface ProfileDeleteModalProps {
  readonly name: string;
  readonly configDir: string;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}

export function ProfileDeleteModal({
  name,
  configDir,
  onClose,
  onDeleted,
}: ProfileDeleteModalProps) {
  const sidecarOk = useSidecarOk();
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmMatches = confirmText === name;
  const canSubmit = sidecarOk && confirmMatches && !submitting;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setError(null);
      try {
        await deleteProfile(name);
        onDeleted();
        onClose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('cannot delete active profile')) {
          setError(
            'Profil ist aktiv. Wechsle zuerst zu einem anderen Profil (Aktives Profil-Dropdown) und versuche es dann erneut.',
          );
        } else if (msg.includes('unknown-profile')) {
          setError(`Profil "${name}" existiert nicht (mehr).`);
        } else {
          setError(msg);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, name, onClose, onDeleted],
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
        aria-label="Profil loeschen"
      >
        <header className="modal-header">
          <h2>
            Profil <code>{name}</code> loeschen?
          </h2>
          <button type="button" className="modal-close" onClick={onClose} title="Schliessen">
            ×
          </button>
        </header>

        <p className="modal-warn-banner" data-testid="profile-delete-warn">
          <strong>Diese Aktion ist nicht rueckgaengig.</strong> Das Verzeichnis{' '}
          <code>{configDir}</code> wird inkl. <code>.credentials.json</code> komplett geloescht. Du
          musst dich neu einloggen wenn du das Profil spaeter wieder anlegst.
        </p>

        {error !== null && <p className="banner banner-error">{error}</p>}

        <form onSubmit={handleSubmit}>
          <label className="modal-form-row">
            <span>
              Tippe <code>{name}</code> um die Loeschung zu bestaetigen
            </span>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={name}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              data-testid="profile-confirm-input"
            />
          </label>

          <footer className="modal-footer">
            <button type="button" onClick={onClose} disabled={submitting}>
              Abbrechen
            </button>
            <button
              type="submit"
              className="btn-danger"
              disabled={!canSubmit}
              data-testid="profile-delete-submit"
            >
              {submitting ? 'Loesche …' : 'Loeschen'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
