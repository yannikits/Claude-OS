# ADR-0036 — Multi-User Stage 2: Email/Passwort-Login mit Session-Cookies

**Status:** Akzeptiert (2026-05-28)
**Datum:** 2026-05-28
**Bedingt durch:** ADR-0033 §"Stage 2" (Token-Liste war Stage 1) + `tasks/phase-web-7-multi-user.md`.

## Kontext

ADR-0033 hat Stage 1 Multi-User über eine `CLAUDE_OS_AUTH_TOKEN`-CSV-Liste eingeführt — ausreichend für Service-Tokens und Power-User, aber UX-feindlich für regulär eingeloggte Browser-Sessions (Token-Copy-Paste bei jedem neuen Tab, kein Logout, keine Profile-Anzeige, kein Self-Service Passwort-Wechsel).

`tasks/phase-web-7-multi-user.md` spezifiziert die Stage-2-Erweiterung: persistente Email/Passwort-Identitäten, Session-Cookies mit sliding-TTL, optionale Self-Registration, Admin-CLI für Provisioning. Wir bauen das **additiv** auf Stage 1 — die Bearer-Token-Pipeline bleibt unverändert, Cookie-Auth läuft als bevorzugter Pfad mit Bearer als Fallback.

## Entscheidungen

### 1. Domain-Layout: `src/domains/users/` + `src/domains/sessions/`

Spec sagte `src/server/users.ts`. **Umgesetzt: `src/domains/users/`** parallel zu `domains/tenant/`. Begründung: das User-Repository wird auch von der CLI (`claude-os users create`, ADR-0036 §6) und potenziell vom Sidecar (zukünftige RPCs für Profile-Daten in Tauri-Mode) konsumiert. `src/server/auth.ts` dokumentiert explizit "Domain → transport, never the other way" — wir folgen dem Pattern.

Sessions sind aus demselben Grund in `src/domains/sessions/`: Tests + CLI + Server greifen über die gleiche API zu.

### 2. Password-Hashing: `node:crypto.scrypt` mit OWASP-2023-Parametern

| Parameter | Wert | Begründung |
|---|---|---|
| KDF | scrypt | Built-in Node, kein native-build dep (matches sql.js no-native-deps per ADR-0025) |
| N | 16384 | OWASP-2023 Baseline |
| r | 8 | OWASP-2023 Baseline |
| p | 1 | OWASP-2023 Baseline |
| dkLen | 64 bytes | konservativ über default 32 |
| Salt | 32 random bytes per user | über OWASP-Min 16 |
| MIN_PASSWORD_LEN | 12 | OWASP-2023 modern empfohlen |

**Wire-Format (algorithm-tagged für Future-KDF-Migration):**

```
scrypt$N=16384$r=8$p=1$<salt-b64>$<hash-b64>
```

Verify nutzt `timingSafeEqual` über die abgeleiteten Buffer — niemals über den encoded String (würde Salt-Prefix-Position via Timing leaken).

**Migration-Pfad:** wenn wir auf scrypt-Argon2 wechseln müssen, ändert sich der Tag-Prefix (`argon2$…`). Repo hält die KDF-Detection im `parseEncoded`-Helper; verifyPassword kann transparent rotation via "verify-old-then-rehash-with-new"-Pattern unterstützen.

### 3. Session-Store: In-Memory LRU mit sliding-TTL, opt-in persistent

**Default: in-memory.** Container-Restart = Re-Login. Akzeptabel für homelab-scale. Implementierung: pure `Map`-basierter LRU (insertion-order), `SessionRepository` mit `now()`-injektivem Time-Source für Tests.

**Opt-in persist** via `$CLAUDE_OS_SESSION_PERSIST=1` (Phase Web-7-2-tail / Web-7-3): selber `users.sqlite` mit zusätzlicher `sessions`-Tabelle. v1 verzichtet noch — Yannik kann das nachziehen wenn der Re-Login-Reibungspunkt real wird.

**TTL:** 30 Tage sliding-window. Jeder authentifizierte Request refresht `lastUsedAt` und schreibt `expiresAt = now + TTL` zurück.

**Session-ID:** 256-bit CSPRNG via `randomBytes(32).toString('base64url')` — 43 chars, fits comfortably in der 4KB-Cookie-Budget mit CSRF-Cookie daneben.

### 4. Cookies: HTTP-only Session + readbare CSRF (Double-Submit)

