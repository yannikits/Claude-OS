# ADR-0001 — GUI-Framework: Tauri 2.x

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Entscheidung getroffen durch:** /grill-me Session + Researcher-Validierung

## Kontext

Claude Develop Environment OS braucht eine Desktop-GUI mit Look-and-Feel ähnlich der Claude Desktop App, lauffähig auf Windows / Linux / macOS, mit Anbindung an:

1. die mitgelieferte `bin/claude.exe` (Anthropic-Binary, bleibt erhalten)
2. die Node + TypeScript Domain-Schicht (Catalog, Vault-Sync, Agent-Runs, Doctor, Update-Orchestrator)
3. native Filesystem-Interaktion (Drag-and-Drop in `inbox/`, File-Watcher auf `outbox/`)

Im ursprünglichen /grill-me wurde Electron gewählt mit Argument: "Rust-Toolchain auf drei Maschinen ist Wartungslast für einen Solo-Entwickler". Der anschließende Researcher-Spike hat dieses Argument widerlegt: Rust ist eine **Build-Zeit-Anforderung des Maintainers**, nicht eine Runtime-Anforderung beim Endnutzer. Die produzierten Tauri-Binaries laufen ohne Rust-Installation.

## Entscheidung

**Tauri 2.x** als GUI-Stack:

- `gui/src-tauri/` — minimaler Rust-Shell (~50 Zeilen `main.rs`, Tauri-Config, Sidecar-Manifest)
- `gui/src/` — Vite + React + TypeScript Frontend (1:1 die Renderer-Komponenten aus dem Architektur-Entwurf)
- Kommunikation Frontend ↔ Domain-Code: Tauri-`invoke` zum Rust-Shell, der via `tauri-plugin-shell` (Sidecar-Pattern) `claude-os <command> --json` aufruft. Domain-Logik bleibt vollständig in Node + TypeScript.

## Konsequenzen

**Positiv**

- Bundle ~5–10 MB pro OS (Referenz: Electron-Apps in vergleichbarer Scope: 80–200 MB)
- RAM-Verbrauch ~50 MB (Electron: ~120 MB)
- Tauri-Sidecar-Pattern passt nativ zum `claude.exe`-Spawn-Modell (stdin/stdout/sockets, gleiche Lifecycle-Semantik)
- Keine `electron-rebuild`-Native-Module-Rebuilds für Secrets-Storage (synergistisch mit ADR-0004)
- Eine einheitliche Sidecar-Konfiguration spawnt sowohl `claude.exe` als auch das `claude-os`-CLI

**Negativ / Aufwand**

- Rust-Toolchain als CI-Build-Anforderung (nur Maintainer, nicht Nutzer)
- macOS-Code-Signing wird für v1 zurückgestellt (Gatekeeper-Workaround dokumentieren)
- Frontend-Hot-Reload braucht eine separate `cargo tauri dev`-Pipeline parallel zu `vite dev`

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|--------|-----------|---------------------|
| **Electron** | Verworfen | Bundle- und RAM-Overhead nicht gerechtfertigt für die GUI-Scope (Listing, Settings, Chat-Wrapper, Drop-Folder); Native-Module-Rebuild-Pain bei jedem Electron-Update |
| **Web-only mit Browser-Tab** | Verworfen | Kein nativer File-Drop, keine Tray-Integration, kein Single-Window-Lifecycle |
| **Neutralino / Wails** | Verworfen | Kleinere Communities, weniger Plugin-Ökosystem, Sidecar-Pattern weniger reif |

## Quellen

- [Tauri vs Electron 2026 Benchmarks (PkgPulse)](https://www.pkgpulse.com/blog/best-desktop-app-frameworks-2026)
- [Tauri 2.x Sidecar Node.js Docs](https://v2.tauri.app/learn/sidecar-nodejs/)
- Referenz-Apps in Production mit Tauri 2.x: Spacedrive, Hoppscotch, AppFlowy

## Notiz

Diese Entscheidung ersetzt die ursprüngliche Grill-Wahl B4 = Electron auf Basis der Researcher-Befunde vom 2026-05-15.
