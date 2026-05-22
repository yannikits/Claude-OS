# ADR-0022 — GUI-Mutation fuer Anthropic-Auth-Login, Profile-Switch, Secrets-Edit

**Status:** Akzeptiert
**Datum:** 2026-05-22
**Bedingt durch:** v1.x.+1 — Folge auf ADR-0021 (PTY-Upgrade), die User-Anforderung
"Settings + Secrets sollten editierbar sein in der GUI, plus Anmeldung
ueber GUI moeglich".

## Kontext

Die v1.0-GA-GUI ist read-only fuer Settings und Secrets — User muss in die
CLI ausweichen fuer `claude-os auth login`, `claude-os auth profile use`,
`claude-os secrets set`. Mit dem PTY-Upgrade ([ADR-0021](0021-pty-upgrade-xterm-node-pty.md))
haben wir die Infrastructure die einen interaktiven Browser-OAuth-Flow
embedded zeigen kann. Settings-Profile-Switch und Secrets-Set sind
beide bereits backend-seitig vollständig implementiert
(`ProfileManager.use()` + `SecretStore.set()`), nur die RPC-Surface
und die GUI-UI fehlten.

Dieser ADR dokumentiert die Architektur-Entscheidungen fuer die drei
Mutations und insbesondere die Security-Trade-Offs der Secret-Eingabe
in einem Browser-Renderer.

## Entscheidung

**Drei neue RPC-Methoden + drei UI-Erweiterungen, alle additive (chat.*
und CLI-Pfade bleiben unangetastet). Login-Flow via embedded xterm-Modal
auf der Settings-Page. Profile-Switch als Dropdown statt Badge-Liste.
Secrets-Set via password-input-Modal mit explizitem
Sicherheits-Warn-Banner.**

### 7 Sub-Entscheidungen

1. **Login-UI: dedicated Modal mit embedded xterm.js Terminal** auf der
   Settings-Page, nicht Reuse der Chat-Tab. Begruendung: Login ist ein
   abgeschlossener Flow mit eigener UX-Erwartung — Modal macht Kontext
   klar, schliesst sich nach erfolgreichem Exit, kein Polluting der
   normalen Chat-Session-Historie.

2. **Login spawned via neuer `auth.login` RPC** (statt `pty.spawn`
   direkt aus dem Renderer aufzurufen). Begruendung: Profile-aware
   `ANTHROPIC_CONFIG_DIR` env-Setup soll im Sidecar leben — kein
   Renderer hat env-Macht. Der RPC ruft intern
   `PtyChatSessions.spawn(['auth', 'login'], {cols, rows, envOverrides})`
   mit `ProfileManager.resolveEnvOverride()`.

3. **`PtyChatSessions.spawn` bekommt optionalen `envOverrides`-Parameter**
   (additiv, default `{}`). Wird nach dem `CLAUDE_OS_SECRETS_KEY`-Strip
   ge-merged. Verwendet von `auth.login`, koennte spaeter auch von
   Catalog-Spawn fuer profile-aware MCP-Server-Subprocesses
   wiederverwendet werden.

4. **`auth.status` RPC** wrapt `checkAuthState()` und macht den
   4-stufigen Resolution-Pfad (CI-env → CLI-subprocess → file → no-creds)
   ueber RPC verfuegbar. Bisher konnte das Frontend nur via
   `settings.read`-shape auf `credentialsFileExists` schauen — das
   verpasst die CLI-und-env-Pfade. `auth.status` ist eine kleine API,
   noch nicht von der GUI verbraucht (Modal-Close triggert nur
   `settings.read`-refetch); steht aber bereit fuer "Dashboard-Auth-
   Status-Card" als Folge-PR.

