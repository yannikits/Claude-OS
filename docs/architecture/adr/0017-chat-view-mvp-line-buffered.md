# ADR-0017 — Chat-View-MVP über line-buffered `child_process` statt PTY

**Status:** Akzeptiert
**Datum:** 2026-05-20
**Bedingt durch:** v1.2 Chat-View-MVP (PR [#29](https://github.com/yannikits/Claude-portable/pull/29))

## Kontext

Phase 6e hatte die Chat-Page in der Tauri-GUI als Platzhalter mit "PTY-Streaming noch nicht implementiert"-Hinweis gelassen. v1.2 sollte daraus einen funktionsfähigen Chat machen: User tippt Argumente, der Sidecar spawnt `claude.exe` (oder eine alternative Anthropic-CLI), der GUI-Renderer zeigt Stdout/Stderr live an.

Die idiomatische Lösung für interaktive CLI-Eingaben in einem WebView wäre **`node-pty`** mit `xterm.js` im Renderer. Damit bekommt man:

- Echte TTY-Allokation → ANSI-Cursor-Control, interaktive Password-Prompts, `\r`-Carriage-Returns für Progress-Bars
- Native Terminal-Bedienung mit allen Hotkeys, copy/paste, screen-resize
- Bekanntes Pattern aus VSCode, Hyper, Tabby

Aber `node-pty` hat einen schweren Trade-off: es ist ein **Native-Module** mit `node-gyp`-Build. Auf Windows braucht es Visual Studio Build Tools, auf macOS Xcode-CLT, auf Linux gcc. In unserem Setup heißt das:

1. **Sidecar-Bundling über `@yao-pkg/pkg`** (Phase 6b) müsste das `.node`-Binary kopieren — pkg verträgt sich schlecht mit Native-Modules.
2. **CI-Matrix-Builds** auf drei OS müssten jeweils die richtige Build-Chain haben — wir vermeiden das aktuell bewusst durch reine Pure-JS-Deps (siehe Phase 5o: `@napi-rs/keyring` ist die einzige Ausnahme, und die wird im Sidecar über `CLAUDE_OS_SECRETS_BACKEND=file` umgangen).
3. **Cross-Platform-Tarball-Distributions** könnten je nach User-Maschine fehlschlagen wenn die Node-ABI nicht passt.

Die ganze v1.x-Roadmap profitiert davon, dass wir bisher keine Native-Build-Schmerzen haben. `node-pty` würde das brechen.

## Entscheidung

**Chat-View-MVP nutzt `child_process.spawn` mit line-buffered Stdout/Stderr — kein PTY in v1.2.**

### Implementierungsdetails (PR #29)

1. **`src/sidecar/chat-sessions.ts` — `ChatSessions`-Klasse:**
   - `spawn(args) → {sessionId}` — startet `claude.exe` (oder die per `claude-bridge` aufgelöste Binary) als Kindprozess mit `stdio: ['pipe', 'pipe', 'pipe']`.
   - `write(sessionId, input)` — schreibt User-Input in `child.stdin`.
   - `kill(sessionId)` — `SIGTERM` mit 2 s `SIGKILL`-Fallback.
   - `MAX_SESSIONS = 8` Ring-Guard verhindert Resource-Exhaustion bei zu vielen offenen Tabs.

2. **Output-Streaming als JSON-RPC-Notifications:**
   Stdout/Stderr werden line-buffered (newline-getrennt) als `chat.output` / `chat.exit` Notifications zum Tauri-Supervisor gepusht. Der Supervisor re-emittiert sie als Tauri-Events `chat://output` / `chat://exit`, die der Renderer abonniert.

3. **Renderer `ChatPage`:**
   - Args-Input + Spawn/Stop-Buttons
   - 500-Line-Ring-Buffer (verworfen ab Zeile 501 von oben)
   - Stdout/Stderr/Meta farbcodiert
   - Stdin via Enter-to-Send
   - Keine Cursor-Control, kein `\r`-Overwrite — beste-Approximation eines Chat-Logs

4. **Windows-`.cmd`/`.bat`-Handling (CVE-2024-27980):**
   Wenn die aufgelöste Binary auf `.cmd` oder `.bat` endet, setzen wir `spawn(..., { shell: true })`. Sonst fehlt cmd.exe-Indirection und die Bat-Datei läuft nicht. **Mitigation der CVE:** Args werden vorher mit einer strikten Allowlist (`/^[A-Za-z0-9._\-\/=:]+$/`) validiert, damit keine Shell-Metacharacters injizierbar sind. Default `shell: false` für alle anderen Plattformen/Endungen.

## Konsequenzen

### Positiv

- **Keine Native-Build-Abhängigkeiten** — Bundling/CI bleiben Pure-JS, kein `node-gyp`-Setup auf User-Maschinen nötig.
- **Sehr klein** — `ChatSessions` ist ~150 LOC, Renderer-Page ~200 LOC. Reviewable.
- **Cross-Platform out of the box** — `child_process.spawn` ist Node-Standard, identische Semantik auf Windows/macOS/Linux.
- **Forward-kompatibel** — die `chat.spawn` / `chat.output` / `chat.exit`-RPC-Surface bleibt identisch wenn wir später auf PTY upgraden. Frontend-Code muss nicht angefasst werden.

### Negativ / Akzeptierte Trade-offs

- **Keine TTY-Detection:** Tools die `process.stdout.isTTY` checken, sehen `false` und schalten in non-interactive-Mode. Manche CLIs unterdrücken dann Spinners/Farben — kosmetisch, aber bemerkbar.
- **Keine interaktiven Password-Prompts:** Tools die `readline.createInterface(process.stdin)` mit Echo-off nutzen (z. B. SSH-Passphrase), funktionieren nicht. **Workaround dokumentiert:** Passwörter über `claude-os secrets`-CLI vor dem Chat-Spawn ablegen, Tool greift via Env-Var darauf zu.
- **Keine ANSI-Cursor-Control:** `\r`-Carriage-Returns (Progress-Bars) erscheinen als getrennte Zeilen statt überschriebene. Tools die `\x1b[2J`-Clear-Screen nutzen, sehen es als Literal-Text.
- **Line-Buffering kann Latenz erhöhen** wenn die CLI Output ohne explizite `\n`-Flushes schreibt. In Praxis selten, da `claude.exe` flushed.

### Konstraints für Folge-Phasen

- **PTY-Upgrade ist v1.x-Material** wenn ein konkreter Use-Case auftaucht (Password-Prompts, interaktiver REPL). Pattern: `chat.spawn` bekommt ein optionales `{tty: true}`-Flag; Frontend bleibt unverändert.
- **Neue Output-Renderer (xterm.js)** würden den 500-Line-Ring durch einen Terminal-Buffer ersetzen. Funktionsweise von `chat.output`-Events bleibt gleich.
- **CVE-2024-27980-Mitigation muss bleiben** auch im PTY-Pfad — `shell: true` wird bei `.cmd`/`.bat` wegen Windows-cmd.exe-Indirection sowieso gebraucht.

## Alternativen verworfen

**`node-pty` + `xterm.js` (idiomatisch, aber teuer):** Verworfen aus den im Kontext genannten Native-Build-Gründen. Die UX-Gewinne (echte TTY, ANSI) sind real, aber die Cost-Cost-Bilanz für v1.2 negativ — die meisten User wollen einfach den Chat-Log sehen, keine Cursor-Animationen.

**`conpty` / `winpty` direkt ohne node-pty-Wrapper:** Würde uns OS-spezifische Bindings einfangen — Kosten ohne Nutzen gegenüber `node-pty`.

**Polling statt Streaming:** Verworfen — das ergibt unbrauchbare UX bei langen Operations. Stream-via-Notifications skaliert auf längliche Output-Stürme.

**Browser-direct-spawn (kein Sidecar):** Tauri's `tauri-plugin-shell` kann selbst Prozesse spawnen. Aber dann bypassed der Renderer den Sidecar's RPC-Dispatcher, der Single-Source-of-Truth für Domain-State ist (sessions-tracking, kill-on-shutdown, MAX_SESSIONS). Architecture-Inkonsistenz war's nicht wert.

## Referenzen

- ADR-0001 — Tauri als GUI-Framework
- ADR-0006 — Tauri-Sidecar-Stdio-IPC
- PR [#29](https://github.com/yannikits/Claude-portable/pull/29) — Chat-View-MVP-Implementierung
- `src/sidecar/chat-sessions.ts`
- `gui/src/pages/index.tsx` (ChatPage)
- CVE-2024-27980 — Node.js spawn-with-shell:true Mitigation
