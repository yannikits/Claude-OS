# Migration von claude-portable zu claude-os

Wenn du auf der USB-basierten `claude-portable` v0.x warst und auf `claude-os` v1 umziehst.

## Was sich grundsätzlich ändert

| Bereich | claude-portable v0.x | claude-os v1 |
|---|---|---|
| Daten-Layout | alles auf USB, inkl. `vault/.git/`, SQLite | Cloud-Mount für plain-text + JSON-Lines; per-Maschine-Daten unter `%APPDATA%/claude-os/` |
| Launcher | `start.bat` / `setup.bat` | `claude-os` Node-CLI (`bin/claude-os`) + Tauri-GUI |
| Sync | manuell mit `sync-from-usb.bat` / `sync-to-usb.bat` | Cloud-Mount-Auto-Sync (OneDrive/Drive/Dropbox/rclone/...) + `claude-os vault snapshot` |
| Catalog | inline-Folder, manuell verwaltet | `config/catalog.json` + lock-file, `claude-os catalog *` Commands |
| Auth | Anthropic-Login pro Maschine | Auto-Pickup von `~/.anthropic/.credentials.json` über `claude-os auth status` |
| Secrets | Klartext in `.env` | OS-Keychain ODER `AES-256-GCM EncryptedFileStore` Fallback |

Die alten `start.bat`/`setup.bat`/`sync-from-usb.bat` Launcher liegen in `legacy/` und sind nicht mehr aktiv. Cloud-Provider-Setup steht in [docs/cloud-providers.md](./cloud-providers.md).

## Migration in 7 Schritten

### 1. Bevor du anfängst: USB-Backup

USB ein letztes Mal komplett zippen — falls etwas schiefgeht.

```powershell
Compress-Archive -Path E:\claude-portable\* -DestinationPath ~\claude-portable-backup.zip
```

### 2. Cloud-Mount aufsetzen

Wähle deinen Provider und folge [docs/cloud-providers.md](./cloud-providers.md). Default: OneDrive.

```text
$CLAUDE_OS_ROOT = C:\Users\<user>\OneDrive\claude-os
```

Folder anlegen, warten bis Sync grünes Häkchen zeigt.

### 3. Vault verschieben

```powershell
robocopy E:\claude-portable\vault $env:CLAUDE_OS_ROOT\vault /E /COPYALL
```

`/COPYALL` kopiert Permissions + Timestamps mit. Datei-Count danach sanity-checken (`Get-ChildItem -Recurse | Measure-Object`).

### 4. Configs, Skills, Plugin-Manifeste verschieben

```powershell
robocopy E:\claude-portable\config $env:CLAUDE_OS_ROOT\config /E
```

`vault/.git/` und `config/cache/`, `config/downloads/` NICHT mitnehmen — die werden in Schritt 6 als per-Machine-Daten neu aufgesetzt.

### 5. claude-os installieren + Marker setzen

```powershell
git clone https://github.com/iteenschmiede/claude-os.git
cd claude-os
npm install
npm run build
npm link

claude-os doctor --init-marker
```

`doctor` schreibt `.claude-os-root` und resolved deinen Root. Output sollte `5 ok / 0 warn / 0 fail` zeigen — wenn nicht, den Hinweisen folgen.

### 6. Vault-Git-Metadaten verschieben (kritisch)

claude-portable hat `vault/.git/` direkt im USB-Mount gehabt. Auf Cloud-Mount ist das gefährlich (siehe [ADR-0002 §4](architecture/adr/0002-cloud-mount-data-placement.md) — Repo-Korruption durch File-by-File-Sync). Wir migrieren das per-Machine:

```powershell
claude-os doctor --migrate-git-metadata
```

Dieser Standalone-Befehl:
- Verschiebt `vault/.git/` nach `%APPDATA%\claude-os\git-metadata\vault.git\`
- Schreibt ein Gitfile (`gitdir: ...`) in `vault/.git`
- Ist idempotent — zweiter Aufruf ist no-op

### 7. Auth + Secrets neu aufsetzen

Anthropic-Login (wenn nicht schon vorhanden):

```powershell
claude auth login
claude-os auth status
```

Secrets von claude-portable v0.x `.env` in Keychain überführen:

```powershell
claude-os secrets set OPENAI_API_KEY
claude-os secrets set GITHUB_TOKEN
claude-os secrets list
```

Die alten `.env` Files können dann gelöscht werden.

## Verifikation: alles okay?

```powershell
claude-os doctor --json
claude-os vault status
claude-os catalog list
claude-os agent list
```

Wenn alle 4 Commands ohne Errors laufen, ist die Migration komplett.

## Rollback

Solange die alte USB-Kopie + das Backup-Zip noch da sind, ist Rollback trivial:

```powershell
Remove-Item -Recurse $env:CLAUDE_OS_ROOT\vault, $env:CLAUDE_OS_ROOT\config
npm unlink -g claude-os
```

Die per-Maschine-Daten (`%APPDATA%\claude-os\`) können stehenbleiben — sie blockieren nichts wenn der Cloud-Mount nicht mehr existiert (`doctor` schlägt dann mit clear-message fehl).

## Bekannte Stolpersteine

- **Vault-Snapshots reverten alte Markdown-Edits**: Der Snapshot-Scheduler (siehe Phase 2d) committet nach 60s Idle in den Vault. Wenn du auf zwei Maschinen parallel arbeitest, kann der Cloud-Sync deine Edits in eine konfligierende Reihenfolge bringen. Lösung: `claude-os vault conflict-mode prefer-remote` für die "leichteren" Maschinen.
- **Long-Path-Errors auf Windows**: `git config --global core.longpaths true` — wird vom Doctor automatisch geprüft und vorgeschlagen.
- **OneDrive Files-on-Demand**: Erste Reads sind langsam (Materialisierung). `claude-os/` Folder auf "Always keep on this device" stellen.

Bei sonstigen Problemen → [Issue tracker](https://github.com/iteenschmiede/claude-os/issues).