| Cookie | HttpOnly | SameSite | Secure | Zweck |
|---|---|---|---|---|
| `claude_os_session` | **ja** | Strict | conditional¹ | session-id; einziger Auth-Träger |
| `claude_os_csrf` | nein | Strict | conditional¹ | Double-Submit-Wert für CSRF-Check |

¹ `Secure` ist gesetzt **außer** wenn `$CLAUDE_OS_INSECURE_COOKIES=1` (Dev/Localhost-Override). Produktion läuft TLS-terminiert (Cloudflare-Tunnel oder nginx-proxy-manager).

**CSRF-Strategie:**
- Cookie-mode + unsafe-method (POST/PUT/PATCH/DELETE) → Server prüft `x-csrf-token` header gegen `claude_os_csrf` cookie via `timingSafeEqual`. Mismatch → 403.
- Login (`/api/auth/login`) und Refresh (`/api/auth/refresh`) sind CSRF-exempt — Login *mintet* die Cookies, Refresh läuft bereits hinter Cookie-Auth.
- **Bearer-only Clients (CLI, CI) skippen CSRF entirely** — Bearer ist unforgeable und wird vom Browser nicht auto-attached cross-site.

### 5. User-Enumeration-Defense

Verifies bei unbekannter Email müssen **dieselbe Zeit** brauchen wie bei bekannter — sonst Side-Channel: Attacker timing-misst, wer registriert ist.

Implementierung in `UserRepository.verifyPassword()`:

```typescript
if (user === null || user.disabled) {
  await this.exerciseFakeHash(password);  // lazy-computed once
  return null;
}
// real scrypt-verify ...
```

`fakeHash` wird beim ersten Miss in der Repo-Instanz erzeugt und memoized — kostet einmal scrypt, dann konstanter Verify-Pfad.

### 6. Rate-Limiting: per-IP Token-Bucket

| Pfad | Capacity | Refill | Strategy |
|---|---|---|---|
| `POST /api/auth/login` | 5 attempts | 15min/window | failed-only debit; success wipes |
| `POST /api/auth/register` | 3 attempts | 60min/window | jede Anfrage debit (success + failure) |

Beide nutzen die gleiche `LoginRateLimiter`-Klasse mit unterschiedlichen Parametern. **In-memory only** — Container-Restart resettet. Phase-Web-8 macht persistent (audit-log als Source-of-Truth für Cooldown-Window).

Max-tracked-IPs: 10.000 default — Schutz gegen IP-Spray-OOM-Attack. Bei Überschreitung Eviction des ältesten Buckets.

### 7. Audit-Log-Events

Neue `AuditEventKind`-Werte in `src/core/audit/types.ts`:

| Kind | Outcome | Details |
|---|---|---|
| `auth.login.success` | ok | `userId`, `emailHash`, `ipHash`, `userAgent` |
| `auth.login.failed` | denied | `reason: 'invalid-credentials'\|'rate-limited'`, `emailHash`, `ipHash`, `userAgent`, `retryAfterSec?` |
| `auth.logout` | ok | `userId`, `ipHash` |
| `auth.register` | ok\|denied | `userId?`, `reason?`, `emailHash`, `ipHash`, `userAgent` |
| `auth.password.change` | ok | `userId`, `ipHash`, `revokedSessions` |

**Pflicht-Redaction:** Plain-Email und Plain-IP gehen NIE ins Audit-Log. `emailHash`/`ipHash` ist `sha256(value).slice(0, 16)` — 16 hex chars, deterministisch, forensisch korrelierbar ohne Wiederherstellung.

### 8. tenant-from-user Resolution: namespace-disjunkt zu tenant-from-token

`src/domains/tenant/resolve-token.ts` bekommt einen Geschwister-Resolver `userToTenantId(user)`:

- **Override gewinnt:** `user.tenantIdOverride` (Power-Feature für Family-Sharing) wird direkt zurückgegeben
- **Default:** `'user-' + sha256(user.id).slice(0, 12)`

**Namespace-Garantie:** user-derived ids beginnen mit literalem Prefix `user-`, token-derived ids mit Hex-Digit. Collision unmöglich → ein Server kann gleichzeitig Email-User UND Bearer-Token-User authentifizieren, beide bekommen stabile, disjunkte tenant-ids.

### 9. Auth-Hook-Reihenfolge: Cookie-first → Bearer-Fallback

`makeCookieAuthHook` ersetzt `makeAuthHook` wenn `MultiUserConfig` gesetzt ist:

1. **Session-Cookie** prüfen → bei Hit User-Lookup → wenn aktiv+nicht-disabled: `req.user` + `req.tenant` setzen
   - Für unsafe-methods: zusätzlich CSRF Double-Submit-Check