5. **Profile-Switch via `settings.activateProfile(name)` RPC**, NICHT
   ueber separaten `auth.profile.use` Namespace. Begruendung:
   `settings.read` liefert schon die Profile-Daten ans Frontend — die
   Mutation gehoert in denselben Namespace. KEIN
   `settings.createProfile` / `deleteProfile` in v1.x.+1 — das sind
   irreversible Mutations und bleiben CLI-only (`claude-os auth profile
   create/delete`). GUI exposed nur das Switching zwischen bereits
   existierenden Profilen.

6. **Secrets-Set via `secrets.set(key, value)` RPC** mit:
   - `requireString(key)` (kein empty)
   - `value` MUSS string sein, aber `''` ist akzeptiert (explicit-empty,
     nicht delete — der User koennte ein Secret explizit auf empty
     setzen wollen)
   - `SecretsLockedError` wird als `Error('secrets-backend-locked')`
     re-thrown (typed message, kein leak des master-key-Internals per
     [ADR-0004](0004-secrets-via-napi-rs-keyring.md) §51)
   - Detect updated-vs-new ueber `SecretStore.list()` (keys-only, kein
     Value-Leak)

7. **Secrets-Edit Security-Mitigations** (Renderer-RAM-Risk per
   ADR-0004 §51):
   - **Value-Input ist `<input type="password">`** mit
     `autoComplete="new-password"` (verhindert Browser-Save-Prompt) und
     `spellCheck={false}` (kein Browser-IME-Leak)
   - **Value wird nach erfolgreichem Submit explizit aus React-State
     geclearet** (`setValue('')`), bevor `onClose()` triggert
   - **Prominenter Warn-Banner** im Modal: "Wert geht durch Tauri-IPC
     und ist während der Eingabe in Browser-DevTools sichtbar"
   - **Submit-Button disabled** wenn `!sidecarOk` oder `data.locked`
     oder `key.trim() === ''`
   - **M5 Cross-Process-Lock** (proper-lockfile in
     `EncryptedFileStore.withFileLock`) — bereits in der domain-API
     implementiert (war deferred item M5 im Phase-6-Review), nur in
     diesem PR getestet. CLI + GUI gleichzeitig sets sind safe.
   - **Backend logiert NIEMALS den Value**, auch nicht in Error-Messages.
     `SecretsError`-Klasse-Konstruktor kennt nur key+backend.

## Konsequenzen

### Positiv

- **GUI-only Daily-Use moeglich** — der typische dev-flow (login →
  switch profile → add API-key → use chat) braucht keinen CLI-Wechsel
  mehr.
- **Auth-Login funktioniert ohne CLI-Setup auf der User-Maschine** —
  der embedded `claude auth login` PTY-Spawn ist der gleiche Flow
  wie die CLI, mit gleicher OAuth/Browser-Mechanik.
- **Profile-Switch ist atomar und sichtbar** — Settings-View
  re-fetched sofort, User sieht den neuen Active-Profile-Marker.
- **Secrets-Add funktioniert ohne Terminal** — Power-User bleiben
  bei `claude-os secrets set <key>` (besser fuer scripting), aber
  one-shot setups gehen jetzt UI-only.
- **Coexist-Policy hart eingehalten** — keine CLI-Methode entfernt
  oder modifiziert. Existing Scripts/MCP-Konsumenten unberuehrt.

### Negativ / Akzeptierte Trade-offs

- **Secret-Wert lebt waehrend der Eingabe in Renderer-RAM** — Tauri-
  WebView ist im production-Build ohne DevTools, aber dev/debug-Builds
  exponieren das. Mitigation via Warn-Banner + clear-on-submit.
  Permanent-Loesung (z. B. native input-handler ueber Tauri-Plugin)
  ist v2-Material.
- **Profile-create/delete bleiben CLI-only** — irreversible Actions
  brauchen extra Confirmation-UX die wir noch nicht haben. Codex-Review-
  Anregung: Confirmation-Modal als Folge-PR moeglich.
- **`auth.status` RPC noch nicht UI-konsumiert** — angelegt fuer
  Dashboard-Card / Status-Indicator, der in einer Folge-PR sauber
  designed wird. Aktuell triggert die SettingsPage einfach
  `settings.read`-refetch nach Modal-Close, was die User-relevante
  `credentialsFileExists`-info liefert.
