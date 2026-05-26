# ADR-0032 — Server-Deployment: Headless HTTP-Variante mit Reuse von Sidecar-RPC

**Status:** Draft (waiting for Yannik approval)
**Datum:** 2026-05-26
**Kontext-PR:** (folgt)
**Verwandte ADRs:** ADR-0003 (Hybrid-CLI claude.exe-Delegation), ADR-0004 (Secrets via NAPI-RS Keyring), ADR-0006 (Tauri ↔ Node-Sidecar IPC), ADR-0027 (MSP-Bridge Permission-Model), ADR-0031 (Vault Multi-Workspace)

## Entscheidung

Claude-OS bekommt eine **zweite, parallele Distribution** neben dem Tauri-Desktop-Build: einen **Headless-HTTP-Server**, der dieselbe Domain-Logik wie das Sidecar exponiert, aber über HTTP/SSE/WebSocket statt NDJSON-stdio.

**Architektonisch kein neuer Kern — neuer Adapter:**
- `RpcDispatcher` (`src/sidecar/rpc.ts`) und `registerMethods()` (`src/sidecar/methods.ts`) bleiben unverändert
- Neuer Subtree `src/server/` wraps den Dispatcher in einen Fastify-HTTP-Server
- Bestehende Notifications (Sidecar → Tauri-Event) werden zu SSE-Events (`/api/events`)
- Chat/PTY-Streams bekommen WebSocket-Endpunkte (`WS /api/pty/:id`)

**Frontend:** der bestehende React/Vite-Code läuft in **beiden** Modi via Runtime-Transport-Detection (`window.__TAURI_INTERNALS__` → Tauri-`invoke`, sonst → HTTP-`fetch`). Beide Transport-Implementierungen werden in dasselbe Bundle gepackt; Tree-Shaking ist OK, Bundle-Size noch unter 200KB.

**Distribution:** Docker-Image mit Linux-`claude`-CLI als Sidecar-Process-Target (statt Windows-`claude.exe`). ADR-0003 bleibt damit gültig — die Delegation ist plattformneutral, nur das Binary wechselt.

