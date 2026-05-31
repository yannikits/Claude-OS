# ADR-0045 — Claude Chat / Claude Code Split mit Rollen-Gate (MC-C)

**Status:** Akzeptiert (2026-05-31)
**Bedingt durch:** ADR-0021 (PTY-Upgrade xterm/node-pty), ADR-0036 (Multi-User Stage 2), MC-A (RBAC-Rollen-Spalte)

## Kontext

Der Nav-Punkt "Chat" im Cockpit war ein reiner PTY-Wrapper um die `claude`-CLI
(`gui/src/pages/index.tsx` → `pty.spawn` → `src/sidecar/pty-chat-sessions.ts`).
Damit war "Chat" faktisch bereits **Claude Code** — die volle Agent-CLI mit
Datei-Zugriff, Bash und allen Tools, ungated für jeden authentifizierten Nutzer.

Anforderung (Yannik): zwei getrennte Capabilities mit unterschiedlichem Zugang:

1. **"Claude Chat"** — leichtgewichtiges Gespräch, nutzbar von jedem Cockpit-Nutzer.
2. **"Claude Code"** — der mächtige Coding-Agent, nur für die, die ihn "im Plan haben".

Zwei Randbedingungen verschärften das Design:

- **Keine API-Tokens.** Die Nutzung soll wie auf claude.ai / in der Desktop-App
  über das **Abo** laufen, nicht über die token-abgerechnete Messages-API. Der
  einzige offizielle Weg dahin ist die `claude`-CLI selbst (OAuth-Login ins
  Pro/Max-Abo via `claude setup-token`). Die CLI ist damit Pflicht — ein
  selbstgebautes Messages-API-Chat-UI wäre das Gegenteil (immer Tokens).
- **Kein Anthropic-Plan-Bewusstsein im System.** Es gibt keine OAuth-/Plan-Erkennung
  pro Nutzer — nur das lokale RBAC (viewer/operator/admin aus MC-A).

## Entscheidung

### 1. Beide Modi = dieselbe `claude`-CLI, unterschieden per Flag

- **Chat:** `claude --tools ""` — alle Tools deaktiviert, reines Gespräch.
  (`--tools ""` ist das offizielle, an der installierten Binary verifizierte Flag;
  wirkt im interaktiven PTY, nicht `--print`-gebunden.)
- **Code:** `claude` mit vollem Tool-Set.

Beide laufen über das **zentrale Server-Abo** (CLI einmal per `setup-token`
eingeloggt). Keine API-Tokens.

### 2. Zwei Nav-Punkte, Rollen-gated im Frontend

- `/chat` → "Claude Chat", sichtbar für jeden authentifizierten Nutzer.
- `/code` → "Claude Code", `minRole: 'operator'` (`CODE_MIN_ROLE`).

`gui/src/pages/index.tsx`: gemeinsamer `ClaudeTerminalView({ mode })`, zwei dünne
Wrapper `ChatPage`/`CodePage`. Nav-Filter + Route in `App.tsx` per
`roleAtLeast(userRole, 'operator')`.

### 3. Echtes Gate server-seitig am PTY-Chokepoint

Frontend-Gating ist kosmetisch — ein Nutzer kann den WS-Frame direkt schicken.
Die Durchsetzung sitzt deshalb im Web-Pfad an der **WebSocket-Grenze**
(`src/server/ws-pty.ts`, `pty.spawn` läuft im Web-Build über `/api/pty/ws`,
nicht `POST /api/rpc`):

- `checkSessionCookie` liefert jetzt den `User` (mit `role`) statt nur `boolean`.
- Spawn-Frame trägt ein `mode: 'chat' | 'code'`.
- Pure Funktion `resolveSpawnDecision(mode, authUser, adminEmails, clientArgs)`:
  - `code` → erfordert `effectiveRole >= CODE_MIN_ROLE`; Bearer-Token-Modus
    (kein User) = trusted Owner → erlaubt.
  - `chat` → immer erlaubt, **Args server-seitig auf `['--tools','']` fixiert**;
    Client-Args werden ignoriert, damit ein gefälschter Frame keine Tools für
    einen viewer reaktivieren kann.

### 4. Abo-Modell: jetzt zentral, später Per-Seat

Jetzt: ein zentrales Server-Abo, RBAC entscheidet wer Code darf
("hat es im Plan" = Admin vergibt operator-Rolle). Forward-Path (Team-Plan mit
mehreren Standard-Seats + Premium-Seat): `CODE_MIN_ROLE` (1 Konstante) +
`resolveSpawnDecision` (1 Funktion) sind der einzige Andockpunkt für den
späteren Wechsel auf Per-User-Seat.

## Konsequenzen

**Positiv:**
- Klare Trennung leichter Chat / mächtiger Agent; Zugang sauber über bestehendes RBAC.
- Token-frei über das Abo, wie von Yannik gefordert.
- Das Gate ist nicht umgehbar — Server besitzt die chat-Args, Rolle wird am
  Chokepoint erzwungen. Schließt die bekannte PTY-WS-Auth-Lücke für diesen Pfad mit.
- Erweiterbar Richtung Team-Seats ohne Architektur-Umbau.

**Negativ / Schulden:**
- Tauri-Desktop-Pfad geht direkt zum Sidecar (kein WS-Server) — dort gilt das
  Gate nicht. Akzeptiert: Desktop ist single trusted owner (userRole='admin').
- "Claude Chat" ist vorerst ein xterm-Terminal mit `--tools ""`, kein
  claude.ai-artiges Bubble-UI (spätere optionale Phase).
- Voraussetzung Betrieb: Server muss einmal per `claude setup-token` ins Abo
  eingeloggt sein, sonst startet weder Chat noch Code.

## Alternativen

- **Eigenes Chat-UI über die Messages-API** — verworfen: immer Token-Abrechnung,
  widerspricht der "kein-Token"-Anforderung.
- **claude.ai per iframe einbetten** — verworfen: claude.ai blockt iframe-Einbettung
  (`X-Frame-Options`/CSP); nur in Tauri-WebView denkbar, dann ohne RBAC-/Memory-Integration.
- **Gate nur im Frontend (Nav/Route)** — verworfen: kosmetisch, per direktem
  WS-Frame umgehbar.
- **Args-Sniffing statt `mode`-Flag** — verworfen: fragil; explizites `mode` +
  server-seitige Arg-Hoheit ist robust.

## Quellen

- Commit `4c23c01` (feat(gui,server): MC-C — split Claude Chat / Claude Code with role gate)
- `src/server/ws-pty.ts` (`resolveSpawnDecision`, `CODE_MIN_ROLE`), `tests/server/ws-pty.test.ts`
- `tasks/todo.md` → Phase MC-C
- ADR-0021 (PTY), ADR-0036 (Multi-User), MC-A (RBAC-Rolle)