- **xterm.js Bundle-Impact** — bereits in v1.x von ADR-0021 akzeptiert,
  Modal nutzt dieselben Imports, kein zusaetzlicher Bundle-Cost.

### Konstraints fuer Folge-Phasen

- **Profile-create/delete im GUI** brauchen Confirmation-Dialog +
  Cascading-Effects-Anzeige (z. B. "Profile loeschen entfernt auch
  `.credentials.json` darin"). Eigener ADR wenn implementiert.
- **Dashboard-Auth-Status-Card** sollte `auth.status` konsumieren statt
  `settings.read.anthropic.credentialsFileExists` — das deckt CI-env
  und CLI-pfad auch ab.
- **Secrets-Backup/Export-Flow** ist out-of-scope dieser PR. Wenn
  jemand secrets backuppen will: weiter CLI (`claude-os secrets list`
  + `get` einzeln) bis ein dedizierter export-flow designed ist.
- **`secrets.get` via GUI bleibt explizit raus** — Values verlassen
  niemals den Sidecar in die GUI. Wer ein Secret lesen muss, nutzt
  die CLI.
- **Stale-Lock-Detection in proper-lockfile** koennte ein Doctor-Check
  als Follow-up bekommen — wenn das `<secretsPath>.lock` aelter als
  60s ist, ist es vermutlich kaputt und sollte aufgeraeumt werden.

## Alternativen verworfen

**Login-Flow via In-App OAuth-Implementation:** Eigener
OAuth-Client-State-Machine in Tauri/React. Hohes Aufwand-Risiko
(Token-Refresh, Scopes, Callback-Server). Spawnen der existing CLI
ist saubere Wiederverwendung — die Anthropic-CLI ist der canonical
OAuth-Client, wir wollen nicht parallel halten.

**Secrets-Set ohne Renderer-RAM (z. B. via Tauri-Plugin-native-Dialog):**
Tauri hat keinen built-in password-input-Plugin. Custom-Rust-Code mit
nativer-OS-Dialog-Window-API waere portable-pain (jeder OS einzeln).
Acceptable Risiko fuer v1.x mit clear-on-submit + Warn-Banner.

**Profile-Switch ueber `auth.profile.use(name)` separater Namespace:**
Saubere Separation, aber dann braucht das Frontend zwei verschiedene
RPCs fuer related Daten (settings.read fuer list, auth.profile fuer
mutation). Pragmatischer: alles in `settings.*`.

**Secrets-Set mit value-Hashing im Renderer vor Submit:**
SHA256-Hashing waere fuer einige (TLS-Pinning, Bearer-Tokens) korrekt,
fuer andere (API-Keys, Passwords) nicht — der Sidecar/CLI muss den
Cleartext bekommen um zu verschluesseln. Kein einheitliches Pattern.

## Referenzen

- [ADR-0004](0004-secrets-via-napi-rs-keyring.md) — Secrets via @napi-rs/keyring (§51 Value-Logging-Verbot)
- [ADR-0011](0011-anthropic-cli-auth-integration.md) — Anthropic-CLI Auth-Integration
- [ADR-0021](0021-pty-upgrade-xterm-node-pty.md) — Full-TTY Chat-View (PTY-Infrastructure-Vorgaenger)
- `src/sidecar/methods/auth.ts`, `src/sidecar/methods/settings.ts`, `src/sidecar/methods/secrets.ts`
- `src/sidecar/pty-chat-sessions.ts` (envOverrides-Erweiterung)
- `src/domains/secrets/encrypted-file-store.ts:189-201` (M5 Lock-Wrapping)
- `gui/src/components/auth-login-modal.tsx`, `gui/src/components/secret-add-modal.tsx`
- `gui/src/pages/index.tsx` SettingsPage + SecretsPage (Mutation-Wire)
- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)