**Hosting-Kontext (Reference-Setup Yannik):** Proxmox-Hypervisor mit Debian-VM + Docker; Cloudflare als DNS-Provider mit drei unterstützten Architektur-Pfaden (DNS-only + Let's Encrypt / Cloudflare-proxied + Origin-Cert / Cloudflare-Tunnel zero-trust). Architektur ist absichtlich Cloudflare-unabhängig; das Image funktioniert genauso hinter jedem anderen Reverse-Proxy.

## Begründung

### Warum nicht "Tauri auch im Web"?

Tauri 2.x hat keinen Web-Modus. Eine 100% getrennte zweite Frontend-App wäre erheblicher Doppelpflege-Aufwand. Die elegantere Variante: Transport-Layer abstrahieren, Pages bleiben identisch.

### Warum nicht "Anthropic-API direkt"?

ADR-0003 ist explizit: Claude-OS hat **kein** eigenes Provider-Interface. Anthropic-CLI managed Auth, Tool-Use, Plan-Mode, Slash-Commands. Auf Linux gibt's eine offizielle `claude`-CLI — das ist die natürliche Server-Variante. Anthropic-API direkt würde Tool-Use + Plan-Mode + Slash-Command-Implementierung in claude-os ziehen — riesiger Code, riesiger Maintenance-Hit, dauerhaftes Catch-up gegen Anthropic-Releases.

### Warum Fastify (nicht Express)?

- Async-native (alle unsere Domains sind Promise-basiert)
- Schema-Validation via TypeBox kompatibel (wir haben `@sinclair/typebox` schon im Repo)
- Eingebauter `pino`-Logger (matched unseren Stack)
- ~2× schneller als Express bei ähnlicher API
- Kleinere Surface-Area = weniger Security-Patches

### Warum SSE für Notifications (nicht WebSocket für alles)?

- Notifications sind unidirektional Server→Client → SSE ist das richtige Werkzeug, nicht WS
- SSE läuft über normales HTTP/1.1, einfacher durch nginx-Proxy
- Auto-Reconnect ist im Browser eingebaut
- Heartbeat-Frame-Logik ist trivial
- WebSocket bleibt **nur** für Chat/PTY-Streaming (bidirektional, frame-frequent)

### Warum Bearer-Token (nicht OAuth)?

- Single-User MVP — OAuth wäre Overkill
- Bearer in `Authorization`-Header ist Standard, jede HTTP-Library kann es
- Tenant-Resolver akzeptiert "Token" als Identity-Key → Multi-User-Migration ist Token→User-Table-Lookup, kein API-Bruch
- nginx proxy manager + Let's Encrypt liefert TLS; Token in Plaintext nur über TLS

### Warum EncryptedFileStore (nicht Keyring) im Container?

- `@napi-rs/keyring` braucht auf Linux ein Secret-Service / GNOME-Keyring / KWallet — alles Desktop-Stack
- Headless-Container hat keine Session-Bus
- `EncryptedFileStore` existiert schon (ADR-0004) als Fallback, PBKDF2-SHA-256 600k iterations, AES-256-GCM, atomic-write
- Master-Passphrase via env-var (`CLAUDE_OS_SECRETS_PASSPHRASE`) — User legt sie via Docker-Secrets oder env-File ab

## Konsequenzen

### Positiv

- **Zero Domain-Code-Duplikation:** alle bestehenden RPC-Methoden funktionieren sofort über HTTP
- **Tauri-Distribution bleibt intakt:** keine Breaking-Changes am Desktop-Build
- **Multi-User-Pfad ist klar:** Token-Tabelle + Tenant-Resolver, beides existiert konzeptuell schon
- **Self-Hosted = volle Souveränität:** Yannik kontrolliert Daten + Compute, keine SaaS-Bindung
- **Niedrige Hosting-Kosten:** läuft auf jedem Linux-VPS, ARM-fähig

### Negativ

- **Zwei Distributions zu warten:** Tauri-Bundle + Docker-Image — jede Phase muss in beiden Pfaden getestet werden (Mitigation: gemeinsamer Test-Layer für Domain-Logik, dünner Adapter-Test pro Transport)
- **Drag-Drop / Native-Dialoge nicht im Web:** Browser-File-API ist anders; einige Features (z.B. `setSecretNative`) sind Tauri-only und im Web mit Inline-Fallback
- **PTY über WebSocket-Streaming komplexer als Tauri-IPC:** Reconnect-Logik, Frame-Buffering, Subprotocol-Auth — alles Code, der in Tauri "geschenkt" ist
- **Auth-Token ist Single-Secret:** Verliert User das Token → Reset im Container nötig. Mitigation: `docker exec` + env-rotation dokumentiert
- **Linux-`claude`-CLI als Distribution-Dependency:** wir laden ein offizielles Binary in den Docker-Layer; Hash-pinning + Source-Verifikation Pflicht (sonst Supply-Chain-Risiko)

### Neutral

- **Security-Boundary wandert:** im Desktop-Mode ist die Trust-Boundary "User auf Maschine"; im Server-Mode ist sie "Token-Holder". `SECURITY.md` muss um Server-Spezifika ergänzt werden (folgt mit Phase Web-6).

## Out-of-Scope für dieses ADR

- **MSP-Bridges im Server-Mode**: bleiben in `claude-os-msp` (ADR-0030). Server-Variante des Public-Cores ist Personal-Workspace-fokussiert.
- **Public-Internet-Multi-User mit Selbst-Registrierung**: eigene Phase + eigenes ADR. Bearer-Single-User reicht für Phase Web.
- **Plugin-Sandbox im Server-Mode**: Skill-Auto-Promotion (ADR-0026) ist auf Desktop-Yannik-Signatur-Flow ausgelegt. Server-Variante behält denselben Gate, exposed ihn aber nicht über HTTP (read-only).

## Alternativen erwogen

1. **Anthropic-API-Direct + neues Provider-Layer** — verworfen wegen ADR-0003-Bruch und Maintenance-Aufwand
2. **Tauri-Mobile (Tauri 2.x WebView auf Server)** — gibt's nicht, Tauri ist Desktop-only
3. **CLI-only mit SSH-Tunnel (kein Web-UI)** — verfehlt das User-Goal "per Weboberfläche"
4. **Electron-Web-App neben Tauri** — Tauri und Electron parallel = noch schlimmerer Doppelbau

## Implementation-Plan

Siehe `tasks/phase-server-web.md`. 6 Sub-Phasen (Web-1 bis Web-6), Branch `feature/phase-web-server-deployment`.

## Akzeptanzkriterien

Dieses ADR gilt als implementiert, wenn:

1. `docker compose up -d` auf einem leeren Linux-Host bringt einen erreichbaren claude-os-Service hoch
2. Browser-Zugriff via HTTPS (hinter nginx proxy manager) zeigt funktionierendes Dashboard, Memory, Catalog
3. Tauri-Desktop-Build funktioniert weiterhin unverändert
4. Bearer-Token-Auth blockiert unauthenticated Zugriffe (401)
5. `claude auth login` im Container überlebt Container-Restart (Volume-persistent)
6. `docs/server-deployment.md` ist abgeschlossen
7. Bestehende Tests bleiben grün; neue Tests für Server-Adapter + Frontend-Transport-Detection
