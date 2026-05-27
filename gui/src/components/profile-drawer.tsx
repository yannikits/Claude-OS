/**
 * Profile drawer (Phase Web-7-4) — sidebar-header widget showing the
 * authenticated user's email + logout + change-password trigger.
 *
 * Renders only in the HTTP build when cookie-auth is active. Tauri
 * build skips this (no web-login concept). Bearer-token clients see
 * a minimal "Service token" indicator with no email/change-pw action.
 *
 * Pattern: stateless click-to-toggle drawer (no Portal). Outside-click
 * closes via background overlay.
 *
 * @module gui/components/profile-drawer
 */
import { useCallback, useEffect, useState } from 'react';
import { type AuthUser, authMe, isCookieAuthed, logoutCookie } from '../lib/auth-api';
import { ChangePasswordModal } from './change-password-modal';

export interface ProfileDrawerProps {
  /** Called after logoutCookie + transport.clearAuth flip authentication off. */
  readonly onLogout: () => void;
}

export function ProfileDrawer({ onLogout }: ProfileDrawerProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [open, setOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Lade User-Info nur wenn wir cookie-authed sind.
  useEffect(() => {
    if (!isCookieAuthed()) return;
    let cancelled = false;
    authMe()
      .then((me) => {
        if (!cancelled) setUser(me.user);
      })
      .catch(() => {
        // ignore — falls /me failt, bleibt user null (Bearer-Pfad zeigt nichts)
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await logoutCookie();
    } finally {
      setLoggingOut(false);
      setOpen(false);
      onLogout();
    }
  }, [onLogout]);

  // Bearer-only path: show minimal indicator
  if (user === null) {
    if (!isCookieAuthed()) {
      return (
        <div className="profile-drawer profile-drawer--bearer">
          <span className="profile-drawer__label">Service-Token</span>
        </div>
      );
    }
    return (
      <div className="profile-drawer profile-drawer--loading">
        <span className="profile-drawer__label">Lade Profil …</span>
      </div>
    );
  }

  return (
    <>
      <div className="profile-drawer">
        <button
          type="button"
          className="profile-drawer__trigger"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <span className="profile-drawer__email">{user.email}</span>
          <span className="profile-drawer__chevron" aria-hidden="true">
            ▾
          </span>
        </button>
        {open && (
          <>
            <button
              type="button"
              className="profile-drawer__backdrop"
              onClick={() => setOpen(false)}
              aria-label="Menü schließen"
              tabIndex={-1}
            />
            <div className="profile-drawer__menu" role="menu">
              <div className="profile-drawer__meta">
                <span className="profile-drawer__tenant">Tenant: {user.tenantId}</span>
              </div>
              {statusMessage !== null && (
                <div className="profile-drawer__status">{statusMessage}</div>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setChangePwOpen(true);
                }}
              >
                Passwort ändern
              </button>
              <button type="button" role="menuitem" onClick={handleLogout} disabled={loggingOut}>
                {loggingOut ? 'Abmelden …' : 'Abmelden'}
              </button>
            </div>
          </>
        )}
      </div>
      {changePwOpen && (
        <ChangePasswordModal
          onClose={() => setChangePwOpen(false)}
          onChanged={() => {
            setChangePwOpen(false);
            setStatusMessage('Passwort geändert.');
          }}
        />
      )}
    </>
  );
}
