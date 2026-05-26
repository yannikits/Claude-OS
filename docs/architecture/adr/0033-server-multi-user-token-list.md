# ADR-0033 — Server Multi-User: env-driven Token-Liste (Phase Web-5 Stage 1)

**Status:** Accepted (Stage 1: token-list); Stage 2 (Login-UI + Registration) bleibt offen
**Datum:** 2026-05-26
**Verwandte ADRs:** ADR-0032 (Server-Deployment Headless HTTP), ADR-0027 (MSP-Bridge Permission-Model), ADR-0031 (Vault Multi-Workspace)

## Entscheidung

Multi-User-Support für die Server-Variante kommt in **zwei Stufen**:

### Stage 1 (dieses ADR — shipped)

- `CLAUDE_OS_AUTH_TOKEN` darf eine **kommagetrennte Liste** sein
- Jedes Token wird beim Auth-Hook gegen alle Listen-Einträge in **konstant-zeitlicher** Comparison-Schleife geprüft
- Token-SHA-256-Präfix (12 Hex) wird als **deterministische Tenant-ID** in `req.tenant` gesetzt — keine DB, keine Registrierung, kein User-Model
- `tenant`-Domain bekommt erstmals echten Server-Kontext zum Mitspielen
- Backwards-compat: ein einzelnes Token funktioniert unverändert

### Stage 2 (nicht in diesem ADR)

- Login-Page bekommt Email/Passwort-Flow (oder OAuth-Provider)
- User-Tabelle in SQLite mit `id`, `email`, `passwordHash`, `tenantId`
- Token-Rotation per User
- Pro-User-Workspace-Resolver in `vault-resolver.ts`

Stage 2 ist ein eigenes ADR mit eigenem Implementierungsplan.

## Begründung

### Warum Stage 1 jetzt?

Yannik fragt nach Multi-User-Support, hat aber ein Solo-Homelab. **Echter Multi-User** mit Registrierungs-Flow, Email-Verification, Password-Reset, etc. ist 5+ Tage Implementierungs-Arbeit für einen Use-Case der noch nicht existiert (er ist der einzige Nutzer). YAGNI.

**Aber**: ein Token-Liste bietet **80% des Wertes** für 5% der Komplexität:

1. Yannik kann pro Geräteklasse ein eigenes Token vergeben (Desktop / Mobile / VPN-Gast)
2. Token-Revocation = Token aus `.env` löschen + `docker compose up -d`
3. Jedes Token bekommt eine stabile Tenant-ID → `tenant`-Domain kann Daten isolieren (z.B. pro-Tenant `inbox/` oder `notes/` Subfolders)
4. Familie/Team-Sharing wird trivial (jedem ein eigenes Token)

### Warum Token-Hash als Tenant-ID?

- Deterministisch: gleiches Token → gleiche Tenant-ID, auch nach Container-Restart
- Kollisionsresistent: 12-Hex-Präfix von SHA-256 = 2^48 Raum, mehr als genug für Homelab-Skala
- Keine Datenbank nötig — Token ist die ID
- Token kann jederzeit rotieren → neue Tenant-ID → neue Workspace-Bubble (gut für Privacy: alte Sessions gehen verloren wenn Token rotiert)

### Warum konstant-zeitliche Schleife?

Naive `tokens.includes(presented)` würde Timing-Leak haben: ein passendes Token früher in der Liste antwortet schneller. Wir loopen über alle Einträge und akkumulieren via `timingSafeEqual`, returnen erst am Ende.

## Konsequenzen

### Positiv

- **Pragmatischer Multi-User**: Token-Liste in `.env` ist eine Zeilen-Änderung
- **Backwards-compat**: single-Token-Setup funktioniert unverändert
- **Tenant-Foundation**: `req.tenant` ist jetzt überall verfügbar — `tenant`-Domain kann das nutzen ohne weiteres ADR
- **Audit-Trail**: jeder Request loggt Tenant-ID → wer hat was getan ist nachvollziehbar
- **Keine DB-Migration**: Token-Liste ist Konfiguration, keine State-Migration

### Negativ

- **Kein Self-Service**: Token-Vergabe erfordert Server-Admin-Zugriff (kein User-Registration)
- **Token-Sharing**: zwei Personen mit demselben Token sehen denselben Tenant — wenn das ungewollt ist, hat man ein Audit-Problem
- **Keine Quota / Rate-Limits per Tenant** (Stage 2)

### Neutral

- **`req.tenant` ist Web-Server-only**: in Tauri-Mode gibt's keinen Multi-User (OS-User = Tenant). Domain-Code muss damit umgehen: wenn `req.tenant` undefined, fallback auf Default-Tenant `personal`.

## Implementation

### Backend

`src/server/auth.ts`:
```typescript
// parseTokens() splits CSV, trims, drops empties
// makeAuthHook(tokens: string[]) loops all in constant time
// hashTokenToTenantId(token) → first 12 hex of sha256
```

`src/server/types.ts`: `authToken` field bleibt `string` für Backwards-Compat; CLI/entrypoint splittet auf CSV.

`src/cli/commands/serve.ts`: token-CSV → `string[]` aufteilen, an `startServer` weitergeben.

### Env-Format

```bash
# Single token (unverändert):
CLAUDE_OS_AUTH_TOKEN=abc123...

# Multi-Token:
CLAUDE_OS_AUTH_TOKEN=alice_token,bob_token,carol_token
```

Tenant-IDs werden automatisch aus den Tokens abgeleitet — siehe `docs/server-deployment.md` für eine Schritt-für-Schritt-Anleitung.

### Out-of-Scope für Stage 1

- Token-Naming (welcher Token gehört zu welchem User): bleibt Yannik's Mental Model. Stage 2 kann das in eine User-Tabelle materialisieren.
- Per-Tenant-Workspace-Isolation: `tenant`-Domain ist die richtige Stelle, aber das Wiring von Server-Methoden zu Tenant-Context ist eigene Phase Web-5b.

## Akzeptanzkriterien

1. `CLAUDE_OS_AUTH_TOKEN=a,b,c` startet den Server ohne Fehler
2. Drei verschiedene Browser-Sessions mit Token `a`/`b`/`c` können sich alle einloggen
3. Token `d` (nicht in Liste) wird mit 401 abgelehnt
4. Logs zeigen pro Request eine konsistente Tenant-ID je Token
5. Single-Token-Deployments funktionieren unverändert (Backwards-Compat)
6. Timing-Side-Channel-Test: Vergleichszeit darf nicht von Token-Position in der Liste abhängen (heuristisch via Wallclock-Stat)
