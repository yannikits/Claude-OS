# ADR-0004 — Secrets via `@napi-rs/keyring`, nicht `keytar`

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Entscheidung getroffen durch:** /grill-me Session + Researcher-Validierung

## Kontext

Drittanbieter-Secrets (Git-PAT für Vault-Push und Env-Repo-Pull, GitHub-PAT, ggf. OpenAI/Gemini-Keys für Three-Brain-Router, ggf. Webhook-Tokens) müssen sicher gespeichert werden — niemals im Cloud-Mount (siehe ADR-0002), niemals als Plain-Text-Datei im Home-Verzeichnis.

Ursprünglich (Grill B13 = A + B Fallback) sollte `node-keytar` als plattform-übergreifender Wrapper über die OS-Keychains genutzt werden.

Der Researcher-Spike hat festgestellt: `keytar` ist seit der Atom-Archivierung **deprecated und unmaintained**. Die De-facto-Migration in der Node-Community läuft auf `@napi-rs/keyring`.

## Entscheidung

**Primär:** `@napi-rs/keyring` als Secret-Store-Adapter.

- Rust-Wrapper über `keyring-rs` mit prebuilt-Binaries pro Node-ABI
- Keine eigene Build-Toolchain auf Nutzer-Maschinen nötig
- API-kompatibel zu `keytar` (`getPassword`, `setPassword`, `deletePassword`, `findCredentials`)
- Plattform-Backends: Windows Credential Manager / macOS Keychain / Linux Secret Service (libsecret/D-Bus)

**Fallback** für headless Linux ohne D-Bus / ohne aktiven Secret-Service-Daemon:

- Encrypted File unter `~/.claude-os/secrets.enc`
- AES-256-GCM via `node:crypto`
- Master-Key aus `claude-os secrets unlock` (interaktive Passphrase) oder `CLAUDE_OS_SECRETS_KEY` Env-Var
- `claude-os doctor` meldet, wenn der Fallback genutzt wird

## Konsequenzen

**Positiv**

- Keine `node-gyp`-Native-Module-Rebuilds bei Electron- oder Tauri-Updates
- Keine `libsecret`-Build-Dependencies (war bei `keytar` auf Linux-Build-Maschinen lästig)
- Plattform-Konsistenz: identische API auf Win/macOS/Linux
- Bei Tauri-Frontend bleibt der Secrets-Zugriff im Node-Sidecar, nicht im Rust-Shell — saubere Trennung

**Negativ / Aufwand**

- Encrypted-File-Fallback braucht eigene Key-Derivation und sichere Speicher-Logik (kein "Master-Pass im Klartext-Cache")
- Auf headless Linux ist die UX schlechter (Passphrase-Eingabe nötig)
- Master-Key-Verlust = Secrets verloren (per Design; keine Recovery)

## Implementierungs-Constraints (`secrets`-Modul)

- Interface `SecretStore` aus dem Architektur-Entwurf bleibt unverändert
- Factory `createSecretStore(cfg)` wählt zwischen `KeyringStore` und `EncryptedFileStore` basierend auf Capability-Detection beim Boot
- Capability-Detection ruft einen No-Op-`get` auf einem Test-Key auf; bei `D-Bus not available`-Fehler wechselt sie auf Fallback
- Secrets-Werte werden niemals geloggt, auch nicht bei `--verbose`
- Service-Name standardisiert auf `claude-os` (für Keychain-Eintrag-Sichtbarkeit)

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **`keytar`** (urspr. Grill-Wahl) | Verworfen | Deprecated, unmaintained, native-Module-Build-Pain bei jedem Electron/Tauri-Update |
| **`.env`-Datei plain text** | Verworfen | Cleartext auf Disk inakzeptabel für API-Keys |
| **HashiCorp Vault / 1Password CLI / Bitwarden** | Verworfen | Externe Services erhöhen Setup-Komplexität für Solo-Dev unverhältnismäßig; Offline-Anforderung wird verletzt |

## Quellen

- [`@napi-rs/keyring` on GitHub](https://github.com/Brooooooklyn/keyring-node)
- [Azure SDK Migration keytar → @napi-rs/keyring (#29288)](https://github.com/Azure/azure-sdk-for-js/issues/29288)
- [node-keytar #292 — headless Linux fails](https://github.com/atom/node-keytar/issues/292)
- [gemini-cli #21622 — keytar hängt auf Linux](https://github.com/google-gemini/gemini-cli/issues/21622)

## Notiz

Diese Entscheidung ersetzt die ursprüngliche Grill-Wahl B13 (`keytar` primär) auf Basis der Researcher-Befunde vom 2026-05-15.
