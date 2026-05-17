# Claude Develop Environment OS

OS-unabhängige Entwicklungs-Umgebung rund um Anthropic Claude. Tauri-GUI + Node-CLI + cloud-mount Vault-Sync.

> **Status:** v1 in Entwicklung. Phase 0–4 abgeschlossen (Bootstrap, Doctor, Logging, Validation, Secrets, claude-bridge, Vault-Sync, Update-Orchestrator-Foundation). Offen: Phase 5 Agent-Runs + Catalog, Phase 6 Tauri-GUI, Phase 7 Cross-Platform + CI. Tracker: [`tasks/todo.md`](tasks/todo.md).
>
> Vorgänger: `claude-portable` (USB-only Variante). Die alten Launch-Scripts liegen in `legacy/` und sind nicht mehr aktiv.

## Was es ist

Eine cross-Machine konsistente Claude-Umgebung mit einer einzigen Quelle: dem Cloud-Mount.

- **Vault, Configs, Skills, Plugin-Manifeste, inbox/outbox-Drops** leben im Cloud-Mount (OneDrive/Dropbox/Drive/rclone). Plain-Text + JSON-Lines. Sicher gegen File-by-File-Sync.
- **Git-Metadaten, SQLite-Indizes, Logs, Secrets** leben **pro Maschine** ausserhalb des Mounts (`%APPDATA%/claude-os/` bzw. `~/.config/claude-os/` + OS-Keychain). Sicher gegen Repo-Korruption und Locking-Probleme.
- **Anthropic `claude` Binary** wird via streaming Node-Bridge gespawnt (kein 120s-Buffer-Cutoff, Heartbeat, SIGINT-Propagation).

Die These: was im Cloud-Mount liegt, muss tolerant gegen "wahllose Reihenfolge von File-Updates" sein. Was das nicht ist, gehört raus. Siehe [ADR-0002](docs/architecture/adr/0002-cloud-mount-data-placement.md).

## Architektur in 60 Sekunden

```
$CLAUDE_OS_ROOT/                    <-- Cloud-Mount (OneDrive/Dropbox/...)
├── .claude-os-root                 Marker-File
├── bin/claude{,.exe}               Anthropic-CLI-Binary (optional, fallback: $PATH)
├── vault/                          Obsidian-Markdown-Vault
│   └── .git                        Gitfile -> per-Machine git-metadata
├── config/                         geteilte Configs
└── inbox/, outbox/                 Drop-Folder

%APPDATA%/claude-os/                <-- pro Maschine
├── git-metadata/vault.git/         echtes Git-Verzeichnis
├── data/
│   ├── vault-config.json           {conflictMode, idleSeconds, scheduleEnabled}
│   ├── vault-sync-state.json       Persistenter Busy-Flag
│   └── secrets.enc                 AES-256-GCM, falls keine OS-Keychain
└── logs/                           pino-Logs

OS-Keychain                         <-- Secrets (Service: claude-os)
                                    Windows Credential Manager / macOS Keychain
                                    / Linux Secret Service
```

## Voraussetzungen

- **Node.js ≥ 20** (ESM-Setup)
- **System-`git`** im PATH
- **Anthropic `claude`-Binary** (irgendwo im PATH oder unter `$CLAUDE_OS_ROOT/bin/claude{,.exe}`)
- **Cloud-Mount** mit Schreibrechten (OneDrive/Dropbox/Drive/rclone/...). Alternative: lokaler Pfad mit Marker-File für Single-Machine-Setup.

Auf Windows zusätzlich empfohlen: `git config --global core.longpaths true` (vom Doctor automatisch geprüft).

## Quickstart

```bat
:: 1. Repo holen + bauen
git clone <repo-url> claude-os
cd claude-os
npm install
npm run build

:: 2. Cloud-Mount markieren (einmalig pro Mount)
type NUL > "C:\Users\%USERNAME%\OneDrive\Claude\.claude-os-root"
set CLAUDE_OS_ROOT=C:\Users\%USERNAME%\OneDrive\Claude

:: 3. Doctor laufen lassen
.\claude-os.cmd doctor

:: 4. Vault-Sync vorbereiten
.\claude-os.cmd vault init-gitignore
.\claude-os.cmd doctor --migrate-git-metadata
```

POSIX äquivalent — `./claude-os` statt `.\claude-os.cmd`, `export CLAUDE_OS_ROOT=...`.

## CLI-Übersicht

| Command | Status | Was es macht |
|---|---|---|
| `claude-os doctor [--json] [--migrate-git-metadata]` | ready | Self-diagnostic; Migrations-Modus verschiebt `vault/.git/` extern |
| `claude-os ai <args...>` | ready | Forward an Anthropic claude-Binary; streaming stdio |
| `claude-os secrets set/get/list/delete <key> [value]` | ready | OS-Keychain (Fallback AES-256-GCM-File) |
| `claude-os vault snapshot [--no-push]` | ready | Stage, commit ISO-Timestamp, push |
| `claude-os vault status` | ready | Config + Busy-Flag + aktive Settings |
| `claude-os vault conflict-mode <mode>` | ready | `abort` \| `prefer-local` \| `prefer-remote` |
| `claude-os vault schedule --enable/--disable [--idle-seconds N]` | ready (Config) | Config-Toggle; Watcher selbst läuft im Phase-6-Sidecar |
| `claude-os vault unlock` | ready | Reset Busy-Flag (Crash-Recovery) |
| `claude-os vault init-gitignore` | ready | Default-Template anwenden |
| `claude-os update [--env\|--skills\|--plugins\|--all\|--rollback [ts]]` | ready (Foundation) | Tiered Auto-Update mit Selective-Merge-Foundation. Full interactive review staged für eine Folge-Iteration — siehe v1-Abweichungen unten. |
| `claude-os catalog ...` | Phase 5 | Plugin/Skill-Marketplace |
| `claude-os agent ...` | Phase 5 | Agent-Run-Browser |
| `claude-os auth ...` | Phase 5 | Anthropic-CLI-Auth-Integration |

