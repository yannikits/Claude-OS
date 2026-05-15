# Roadmap nach v1

Übersicht der Features, die bewusst auf spätere Releases verschoben wurden, mit Quellen und Begründungen. Stand: 2026-05-15.

## v1.1 — MCP-Bundle pro Domain

Siehe [ADR-0007](architecture/adr/0007-mcp-bundle-per-domain-deferred.md). Macht `claude-os` zur MCP-Surface für andere AI-Tools (Codex, Gemini-CLI, Cursor). Voraussetzung: transport-agnostische Domain-Interfaces in v1.

**Ticket-Liste** in ADR-0007 dokumentiert.

## v1.2 — Rust-Crate für Vault-Sync-Hot-Path

Inspiriert von Spacedrives `spacedrive-core`-Architektur (pure Rust crate, von Tauri-App + CLI + Bot direkt gelinkt): `vault-sync`-git-Operationen via `git2-rs` direkt im Rust-Shell, eliminiert IPC-Overhead für Hot-Path-Calls (Snapshot, Status). v1 behält JS-Implementation (`simple-git`).

**Migration-Voraussetzung**: domain-interfaces in `src/domains/vault-sync/` müssen so designed sein, dass eine Rust-Implementation drop-in austauschbar ist (gleiche TS-Interface auf Tauri-Command-Ebene exposed).

## v1.x — Multi-Runtime-Skill-Symlinks

Pattern aus claudesidian: `.agents/skills/<name>/SKILL.md` canonical, Symlinks zu `.claude/skills/`, `.pi/skills/`, `.opencode/skills/` etc. Macht claude-os-Skills sofort in mehreren AI-CLIs verfügbar. v1 fokussiert ausschließlich Claude Code.

## v1.x — Mobile Access via Tailscale + Termius

Pattern aus claudesidian-Doku: kleiner VPS / Mini-PC mit Tailscale-VPN, Vault als Git-Clone, Termius-SSH-Client auf Mobile. v1 ist Desktop-only.

## v1.x — macOS-Code-Signing

Apple-Developer-Cert + Notarization. v1 liefert macOS-DMG unsigniert mit Gatekeeper-Workaround in der Doku. Cost/Benefit-Analyse vor v1.x-Aufnahme.

## v1.x — iCloud Drive als Cloud-Provider

OneDrive ist v1-Default, rclone/Drive/Dropbox sind dokumentiert. iCloud Drive hat eigene Quirks (Sync-Latency, fseventsd-Verhalten), die separate Tests erfordern.

## v2 — Multi-User-Betrieb

Mehrere Anthropic-Accounts pro Installation. Voraussetzung: erst v1-Setup über Monate validieren, dann Account-Switch-UI + Per-User-Secrets-Store designen.

## v2 — Tiefe OS-Integration

Autostart-Services (Windows-Dienst, systemd-User-Service, launchd-Agent), Tray-Icon-Verhalten, OS-Treiber. v1 bleibt bewusst opt-in-Run.

## v2 — Konfliktlösungs-UI

v1 löst Vault-Konflikte als Hard-Fail mit Doctor-Hinweis (siehe ADR-0002, Phase 2). Eine richtige Konfliktlösungs-UI (3-Pane-Diff, Auto-Merge-Vorschläge) ist v2-Material.
