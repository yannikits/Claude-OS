# ADR-0011 — Anthropic-CLI Auth-Integration

**Status:** Akzeptiert
**Datum:** 2026-05-15
**Bedingt durch:** ADR-0003 (Hybrid-CLI) + Researcher-Spike auf claude-code Auth-Internals

## Kontext

Per /grill-me-Entscheidung B12=A nutzt claude-os Anthropic-Account-Auth pro Maschine. Die einzige Auth-Quelle ist `bin/claude.exe` (OAuth-Browser-Flow, PKCE, lokaler HTTP-Listener auf Random-Port mit Callback von console.anthropic.com). `domains/auth/anthropic.ts` muss diesen State zuverlässig prüfen können, ohne den Auth-Flow selbst zu reimplementieren.

Researcher-Spike vom 2026-05-15 hat reale Credential-Speicherorte, Status-Check-API und ein Bug-Cluster identifiziert: claude-code Issues [#50743](https://github.com/anthropics/claude-code/issues/50743) (Headless-Refresh-Fail), [#27933](https://github.com/anthropics/claude-code/issues/27933) (Race-Conditions bei parallelen CLI-Prozessen), [#31095](https://github.com/anthropics/claude-code/issues/31095) (8h-Forced-Re-Login trotz Refresh-Token).

## Entscheidung

### 1. Credential-Speicherorte (READ-ONLY für uns)

| Plattform | Pfad / Mechanismus |
|---|---|
| macOS | Keychain Service `Claude Code-credentials`, Key `claudeAiOauth` (JSON-Blob mit `accessToken` / `refreshToken` / `expiresAt` / `scopes`) |
| Linux | `~/.claude/.credentials.json` (plaintext JSON) |
| Windows | `%USERPROFILE%\.claude\.credentials.json` (plaintext JSON; neuere Builds optional Windows Credential Manager für Plugin-Creds) |
| Override | `$ANTHROPIC_CONFIG_DIR` zeigt auf alternativen Config-Root |

`claude-os` **schreibt niemals** in diese Pfade. Anthropic-CLI ist die alleinige Owner.

### 2. State-Check-Strategie

Primär: `claude auth status`-Subprozess-Aufruf, parse JSON `{"loggedIn": bool, "authMethod": str, "apiProvider": str}`.

Fallback (wenn `claude.exe` down / Timeout): direkter File-Read der `.credentials.json` (bzw. macOS-Keychain-Lookup), Decode, Compare `expiresAt > now + 60_000ms`.

Cache: 60s in-memory (gemäß System-Architect-Output: `AuthService.TTL`).

### 3. Token-Refresh-Mutex

Auf Basis der dokumentierten Race-Condition (#27933):

- Auth-Domain hält File-Lock auf `~/.claude-os/data/auth.refresh.lock` während Refresh-Operation (PID + Timestamp)
- Stale-Detection: Lock älter als 60s → wird invalidiert
- Proaktiver Refresh wenn `expiresAt < now + 60_000ms`
- Bei Refresh-Fail: User-Notice + Doctor-Warnung statt silently failing

### 4. Multi-Account via `$ANTHROPIC_CONFIG_DIR`-Profile-Sandboxing

Anthropic-CLI unterstützt offiziell kein Account-Switching, aber `$ANTHROPIC_CONFIG_DIR` ist eine respektierte Override-Env-Var.

- `claude-os auth profile create <name>` legt `~/.claude-os/auth-profiles/<name>/` an
- `claude-os auth profile use <name>` setzt `$ANTHROPIC_CONFIG_DIR=<profile-dir>` für nachfolgende `claude.exe`-Spawns
- `claude-os auth profile list` zeigt alle vorhandenen Profile + aktives
- Statusline (Phase 6) zeigt aktives Profil
- Existing-Sessions werden nicht abgewürgt (Env-Var-Set wirkt nur auf neue Spawns)

### 5. CI / Headless via Env-Vars

`claude.exe` respektiert `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`. Auth-Domain detect-et diese und überspringt File-/Keychain-Read im CI-Modus.

## Konsequenzen

**Positiv**

- Single-Source-of-Truth: `claude.exe` schreibt, claude-os liest — keine Konflikte
- Multi-Profile-Support ohne Anthropic-Maintenance-Wartezeit (Workaround durch uns supported)
- Race-Conditions bei parallelen Sessions adressiert (File-Lock)
- CI-Modus funktioniert ohne `.credentials.json`

**Negativ**

- Anthropic-CLI-Schema kann sich in Future-Versionen ändern → Doctor-Schema-Version-Check Pflicht
- macOS-Keychain-Read braucht `security`-CLI oder native Binding (via `@napi-rs/keyring` aus ADR-0004)
- Multi-Profile bricht, falls Anthropic CLI das Env-Var-Verhalten ändert — Disclaimer in Doku
- Profile-Switching kein True-Multi-Tenant: zwei gleichzeitige Sessions in zwei Profilen sind möglich, aber unsynchronisiert (Doku-Hinweis)

## Constraints

- Auth-Domain importiert KEIN Anthropic-spezifisches SDK — pure CLI-Subprocess + File-Layer
- Refresh-Mutex muss Crash-safe sein (Lock-File mit PID, stale-Detection nach 60s)
- Profile-Switching darf laufende Sessions nicht abwürgen
- Doctor-Check für Schema-Version: parse `.credentials.json`, erwartete Keys vorhanden, sonst Warnung "Anthropic-CLI-Schema möglicherweise geändert — prüfe claude-os-Update"

## Alternativen

| Option | Bewertung | Grund für Ablehnung |
|---|---|---|
| **Anthropic-API direkt** (eigener OAuth-Flow) | Verworfen | Reimplementiert claude.exe's Auth-Code, bricht ADR-0003 (Delegation-Prinzip) |
| **Nur Status-Check, kein Refresh-Management** | Verworfen | Bei Token-Expiry mitten in Session bricht claude.exe ab (#31095), schlechte UX |
| **Patches in claude.exe-Prozess** | Verworfen | Maintenance-Albtraum, gegen Spirit der Hybrid-CLI |
| **Multi-Account ignorieren in v1** | Verworfen | $ANTHROPIC_CONFIG_DIR ist trivialer Workaround, User-Memory-S246 fordert explizit Multi-Profile |

## Quellen

- [Claude Code Authentication Docs](https://code.claude.com/docs/en/authentication)
- [claude-code #50743 — headless no-refresh](https://github.com/anthropics/claude-code/issues/50743)
- [claude-code #27933 — race condition](https://github.com/anthropics/claude-code/issues/27933)
- [claude-code #31095 — 8h re-login](https://github.com/anthropics/claude-code/issues/31095)
- [OAuth recovery gist (shubcodes)](https://gist.github.com/shubcodes/3c9c7ff813715aa47018bf22e7cf8cb5)
- Memory-IDs S246, S247 — User-Anforderung Multi-Profile-Auth

## Notiz

Phase 5 in `tasks/todo.md` implementiert die `domains/auth/anthropic.ts`-Domain mit allen oben definierten Constraints und CLI-Befehlen.