2. **Bearer-Token** als Fallback (ADR-0033 Stage 1) → matched token → `req.tenant` setzen (kein `req.user`)
3. Sonst 401

PUBLIC_PATHS (skippen Hook komplett): `/api/auth/login`, `/api/auth/register`.

### 10. v1-Vereinfachungen (transparent)

- **`POST /api/auth/refresh` ist TTL-slide-only, NICHT bearer→cookie-exchange.** Bearer-Tokens sind nicht user-gebunden (ADR-0033 §Stage 1) — Session ohne User-of-Record zu fabrizieren ist konzeptionell unsauber. v1: refresh sliced nur den TTL des existierenden Cookie-Session.
- **Sessions-CLI ist in-memory-only.** `claude-os users sessions list/revoke` öffnet eine frische empty SessionRepository — separater Prozess vom Server. Wir geben eine explizite Warnung aus. Phase-Web-8 wird das via opt-in-persist sauber lösen.
- **Cookie-Auth integriert sich noch nicht voll in den RPC-Transport** (`gui/src/lib/rpc-http.ts`). Login/Register/Logout/Me/ChangePassword laufen über `gui/src/lib/auth-api.ts` direkt; reguläre RPCs bleiben Bearer-only. Web-7-4-tail oder eigene Folge-Phase macht den RPC-Transport cookie-aware (heutiger Stand: cookie geht durch browser-credentials, CSRF-Header fehlt aktuell für reguläre `/api/rpc`-Calls). Workaround für jetzt: Browser-Clients nutzen den Bearer-Tab im Login.

## Klärungspunkte abgehakt

| Frage | Entscheidung | Begründung |
|---|---|---|
| scrypt vs bcrypt | scrypt | Built-in Node, kein native-build, OWASP-2023 |
| In-memory vs persist | in-memory default, opt-in via env | Container-Restart-Logout akzeptabel; Phase-Web-7-3+ kann opt-in persist |
| Self-Registration default | OFF | Trusted-Network-Pattern; Admin-CLI ist Standard-Provisioning |
| 2FA / TOTP | v2 | Significant complexity; Cloudflare-Access + Bearer reichen aktuell |
| OAuth-Provider | Phase Web-8 | 4-6h eigenständig — lieber sauber separat |
| Schema-Migration | versioned-pragma | `schema_version` in `meta`-Tabelle, autoRebuildOnSchemaDrift opt-out für CLI-doctor |

## Konsequenzen

**Positiv:**
- Standard-Login-UX für Browser-User; mehrere parallel User mit Session-Isolation
- Bearer-Pipeline bleibt unverändert → keine Breaking-Changes für Service-Tokens / CLI / CI
- CSRF + SameSite=Strict + HttpOnly → mehrschichtige Browser-Defense
- Audit-Log: gehashte Email/IP-Forensik ohne Wiederherstellung von PII
- Admin-CLI `claude-os users …` für headless Provisioning + Backup/Restore via reines `users.sqlite`-Copy

**Negativ:**
- `users.sqlite` ist ein zusätzlicher Persistenz-Punkt — Backup-Plan muss es einschließen (Proxmox-VM-Snapshot deckt es per default)
- sql.js ist single-writer → CLI + Server müssen sequentiell laufen (dokumentierte Operator-Constraint)
- Session-Persistence v1=in-memory bedeutet Container-Restart = alle eingeloggten User müssen erneut authentifizieren

**Out-of-Scope dieser ADR / Stage:**
- OAuth (GitHub, Google, Apple) → Phase Web-8
- WebAuthn / Passkeys → v2
- Password-Reset via SMTP → Phase Web-8 (braucht SMTP-Integration)
- Per-User-Quotas → Phase Web-8 (braucht persistent rate-store)
- Per-User-Vault-FS-Isolation (`vault/users/<id>/`) → Phase Web-9
- Mobile-OAuth/OIDC → v2

## Referenzen

- ADR-0032 — Headless HTTP-Deployment (Phase Web-1-6)
- ADR-0033 — Multi-User Stage 1 (Token-Liste)
- ADR-0034 — Skill Sandbox via child_process.fork
- ADR-0035 — Yannik-Ed25519-Signatur-Flow (separates Signing-Subsystem)
- OWASP Password Storage Cheat Sheet (2023)
- Lesson 2026-05-22 — Web-Renderer Secret-Input Pattern
- Lesson 2026-05-25 — Literal-Space in JS-Regex-CharClass