Globale Flags: `--root <path>` (statt `$CLAUDE_OS_ROOT`), `--json`, `-v/--verbose`.

## Cross-Machine-Setup (zweite Maschine)

1. Cloud-Sync-Client einrichten und auf den Mount warten (alle Markdowns + Configs sind bereits da).
2. `git clone` des claude-os-Repos lokal, `npm install && npm run build`.
3. `claude-os doctor` zeigt was fehlt. Auf Windows: `core.longpaths true` setzen wenn der Doctor warnt.
4. `claude-os doctor --migrate-git-metadata` initialisiert die externe `.git`-Metadata-Direction.
5. Optional: `claude-os secrets set <key> <value>` für API-Keys, die nicht im Cloud-Mount liegen sollen.

Der Vault-Status auf der zweiten Maschine wird durch den Cloud-Sync-Client gepullt; Git-Operationen laufen lokal gegen die externe Metadata-Direction.

## Konfiguration

### Environment-Variablen

| Var | Wirkung |
|---|---|
| `$CLAUDE_OS_ROOT` | Cloud-Mount-Pfad (sonst: Repo-Detect via Marker-File) |
| `$CLAUDE_OS_DATA_DIR` | Override für `%APPDATA%/claude-os/` (Tests + unusual installs) |
| `$CLAUDE_OS_LOG_LEVEL` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` (Default: `info`) |
| `$CLAUDE_OS_SECRETS_BACKEND` | `keyring` \| `encrypted-file` (Default: Auto-Detect via Probe) |
| `$CLAUDE_OS_SECRETS_KEY` | Master-Key für encrypted-file Backend |
| `$RUN_SLOW_TESTS=1` | Aktiviert den 180s Long-Running-E2E-Test |

### Config-Files (pro Maschine, in `<dataDir>`)

- **`vault-config.json`** — `{conflictMode: "abort"|"prefer-local"|"prefer-remote", idleSeconds: 300, scheduleEnabled: false}`
- **`vault-sync-state.json`** — Persistent Busy-Flag (Crash-Recovery)
- **`secrets.enc`** — AES-256-GCM Fallback wenn OS-Keychain nicht verfügbar

## Architektur-Entscheidungen

Alle wesentlichen Design-Entscheidungen sind in [`docs/architecture/adr/`](docs/architecture/adr/) als ADRs dokumentiert. Hot-Spots:

- [ADR-0001 — Tauri statt Electron für die GUI](docs/architecture/adr/0001-gui-framework-tauri.md)
- [ADR-0002 — Cloud-Mount-Datenplatzierung](docs/architecture/adr/0002-cloud-mount-data-placement.md) (zentral)
- [ADR-0003 — Hybrid-CLI mit claude.exe-Delegation](docs/architecture/adr/0003-hybrid-cli-with-claude-exe-delegation.md)
- [ADR-0004 — Secrets via @napi-rs/keyring](docs/architecture/adr/0004-secrets-via-napi-rs-keyring.md)
- [ADR-0005 — Selective-Merge-Update-Pattern](docs/architecture/adr/0005-selective-merge-update-pattern.md)
- [ADR-0008 — Git-Backend simple-git](docs/architecture/adr/0008-git-backend-simple-git.md)
- [ADR-0013 — Logging mit pino](docs/architecture/adr/0013-logging-pino.md)

## v1-Abweichungen (bekannt + transparent)

- **`update --skills` Selective-Merge-Composition**: Die Bausteine (BackupManager, ZoneClassifier, DiffEngine, ReviewLoop, ResumableChecklist) sind isoliert getestet und einsatzbereit, die End-to-End-CLI-Komposition (upstream-mirror-clone → walk → classify → diff → review-loop → checklist → apply) ist noch nicht voll verdrahtet. `update --skills` bei `aborted-dirty` zeigt einen Hint statt zu starten. Vollständiger Flow ist eine Folge-Iteration.
- **`update --plugins`**: Echte Plugin-Installation braucht den Phase-5-Catalog. Der CLI-Pfad gibt aktuell einen Phase-5-Pointer zurück; die separate Log-Datei-Infrastruktur (Memory-587/593-Mitigation) steht.
- **`update --resume`**: ResumableChecklist-Modul ist fertig + getestet, aber die CLI-Orchestration für Resume hängt am Selective-Merge-Composition-Punkt oben.
- **Interactive Review**: Die `decide`-Callback der ReviewLoop ist injectable; eine echte TTY-UI mit `enquirer` ist Folge-Iteration oder Phase-6-GUI. v1 nutzt `--auto-accept` für clean Diffs.
- **`.skill-lock.json`** statt YAML (ADR-0005 §38 erwähnt YAML; JSON ist robuster, kein Parser nötig).

## Entwicklung

```bat
npm test                          :: 245/245 grün (+1 slow gated)
npm run build                     :: tsc -> dist/
npm run check                     :: biome lint
npm run ci                        :: biome ci + tsc + coverage
$env:RUN_SLOW_TESTS = "1"; npm test :: inkl. 180s Bridge-Regression
```

Test-Tracker: [`tasks/todo.md`](tasks/todo.md), Lessons aus Korrekturen: [`tasks/lessons.md`](tasks/lessons.md).

## Lizenz

MIT (siehe `package.json`).
