# Setup-Anleitung — claude-os von 0 zu 100

Diese Anleitung führt dich von **frischer Maschine** zu **claude-os läuft mit deinem Cloud-Mount**. Lesezeit ~10 min, Setup-Zeit ~15-30 min (je nach Cloud-Provider-Sync-Speed und ob du Dev-Tools brauchst).

Drei Zielszenarien werden abgedeckt:

- **A** — Nur die Desktop-App benutzen (häufigster Fall)
- **B** — App + CLI (`claude-os` Command)
- **C** — Entwicklung am Source-Code

Lies erst Szenario A, dann je nach Bedarf B oder C.

---

## Voraussetzungen (alle Szenarien)

| Tool | Pflicht? | Wofür |
|------|----------|-------|
| Windows 10/11 (Build 19045+) oder macOS 12+ oder Ubuntu 22.04+ | ja | OS-Support |
| **Git** im PATH (`git --version` muss laufen) | ja | Vault-Sync + Repo-Detection |
| Cloud-Mount-Client (OneDrive / Drive / Dropbox / Nextcloud / rclone) | ja | Cross-Machine-State |
| Anthropic-Account + `claude` CLI | ja | LLM-Backend |
| Node.js ≥ 20 | ja für B/C, optional für A | CLI + Build |
| Rust via [rustup](https://rustup.rs/) + Build-Tools | nur C | Tauri-Shell-Build |
| VS Build Tools (Windows) / Xcode CLI (macOS) / libwebkit2gtk (Linux) | nur C | Native compile |

`git` und `claude` müssen im **System-PATH** liegen — `claude-os doctor` prüft das später.

---

## Szenario A: Desktop-App benutzen

Das ist der häufigste Pfad. Du installierst den MSI/DMG/AppImage, setzt einen Mount-Pfad, App rennt.

### Schritt 1 — Cloud-Mount aufsetzen

Wähle einen Provider und folge der [`docs/cloud-providers.md`](./cloud-providers.md). Schnellste Variante (OneDrive auf Windows, schon installiert):

```powershell
$root = "$env:USERPROFILE\OneDrive\claude-os"
New-Item -ItemType Directory -Force $root | Out-Null
New-Item -ItemType File -Force "$root\.claude-os-root" | Out-Null
New-Item -ItemType Directory -Force "$root\vault","$root\config","$root\inbox","$root\outbox" | Out-Null
```

Warte bis OneDrive die Folders mit dem grünen Häkchen markiert.

### Schritt 2 — `$CLAUDE_OS_ROOT` permanent setzen

claude-os findet seinen Root entweder per `$CLAUDE_OS_ROOT` env-var ODER per Marker-Suche im Filesystem. Env-var ist deterministischer:

```powershell
[Environment]::SetEnvironmentVariable("CLAUDE_OS_ROOT", "$env:USERPROFILE\OneDrive\claude-os", "User")
```

Neuer Shell öffnen, dann `echo $env:CLAUDE_OS_ROOT` testen.

### Schritt 3 — MSI/DMG/AppImage downloaden + installieren

Hol das passende Installer-File von [Releases](https://github.com/yannikits/Claude-portable/releases) (immer das neueste, aktuell `v1.0.0`):

- **Windows**: `claude-os_1.0.0_x64_en-US.msi` → Doppelklick → UAC bestätigen → installiert nach `C:\Program Files\claude-os\`
- **macOS**: `claude-os_1.0.0_universal.dmg` → mounten → claude-os.app nach `/Applications/` ziehen → siehe [`macos-gatekeeper.md`](./macos-gatekeeper.md) für den ersten Open-Dialog
- **Linux**: `claude-os_1.0.0_amd64.AppImage` → `chmod +x` → doppelklick oder `./claude-os_1.0.0_amd64.AppImage`

### Schritt 4 — App starten

**Windows**: Startmenü → "claude-os" tippen → Enter. Oder direkt:

```powershell
& "C:\Program Files\claude-os\claude-os-shell.exe"
```

**macOS**: Spotlight → "claude-os" oder Launchpad.
**Linux**: Doppelklick auf AppImage.

**Was du erwartest**:

1. Loading-Spinner für 1-2 Sekunden ("claude-os startet …")
2. Dashboard mit 4 Cards:
   - **SIDECAR** — "OK — ts …" (RPC-Handshake erfolgreich)
   - **CATALOG** — "0 Einträge" (oder mehr wenn schon installiert)
   - **VAULT** — "abort · busy=no"
   - **AGENT RUNS** — "0 aufgezeichnet"
3. Sidebar links mit 7 Views (Dashboard, Chat, Catalog, Vault, Agent Runs, Secrets, Settings)

### Schritt 5 — Drag-Drop testen

Ziehe eine beliebige Datei in das App-Fenster. Du solltest sehen:

- Banner oben: "1 Datei(en) in den Inbox kopiert." (verschwindet nach 5s)
- Banner darunter: "inbox: add …" mit dem Pfad zum neuen File

Die Datei landet unter `$CLAUDE_OS_ROOT\inbox\<ISO-timestamp>-<original-name>`.

### Wenn alles oben funktioniert — fertig

Die App läuft. Cross-Machine-Sync passiert automatisch via dein Cloud-Provider (sobald Vault/Configs auf der zweiten Maschine angekommen sind, lesen die Apps dort denselben State).

---

## Szenario B: zusätzlich die CLI (`claude-os` Command)

Die CLI macht dasselbe wie die GUI, plus einige Subcommands die noch nicht in der GUI sind (`update`, `secrets set/get`, `auth login`, `catalog install`).

### Schritt 1 — Node.js installieren (falls fehlt)

```powershell
winget install OpenJS.NodeJS.LTS
```

Test: `node --version` zeigt v22.x.x oder neuer.

### Schritt 2 — Repo clonen + bauen

```powershell
cd $env:USERPROFILE\Documents\GitHub
git clone https://github.com/yannikits/Claude-portable.git claude-os
cd claude-os
npm install
npm run build
npm link
```

`npm link` registriert global einen `claude-os`-Command der auf deinen lokalen Build zeigt.

### Schritt 3 — Doctor-Check

```powershell
claude-os doctor
```

Erwartung: `Summary: 5 ok, 0 warn, 0 fail` (oder 1 warn falls `claude.exe` nicht im PATH).

### Schritt 4 — Git-Metadaten migrieren (einmalig pro Maschine, wichtig)

Wenn dein Vault später `vault/.git/` bekommt (von `vault snapshot`), darf der NICHT im Cloud-Mount liegen — sonst Repo-Korruption. Vorbereitend einmal:

```powershell
claude-os doctor --migrate-git-metadata
```

Das verschiebt `vault/.git/` nach `%APPDATA%\claude-os\git-metadata\vault.git\`. Idempotent — zweiter Aufruf ist no-op.

### Schritt 5 — Auth + Secrets

Anthropic-Login (verwendet das offizielle `claude auth login`):

```powershell
claude auth login
claude-os auth status
```

Optional Secrets (API-Keys etc):

```powershell
claude-os secrets set OPENAI_API_KEY
claude-os secrets list
```

Secrets landen in der OS-Keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service) oder fallback in AES-256-GCM-verschlüsseltem File unter `%APPDATA%\claude-os\data\secrets.enc`.

### CLI-Übersicht

Die volle Liste findest du in [`README.md`](../README.md). Häufige Commands:

```powershell
claude-os doctor
claude-os doctor --json
claude-os doctor --migrate-git-metadata

claude-os ai --help
claude-os ai chat

claude-os vault status
claude-os vault snapshot
claude-os vault conflict-mode prefer-remote
claude-os vault schedule --enable --idle-seconds 60

claude-os catalog list
claude-os catalog install github:owner/repo
claude-os catalog lock
claude-os catalog sync

claude-os agent list
claude-os agent list --project myproj --limit 50
claude-os agent show <runId>

claude-os auth status
claude-os auth profile create work
claude-os auth profile use work

claude-os secrets set KEY
claude-os secrets get KEY
claude-os secrets list

claude-os update --env
claude-os update --skills
claude-os update --all
claude-os update --rollback
```

Globale Flags: `--root <path>` (override `$CLAUDE_OS_ROOT`), `--json`, `-v/--verbose`.

---

## Szenario C: Entwicklung am Source-Code

Wenn du das Tauri-Frontend oder den Rust-Shell editieren willst.

### Schritt 1 — Rust-Toolchain

```powershell
winget install --id Rustlang.Rustup
rustup default stable
rustc --version
```

### Schritt 2 — Build-Tools (Plattform-spezifisch)

**Windows**: Visual Studio 2022 Build Tools mit "Desktop development with C++" Workload. Download von Microsoft, ~6 GB.

**macOS**: `xcode-select --install` (~10 min).

**Linux** (Ubuntu/Debian):
```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libssl-dev \
  librsvg2-dev \
  libayatana-appindicator3-dev \
  xdotool
```

### Schritt 3 — Sidecar-Binary einmal bauen

```powershell
cd $env:USERPROFILE\Documents\GitHub\claude-os
npm install
npm run build
npm run sidecar:build
```

Dauert ~3-5 min auf erstem Run (pkg lädt Node-V8 für deine Plattform).

### Schritt 4 — gui-deps + Tauri dev

```powershell
cd gui
npm install
npm run tauri:dev
```

`tauri:dev` öffnet die App im dev-mode:
- Vite-Hot-Reload für `gui/src/**/*.tsx` (Änderungen sichtbar in <1 s)
- Cargo rebuild bei `gui/src-tauri/src/**/*.rs` Änderungen (~30 s pro Iteration)
- WebView-DevTools per `F12`

### Schritt 5 — Tests laufen lassen

```powershell
cd ..
npm test
npm run ci
RUN_SLOW_TESTS=1 npx vitest run tests/sidecar

cd gui\src-tauri
cargo check
cargo test
cargo clippy -- -D warnings
```

### Schritt 6 — Vollständiges Bundle bauen

```powershell
cd $env:USERPROFILE\Documents\GitHub\claude-os
npm run sidecar:build
cd gui
npm run tauri:build
```

Output unter `gui/src-tauri/target/release/bundle/`.

---

## Cross-Machine-Setup (zweite Maschine)

Wenn du claude-os auf einer zweiten Maschine einrichtest:

1. **Cloud-Mount-Client** installieren und auf den gleichen Mount-Pfad zeigen wie auf der ersten Maschine. Auf grünes Sync-Häkchen warten.
2. `$CLAUDE_OS_ROOT` setzen (gleicher Path-Style wie Schritt 2 in Szenario A).
3. MSI/DMG/AppImage installieren (Szenario A).
4. (Optional) CLI bauen (Szenario B).
5. **WICHTIG**: `claude-os doctor --migrate-git-metadata` einmal auf der zweiten Maschine laufen lassen. Das setzt die externe Git-Metadata-Direction auf, sodass `vault/.git/` nicht über den Cloud-Mount kollidiert.
6. App starten — Vault/Configs/Catalog kommen automatisch vom Cloud-Sync.

---

## Troubleshooting

### `Could not resolve $CLAUDE_OS_ROOT` beim Doctor

Env-var nicht gesetzt oder Marker-File fehlt.

Fix:
```powershell
[Environment]::SetEnvironmentVariable("CLAUDE_OS_ROOT", "C:\path\to\mount", "User")
New-Item -ItemType File -Force "C:\path\to\mount\.claude-os-root"
```

### `git config core.longpaths` Warning auf Windows

Vault hat tief verschachtelte Pfade die >260 Zeichen werden.

Fix:
```powershell
git config --global core.longpaths true
```

Vom Doctor automatisch geprüft.

### `claude.exe not found in bin/`

Du hast die Anthropic CLI nicht im `$CLAUDE_OS_ROOT/bin/` oder `$PATH`.

Fix:
```powershell
where.exe claude
New-Item -ItemType SymbolicLink -Path "$env:CLAUDE_OS_ROOT\bin\claude.exe" -Target "C:\path\to\claude.exe"
```

### OneDrive zeigt `EBUSY` beim ersten Vault-Read

OneDrive "Files On-Demand" hat das File nur als Stub. Erster Read materialisiert es, dauert.

Fix: Rechtsklick auf `claude-os/`-Folder → "Always keep on this device".

### App startet, alle 4 Cards "RPC-Fehler: sidecar not available"

Sidecar konnte nicht spawnen. Häufigste Ursache: Antivirus blockt `claude-os-sidecar.exe`.

Fix:
- Windows Defender → Ausnahme für `C:\Program Files\claude-os\`
- Re-launch der App

### `npm run tauri:dev` failed mit `cargo: command not found`

Rust-Toolchain nicht im aktuellen Shell.

Fix:
```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
[Environment]::SetEnvironmentVariable("PATH", "$env:USERPROFILE\.cargo\bin;" + [Environment]::GetEnvironmentVariable("PATH","User"), "User")
```

### `npm run tauri:build` MSI failed mit "WiX missing"

Tauri bundlet MSIs mit WiX Toolset (~7 MB). Wird auto-downloaded beim ersten Bundle-Run; manchmal hängt das.

Fix:
```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\tauri\WixTools314"
npm run tauri:build
```

---

## Weitere Docs

- [`README.md`](../README.md) — Projekt-Übersicht + CLI-Tabelle + Tauri-Topology-Diagram
- [`docs/cloud-providers.md`](./cloud-providers.md) — Per-Provider-Setup mit Stolpersteinen
- [`docs/migration-from-portable.md`](./migration-from-portable.md) — Von claude-portable v0.x (USB) zu claude-os v1
- [`docs/macos-gatekeeper.md`](./macos-gatekeeper.md) — Unsigned DMG auf macOS öffnen
- [`gui/README.md`](../gui/README.md) — Tauri-Build-Anweisungen
- [`tasks/todo.md`](../tasks/todo.md) — Phase-Tracker + v1.x Roadmap
- [`docs/architecture/adr/`](./architecture/adr/) — 14 ADRs zu allen Design-Entscheidungen

Bei Bugs oder Fragen: [Issue tracker](https://github.com/yannikits/Claude-portable/issues).
