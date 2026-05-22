/**
 * Modal fuer Secret-Add/Update via GUI (v1.x.+1).
 *
 * Security-Mitigations per ADR-0021 § X:
 *  - Value-Input ist `<input type="password">` mit autoComplete="new-password"
 *    und spellCheck=false (verhindert Browser-Save/Autofill-Leaks)
 *  - Value wird nach erfolgreichem Submit explizit auf "" gesetzt UND der
 *    State-Holder lebt nur in dieser Modal-Component (unmount = gone)
 *  - Prominenter Warn-Banner ueber den IPC/RAM-Pfad
 *  - Submit-Button disabled wenn !sidecarOk
 *  - secrets-backend-locked Error wird als typed Hinweis gezeigt
 *
 * @module gui/components/secret-add-modal
 */
import { useCallback, useState } from 'react';
import { setSecret } from '../lib/rpc';
import { useSidecarOk } from '../lib/sidecar-status';

export interface SecretAddModalProps {
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

export function SecretAddModal({ onClose, onSaved }: SecretAddModalProps) {
  const sidecarOk = useSidecarOk();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = sidecarOk && key.trim().length > 0 && !submitting;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setError(null);
      try {
        await setSecret(key.trim(), value);
        // SECURITY: clear value-state immediately after successful submit
        // so it doesnt linger in React DevTools / heap snapshots.
        setValue('');
        setKey('');
        onSaved();
        onClose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'secrets-backend-locked') {
          setError(
            'Secrets-Backend ist gesperrt. Setze $CLAUDE_OS_SECRETS_KEY bevor du die App startest, oder wechsle via $CLAUDE_OS_SECRETS_BACKEND=keyring auf den OS-Keychain-Backend.',
          );
        } else {
          setError(msg);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, key, value, onClose, onSaved],
  );

  const handleClose = useCallback(() => {
    // Clear value before unmount as defensive measure.
    setValue('');
    setKey('');
    onClose();
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop intentional click-target for click-outside-to-close
    // biome-ignore lint/a11y/useKeyWithClickEvents: ESC handled on inner panel
    <div className="modal-backdrop" onClick={handleClose}>
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') handleClose();
        }}
        role="dialog"
        aria-label="Add Secret"
      >
        <header className="modal-header">
          <h2>Secret hinzufügen / aktualisieren</h2>
          <button type="button" className="modal-close" onClick={handleClose} title="Schliessen">
            ×
          </button>
        </header>

        <p className="modal-warn-banner" data-testid="secret-warn-banner">
          <strong>Sicherheits-Hinweis:</strong> Der Wert wird über Tauri-IPC an den Sidecar
          übertragen und ist während der Eingabe in Browser-DevTools sichtbar. Verwende keine Keys
          die du nicht via Browser-Adressleiste akzeptieren würdest.
        </p>

        {error !== null && <p className="banner banner-error">{error}</p>}

        <form onSubmit={handleSubmit}>
          <label className="modal-form-row">
            <span>Key</span>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="z.B. ANTHROPIC_API_KEY"
              autoComplete="off"
              disabled={submitting}
              data-testid="secret-key-input"
            />
          </label>
          <label className="modal-form-row">
            <span>Value</span>
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="(geheim — wird verschlüsselt gespeichert)"
              autoComplete="new-password"
              spellCheck={false}
              disabled={submitting}
              data-testid="secret-value-input"
            />
          </label>

          <footer className="modal-footer">
            <button type="button" onClick={handleClose} disabled={submitting}>
              Abbrechen
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!canSubmit}
              data-testid="secret-submit"
              title={
                sidecarOk
                  ? 'Secret speichern (uebernimmt sofort wirksam)'
                  : 'Sidecar nicht erreichbar — Read-Only-Modus'
              }
            >
              {submitting ? 'Speichere …' : 'Speichern'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
