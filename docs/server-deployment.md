# Claude-OS Server-Deployment

> Status: Phase Web (alpha). Implementiert per ADR-0032. Plan-Tracker: [`tasks/phase-server-web.md`](../tasks/phase-server-web.md).

Diese Anleitung beschreibt das selbst-gehostete Deployment von Claude-OS als Headless-HTTP-Server mit Web-UI. Sie nutzt als Referenz-Setup einen **Proxmox-Homelab** mit **OPNsense-Firewall**, **nginx proxy manager** und **Cloudflare-DNS** — funktioniert aber auf jedem Linux-Host mit Docker.

---

## Was du danach hast

- Browser-zugängliche Claude-OS-Instanz unter deiner eigenen Domain (z.B. `https://claude-os.iteen.dev`)
- Single-User Bearer-Token-Auth (Multi-User-fähig vorbereitet — siehe ADR-0032)
- Persistenter Vault + Anthropic-CLI-Login in einem Docker-Volume → überlebt Container-Restarts und Updates
- TLS via Let's Encrypt **oder** Cloudflare-Origin-Cert **oder** Cloudflare-Tunnel (du wählst)
- Backup-Pfad via Proxmox-Snapshot + zusätzlicher Volume-Sync
- **MSP-Health-Cockpit** über deine Kundensysteme (TANSS, Veeam, Sophos, Securepoint, NinjaOne) — siehe §"MSP-Health-Bridges konfigurieren"

## Was du nicht bekommst (bewusst out-of-scope für Phase Web)

- Native Drag-and-Drop im Browser (Tauri-only)
- Live Chat-PTY-Streaming im Browser (kommt in Phase Web-3)
- ~~Multi-User-Login mit Registrierung~~ — **shipped seit Phase Web-7 (ADR-0036)** — siehe §"Multi-User mit Email-Login (Stage 2)" weiter unten
- Schreibende MSP-Aktionen (Ticket-Bearbeitung, Firewall-Regeln, Script-Ausführung) — die Read-Bridges + Read-only-Dashboard sind shipped; Write-/Automation-Actions folgen (siehe `tasks/phase-msp-cockpit.md`)

---

## Voraussetzungen

| Komponente | Empfehlung |
|---|---|
| Hypervisor | Proxmox VE 8.x (optional) |
| Gast-OS | Debian 12 oder Ubuntu 24.04 LTS |
| CPU | 2 vCPU |
| RAM | 2 GB (4 GB komfortabler) |
| Disk | 10 GB OS + 10 GB für `/data`-Volume |
| Docker | Engine ≥ 24, Compose-Plugin ≥ 2.20 |
| Domain | eigene Domain in Cloudflare gehostet |
| Reverse-Proxy | nginx proxy manager (optional, falls Cloudflare Tunnel nicht genutzt) |

LXC statt VM ist möglich, hat aber bei Docker-in-LXC einige Cgroup-/AppArmor-Quirks. **Empfehlung: VM.**

---

## Schritt 1 — Proxmox-VM anlegen

1. In Proxmox: **Create VM** mit Debian-12-Cloud-Image (oder ISO-Installation)
2. CPU **type: host**, 2 cores
3. RAM **2048 MB** (oder mehr)
4. Disk **10 GB** auf schnellem Storage (NVMe wenn vorhanden)
5. Netzwerk: Bridge `vmbr0`, VirtIO
6. **In der VM**:
   ```bash
   sudo apt update && sudo apt full-upgrade -y
   sudo apt install -y curl ca-certificates gnupg
   # Docker offiziell:
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER
   newgrp docker  # neue Gruppe in aktueller Shell aktivieren
   docker --version
   docker compose version
   ```

---

## Schritt 2 — Claude-OS deployen

### 2.1 Image holen + Compose vorbereiten

```bash
mkdir -p /opt/claude-os && cd /opt/claude-os
curl -fsSL https://raw.githubusercontent.com/yannikits/Claude-portable/main/docker-compose.example.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/yannikits/Claude-portable/main/.env.server.example -o .env
```

Alternativ den ganzen Repo clonen, falls du selbst bauen willst:
```bash
git clone https://github.com/yannikits/Claude-portable.git /opt/claude-os
cd /opt/claude-os
cp docker-compose.example.yml docker-compose.yml
cp .env.server.example .env
# in docker-compose.yml die `image:`-Zeile durch `build: .` ersetzen
```

### 2.2 Secrets generieren

```bash
echo "CLAUDE_OS_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
echo "CLAUDE_OS_SECRETS_PASSPHRASE=$(openssl rand -hex 32)" >> .env
# Falls .env die Platzhalter-Zeilen schon enthält, vorher löschen
```

> **Sichere die Werte aus `.env` in deinem Passwortmanager.** Der `AUTH_TOKEN` ist dein Login. Die `SECRETS_PASSPHRASE` entschlüsselt deinen Secrets-Store — Verlust = Secrets verloren.

### 2.3 Container starten

```bash
docker compose pull   # oder: docker compose build
docker compose up -d
docker compose logs -f claude-os
```

Erwartete Ausgabe enthält `server: listening at http://0.0.0.0:3000`.

### 2.4 Anthropic-Login (einmalig)

Damit Claude-OS deine Anthropic-Sessions nutzen kann:

```bash
docker exec -it claude-os claude auth login
```

Die Claude-CLI öffnet einen DeviceCode-Flow → URL und Code anzeigen → im Browser auf deinem Laptop einloggen → fertig. Die Credentials landen in `/data/anthropic/` im Volume und überleben Container-Restarts.

Verifikation:
```bash
docker exec claude-os claude auth status
# → loggedIn: true, expiresAt: …
```

### 2.5 Lokaler Smoketest

Aus der VM heraus:
```bash
curl -s http://127.0.0.1:3000/healthz
# → {"ok":true,"ts":…}

curl -s -X POST http://127.0.0.1:3000/api/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep CLAUDE_OS_AUTH_TOKEN .env | cut -d= -f2)" \
  -d '{"method":"ping"}'
# → {"ok":true,"result":{"pong":true,"ts":…}}
```

---

## Schritt 3 — Public-Access wählen

Drei Optionen, von "klassisch" bis "zero-trust". Wähle **eine**.

### 3.A — Klassisch: Cloudflare DNS-only + nginx proxy manager + Let's Encrypt

> Cloudflare ist nur Nameserver, dein Origin macht TLS selbst. Port 443 muss von außen erreichbar sein.

1. **OPNsense:** Port-Forwarding `0.0.0.0/0 :443` → `<VM-IP>:443`
2. **Cloudflare DNS-Tab:**
   - A-Record `claude-os.deinedomain.tld` → öffentliche IP
   - **Proxy-Status auf "DNS only" (graue Wolke)**
   - Bei dynamischer IP: `cloudflare-ddns`-Container parallel laufen lassen
3. **nginx proxy manager:**
   - Proxy Host hinzufügen
   - Domain: `claude-os.deinedomain.tld`
   - Forward Hostname: `<VM-IP>` (oder `claude-os` wenn nginx im selben Compose-Stack)
   - Forward Port: `3000`
   - **Websockets Support: ON**
   - SSL-Tab → Request new SSL Certificate (Let's Encrypt), Force SSL, HTTP/2
4. Browser → `https://claude-os.deinedomain.tld` → Login mit `CLAUDE_OS_AUTH_TOKEN`

### 3.B — Cloudflare-proxied + Origin-Cert (Empfehlung)

> Bonus: DDoS-Schutz, kein Origin-IP-Leak, Caching für Static-Assets. Trotzdem End-to-End-TLS.

1. **Cloudflare DNS-Tab:** A-Record `claude-os.deinedomain.tld` → öffentliche IP, **Proxy-Status auf "Proxied" (orange Wolke)**
2. **Cloudflare → SSL/TLS → Origin Server:** Create Certificate, RSA 2048, validity 15 years. Lade `cert.pem` und `key.pem` runter
3. **OPNsense:** Port-Forwarding `0.0.0.0/0 :443` → `<VM-IP>:443` (Cloudflare-IP-Ranges optional auf Allowlist)
4. **nginx proxy manager:**
   - Proxy Host wie in 3.A, aber **SSL → Custom certificate** und die Cloudflare-Origin-Cert+Key hochladen
5. **Cloudflare → SSL/TLS → Overview:** Modus auf **"Full (strict)"**
6. Optional: **WebSockets** auch in Cloudflare aktivieren (Network-Tab, ist Default-an), und **gRPC** falls Probleme bei langen Verbindungen

### 3.C — Cloudflare Tunnel (Zero-Trust, keine offenen Ports)

> Sicherste Variante: Outbound-Tunnel von der VM zu Cloudflare-Edge. Kein `:443` an OPNsense öffnen.

1. **Cloudflare Zero Trust → Networks → Tunnels → Create Tunnel** → Name "claude-os"
2. **Install-Token kopieren**, in `.env` setzen: `CF_TUNNEL_TOKEN=<token>`
3. In `docker-compose.yml` den `cloudflared`-Block einkommentieren (vorgemacht im Example-File)
4. `docker compose up -d cloudflared`
5. Im Tunnel: **Public Hostnames** → Add → `claude-os.deinedomain.tld` → Service: `http://claude-os:3000`
6. Cloudflare legt den DNS-Record automatisch an
7. Optional: **Cloudflare Access** als zusätzliche Auth-Schicht (Email-OTP, Google-Workspace, etc.)

---

## Schritt 4 — Verifizieren

Browser → deine Domain → Login-Seite erscheint → Token aus `.env` reinkopieren → Dashboard mit Cards (Sidecar-Ping, Catalog-Count, Vault-Status, Agent-Count) sichtbar.

```bash
docker exec claude-os wget -qO- http://127.0.0.1:3000/healthz
```

---

## Schritt 5 — Backup

Defense-in-depth: **Snapshot + rsync**, weil ein Snapshot auch einen kaputten Zustand einfriert.

### 5.1 Proxmox-Snapshot (full-VM, Application-konsistent)

In Proxmox automatisch via **Backup-Job**:
- Storage: separates NAS oder PBS (Proxmox Backup Server)
- Schedule: daily, retention 7 daily + 4 weekly + 2 monthly
- Mode: `snapshot` (kein Stop nötig)

### 5.2 Volume-Sync (selektiv, schneller restore-able)

```bash
# Auf der VM:
sudo rsync -aP --delete /var/lib/docker/volumes/claude-os_claude-os-data/_data/ \
  /mnt/backup-target/claude-os-data/
```

Per Cron (`crontab -e`):
```
30 3 * * * rsync -aP --delete /var/lib/docker/volumes/claude-os_claude-os-data/_data/ /mnt/backup-target/claude-os-data/
```

### 5.3 Was im Volume liegt

| Pfad | Inhalt |
|---|---|
| `/data/vault/` | dein Obsidian-Vault (Memory-Layer) |
| `/data/config/` | Catalog-Lock, Encrypted-Secrets-File, Audit-Log |
| `/data/anthropic/` | Anthropic-CLI-Credentials (`.credentials.json`) |

**Wichtig:** `CLAUDE_OS_AUTH_TOKEN` + `CLAUDE_OS_SECRETS_PASSPHRASE` aus `.env` sind **nicht** im Volume — sind in Container-Env. Wenn du beides verlierst, ist der `EncryptedFileStore` unentschlüsselbar. Backup beider Werte in deinem Passwortmanager ist Pflicht.

---

## MSP-Health-Bridges konfigurieren

Das MSP-Cockpit pollt Kundensysteme read-only und zeigt sie admin-gated im Dashboard (`/msp-health`). Eine Bridge wird registriert, sobald **(a)** mindestens ein Kunde sie in `customer.yaml` referenziert **und** **(b)** die zugehörigen Secrets/ENV gesetzt sind. Voraussetzung: Admin-Email-Allowlist (siehe §"Admin-Email-Allowlist setzen").

### Pro-Bridge: ENV + Secrets

| Bridge | ENV (in `.env`) | Secrets (`claude-os secrets set …`) | customer.yaml `bridges.<kind>` |
|---|---|---|---|
| **NinjaOne** | `CLAUDE_OS_NINJA_BASE_URL` (Default `https://eu.ninjarmm.com`; sonst `app`/`oc`) | `ninja/clientId`, `ninja/clientSecret` (OAuth-Client-App, Scope **Monitoring**) | `ninja: { organizationId: <int> }` |
| **TANSS** | `CLAUDE_OS_TANSS_SERVER_URL`, optional `CLAUDE_OS_TANSS_API_BASE` (Default `/api/v1`; manche Installs `/backend/api/v1`) | `tanss/apiToken` | `tanss: { customerId: <int> }` |
| **Veeam** | optional `CLAUDE_OS_VEEAM_INSECURE_TLS=1` (self-signed VBR) | `veeam/<host>/username`, `veeam/<host>/password` | `veeam: { serverHostname, serverPort?, jobNames? }` |
| **Sophos** | optional `CLAUDE_OS_SOPHOS_INSECURE_TLS=1` | `sophos/<host>/username`, `sophos/<host>/password` | `sophos: { firewallHostname, firewallPort? }` |
| **Securepoint** | optional `CLAUDE_OS_SECUREPOINT_BASE_URL` | `securepoint/apiKey` | `securepoint: { deviceId }` |

Secrets im laufenden Container setzen (EncryptedFileStore braucht `CLAUDE_OS_SECRETS_PASSPHRASE` aus `.env`):

```bash
docker exec -it claude-os claude-os secrets set ninja/clientId <client-id>
docker exec -it claude-os claude-os secrets set ninja/clientSecret <client-secret>
```

### NinjaOne — Schritt für Schritt

1. **OAuth-Client-App** in NinjaOne anlegen: Administration → Apps → API → Client app IDs → Add. Grant **Client Credentials**, Scope **Monitoring** (read-only). client_id + client_secret notieren.
2. ENV in `.env`: `CLAUDE_OS_NINJA_BASE_URL=https://eu.ninjarmm.com` (Region anpassen).
3. Secrets setzen (siehe oben).
4. **Organization-ID** je Kunde ermitteln und in dessen `customer.yaml` eintragen:
   ```yaml
   bridges:
     ninja:
       organizationId: 3   # aus GET /v2/organizations
   ```
5. Container neu erstellen (ENV-Änderungen brauchen Recreate): `docker compose up -d --force-recreate`.
6. **Probe** als Connectivity-Check:
   ```bash
   docker exec claude-os claude-os msp probe ninja <customer-slug> --json
   # erwartet: result.kind=ok, data.deviceCount / offlineCount / alertCount / actionableAlertCount
   ```
   `claude-os doctor` zeigt zudem die Zeile `ninja-config` (ok/warn).

> Hinweis: `alertCount` zählt alle aktiven Conditions; `actionableAlertCount` nur die mit `severity != NONE` (NinjaOne emittiert viele NONE-Conditions wie Patch-Reminder — das wäre sonst Rauschen).

### Automations-Regeln (optional)

Die deterministische Engine lädt YAML-Regeln aus `<vault>/Claude-OS/automation/rules/*.yaml` und feuert bei Status-Wechseln Aktionen (v1: `dashboard-alert`/`notify`/`audit-log` — kein autonomer Write). Ansicht: `/automation` (admin-gated). Details: `tasks/phase-msp-cockpit.md`.

---

## Update

```bash
cd /opt/claude-os
docker compose pull
docker compose up -d
docker compose logs -f claude-os
```

Bei Build-from-Source:
```bash
git pull
docker compose build
docker compose up -d
```

Vor jedem Update wird ein Proxmox-Snapshot empfohlen (Backup-Job läuft täglich ohnehin).

---

## Troubleshooting

### Container startet nicht — "$CLAUDE_OS_AUTH_TOKEN is required"

`.env`-Datei fehlt oder ist leer. Prüfen:
```bash
cat .env
docker compose config | grep CLAUDE_OS_AUTH_TOKEN
```

### Container läuft, aber Browser zeigt nichts

```bash
# 1) Container hört?
docker compose logs claude-os | tail -20
# Erwartet: "server: listening at http://0.0.0.0:3000"

# 2) Healthz im Container?
docker exec claude-os wget -qO- http://127.0.0.1:3000/healthz

# 3) Hostport reachable?
curl -v http://<VM-IP>:3000/healthz

# 4) Reverse-Proxy/Cloudflare-Layer prüfen
curl -v https://claude-os.deinedomain.tld/healthz
```

### Login schlägt fehl — Token wird abgelehnt

```bash
# Token im Container und im Browser müssen identisch sein:
docker exec claude-os printenv CLAUDE_OS_AUTH_TOKEN
# → vergleiche mit dem Wert in deinem Passwortmanager
```

Bei Token-Verlust: in `.env` neuen Wert eintragen, `docker compose up -d` (recreated den Container).

### Anthropic-Login erscheint nicht im Container

```bash
# Hat das Volume die richtigen Rechte?
docker exec claude-os ls -la /data/anthropic
# Wenn leer / read-only: Volume-Mount-Check
docker compose config | grep -A3 volumes
```

### SSE-Verbindungen brechen alle 100s ab (Cloudflare)

Cloudflare-Proxy hat ein 100s-Idle-Timeout. Unser Heartbeat ist standardmäßig 30s — bleibt unter dem Limit. Wenn doch Probleme: in der Cloudflare Network-Tab "WebSockets" und ggf. "gRPC" einschalten. Bei Tunnel-Setup ist es seltener ein Problem.

### Vault-Schreibrechte im Container

Default-Volume `local` ist von root owned, der Container läuft als root → no issues. Wenn du UID-Mapping konfigurierst, muss der Container-User Write-Rechte auf `/data` haben.

### Logs einsehen

```bash
docker compose logs -f --tail=100 claude-os
# JSON-Lines via pino. Mit jq formatieren:
docker compose logs claude-os | grep '{' | jq -c '{level, msg, time}'
```

---

## Häufige Stolperfallen (aus realen Deployments)

### "Web server is down" (Cloudflare 521)

Cloudflare erreicht deinen Origin nicht. Reihenfolge zum Eingrenzen:

1. **Container hört auf falschem Interface?** — `ss -tlnp | grep 3000` muss `0.0.0.0:3000` zeigen, nicht `127.0.0.1:3000`. Wenn `127.0.0.1`: in `docker-compose.yml` `ports: ["3000:3000"]` setzen (NICHT `"127.0.0.1:3000:3000"`), dann `docker compose up -d`.
2. **OPNsense-Port-Forward fehlt** für :443 zur Reverse-Proxy-IP.
3. **Firewall in der VM** blockt :3000 (`ufw status`, ggf. `ufw allow from <reverse-proxy-IP> to any port 3000`).
4. **Reverse-Proxy hat falsche Forward-IP**: muss die LAN-IP der claude-os-VM sein, NICHT die Docker-Container-IP (`172.x.x.x`).

### WebSocket-PTY funktioniert nicht im Browser (`ws errored before frame could be sent`)

Phase Web-3 nutzt einen WebSocket unter `/api/pty/ws`. nginx proxy manager
forwarded WS-Upgrades **nur am Top-Level der Proxy Host Location**, nicht
automatisch an Sub-Paths. Symptom: `/chat` zeigt "Spawn" reagiert nicht,
DevTools-Network zeigt failed WebSocket-Connection.

Fix:
1. NPM → Hosts → Proxy Hosts → claude-os-Eintrag → Edit
2. Details-Tab: **"Websockets Support" ON** (das ist der Schalter der die
   nginx `proxy_set_header Upgrade $http_upgrade` etc. global aktiviert)
3. Custom Locations Tab → **Add location** mit:
   - Location: `/api/pty/ws`
   - Scheme: `http`, Forward: `<VM-IP>:3000`
   - **Custom Nginx Configuration LEER LASSEN** — eigene `proxy_set_header`-
     Direktiven kollidieren mit den NPM-internen und brechen die config
     (Cloudflare 525, nginx -t fail).
4. Save

Verify auf der NPM-Box:
```bash
TOKEN=$(docker exec claude-os printenv CLAUDE_OS_AUTH_TOKEN)
curl --http1.1 -ik -N \
  --resolve <hostname>:443:127.0.0.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "https://<hostname>/api/pty/ws?token=$TOKEN"
```

Erwartet: `HTTP/1.1 101 Switching Protocols`.

Cloudflare WebSocket-Support ist standardmäßig an (Network → WebSockets).

### "SSL handshake failed" (Cloudflare 525)

Cloudflare verbindet sich zum Origin, aber kein TLS-Handshake. Meistens:

1. **Domain-Name-Tippfehler im Proxy Host** — Hostname im nginx-pm Proxy Host muss exakt dem Cloudflare-DNS-Record entsprechen (Bindestrich, Subdomain). Prüfen via:
   ```bash
   openssl s_client -connect 127.0.0.1:443 -servername deine-domain.tld </dev/null 2>&1 | grep -E "subject|unrecognized"
   ```
   Bei `unrecognized name`: Hostname-Mismatch.
2. **Cert nicht assigned** im Proxy Host SSL-Tab. nach Save in der Liste prüfen — SSL-Spalte muss den Cert-Namen zeigen, nicht "None".
3. **Cert für falsche Domain ausgestellt**: Cloudflare-Origin-Cert muss exakt für die genutzte Subdomain ausgestellt sein. Wildcard `*.deinedomain.tld` deckt alle Subdomains ab.

### "Could not resolve claude-os root" (Container exit 1, restart-loop)

`resolveRoot()` findet keine `.claude-os-root`-Marker-Datei.
Fix ist seit Commit `41cc8a0` im Container automatisch: entrypoint.sh setzt `CLAUDE_OS_ROOT=/data` und legt den Marker an. Wer einen älteren Container hat: `docker compose pull && docker compose up -d`.

### Debian-13-Trixie-Minimal: `curl` und `ufw` fehlen

```bash
apt install -y curl ca-certificates gnupg ufw
```

Vor der Docker-Install. `ufw` ist optional wenn du hinter einer Hardware-Firewall (OPNsense) sitzt.

### `sudo` ohne `-i` lässt User-PATH stehen

Wenn `which ufw` leer ist nach erfolgreichem `apt install ufw`:
```bash
echo $PATH
# Wenn /usr/sbin fehlt:
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Persistent:
echo 'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' >> /root/.bashrc
```

Oder von vornherein mit `sudo -i` einsteigen (Login-Shell mit korrektem Root-PATH).

## Sicherheits-Hinweise

- **Token-Rotation:** bei Verdacht auf Compromise: `.env` ändern, `docker compose up -d`. Alle aktiven Browser-Sessions verlieren ihre Auth → Re-Login.
- **Network-Layer:** Cloudflare proxied (3.B) oder Tunnel (3.C) sind sicherer als direktes Port-Exposing.
- **Token-Logging:** das Token landet bei `?token=...` für SSE in nginx-Access-Logs. Mitigation: Token regelmäßig rotieren, oder die SSE-Connection via WebSocket-Upgrade umgehen (Phase Web-3+).
- **Backup-Geheimnisse:** `CLAUDE_OS_SECRETS_PASSPHRASE` darf nie verloren gehen. Im Passwortmanager + auf einem zweiten Medium ablegen.
- **Updates:** der Image-Tag `:latest` wird durch CI/CD aktualisiert. Pinning auf `:v1.x.y` ist vorgesehen, sobald die erste Server-Variante geshipped ist.

---

## Multi-User mit Email-Login (Stage 2 per ADR-0036)

Seit Phase Web-7 unterstützt Claude-OS zwei Authentifizierungs-Modi **parallel**:

| Modus | Setup | Zielgruppe |
|---|---|---|
| **Bearer-Token** (Stage 1, ADR-0033) | `CLAUDE_OS_AUTH_TOKEN` als CSV in `.env` | Service-Tokens, CLI/CI, Power-User |
| **Email + Passwort** (Stage 2, ADR-0036) | `users.sqlite` + Login-Form im Browser | Reguläre Browser-User, Multi-User-Setup |

Stage 2 ist **opt-in**. Ohne `users.sqlite` und ohne `MultiUserConfig` läuft der Server exakt wie ADR-0033 Stage 1.

### Schritt 1 — Erste User via Admin-CLI anlegen

Auf dem Server-Host (Container muss **gestoppt** sein, sql.js ist single-writer):

```bash
docker compose stop claude-os
docker compose run --rm claude-os claude-os users create \
    --email alice@example.com \
    --password 'long-passphrase-12-or-more'

# Optional: shared-tenant via override (Family-Account)
docker compose run --rm claude-os claude-os users create \
    --email family@example.com \
    --password 'shared-secret-long' \
    --tenant-override shared-fam

docker compose run --rm claude-os claude-os users list
docker compose start claude-os
```

Weitere Admin-Subcommands: `users disable <id-or-email>`, `users enable …`, `users reset-password … [--password <p> | --random]`, `users sessions list [--user …]`, `users sessions revoke <id>`.

### Schritt 1.5 — Admin-Email-Allowlist setzen (für Web-UI Admin-Pages)

Damit du im Browser die Admin-Pages (**MSP Health**, **Audit-Log**, **/api/admin/users**) zu sehen bekommst, muss deine Login-Email in `CLAUDE_OS_ADMIN_EMAILS` stehen — sonst zeigt das Frontend `isAdmin: false` und versteckt die Nav-Entries.

Trage in `.env` neben dem Server-Host folgende Zeile ein (kommagetrennt bei mehreren Admins, exakt die Email aus `users create`):

```env
CLAUDE_OS_ADMIN_EMAILS=alice@example.com
# Mehrere: CLAUDE_OS_ADMIN_EMAILS=alice@example.com,bob@example.com
```

Container neu erstellen (Env-Änderungen brauchen Recreate, nicht nur Restart):

```bash
docker compose up -d --force-recreate
```

**Verify** im Browser an `/api/auth/me` — muss `"isAdmin": true` returnen. Falls noch `false`:

```bash
# Sieht der Container die env-Variable?
docker compose exec claude-os env | grep CLAUDE_OS_ADMIN_EMAILS
# Erwartet: CLAUDE_OS_ADMIN_EMAILS=alice@example.com  (nicht leer!)
```

Häufige Stolperfallen:
- `.env`-Zeile mit `=` aber ohne Wert (`CLAUDE_OS_ADMIN_EMAILS=`) → Container bekommt leere Variable → niemand ist Admin
- `docker compose up -d` ohne `--force-recreate` → derselbe Container wird reused, env wird nicht neu eingelesen
- Browser-Session ist alt → nach Recreate **Logout + Login** im Browser, dann erscheinen die Admin-Nav-Entries

Match ist case-insensitive + getrimmt. Email muss **exakt** mit der aus `users create` matchen.

### Schritt 2 — Browser-Login

Öffne `https://<deine-domain>/login`. Tab **"Email + Passwort"** ist Default. Bei Submit:

1. Server prüft scrypt-Hash via `timingSafeEqual`
2. Setzt HTTP-only Session-Cookie + readbare CSRF-Cookie
3. Frontend speichert Cookie-Auth-Flag in sessionStorage → AuthGate flippt auf "authed"
4. Bei Page-Reload bleibst du eingeloggt (Browser sendet die Session-Cookie automatisch)

Profile-Drawer (Sidebar, klick auf Email) hat Logout + "Passwort ändern". Beim Passwort-Wechsel werden alle anderen Sessions des Users automatisch revoked (Defence-in-Depth).

### Schritt 3 — Optional: Self-Registration

```yaml
# docker-compose.yml
environment:
  - CLAUDE_OS_ALLOW_REGISTRATION=1
```

Dann erscheint im Login-Form ein "Registrieren"-Link. Rate-Limit: 3 Registrierungen / IP / Stunde.

**WARNUNG:** Niemals mit `ALLOW_REGISTRATION=1` direkt am offenen Internet betreiben. Schutzschichten:

- **Cloudflare Access** (zero-trust SSO vor dem Login)
- **WireGuard / Tailscale / Cloudflare Tunnel** (gar kein offener Port nach außen)
- **OPNsense IP-Whitelist** auf die nginx-proxy-manager-Regel

### Migrations-Pfad: Stage 1 → Stage 2

Beide Modi laufen parallel. Stage-1-Token-Clients merken nichts vom Stage-2-Rollout. Empfohlener Übergang:

1. **Tag 0:** Server läuft Stage-1-only. Yannik nutzt seinen Token im Browser.
2. **Tag 1:** Admin legt Email-Account an via CLI. Email-Login wird parallel zum Token getestet.
3. **Tag 7:** Token bleibt nur für CLI/CI. Browser-User wechseln auf Email.

### Backup-Erweiterung

`users.sqlite` lebt in `<dataDir>` (default `/data/users.sqlite` im Container). Backup-Plan muss es einschließen:

- Proxmox-VM-Snapshot deckt es automatisch
- rsync-Pull-Script: zusätzlich `/data/users.sqlite` ins Backup-Volume
- Restore: Datei zurückkopieren → Server-Restart, fertig

`users.sqlite` enthält scrypt-Hashes — kein Plaintext-Risiko. Trotzdem wie Secrets behandeln (file-mode `0o600` POSIX automatisch gesetzt).

### Sessions-Caveat

Session-Cookies leben aktuell **nur in Prozess-Memory** (in-memory LRU, default 1000 entries, 30-Tage-sliding-TTL). Container-Restart = alle eingeloggten User müssen erneut Login. Opt-in persistent ist `$CLAUDE_OS_SESSION_PERSIST=1` (Phase-Web-7-tail) — schreibt zusätzlich in `users.sqlite`.

Der CLI-`users sessions list / revoke` sieht eine FRISCHE empty Session-Repository, NICHT die vom laufenden Server. Wird mit explizitem Warning ausgegeben.

## Weiter

- **Phase Web-3** ✓ shipped: Chat/PTY-Streaming via WebSocket
- **Phase Web-7** ✓ shipped (ADR-0036): Multi-User Email/Passwort + Sessions + Profile-Drawer + Admin-CLI
- **Phase Web-8** (folgt): OAuth-Provider (GitHub/Google), persistent Rate-Store, Password-Reset via SMTP
- **Phase Web-9** (folgt): Per-User-Vault-FS-Isolation (`vault/users/<id>/`)

Fragen, Bugs, Wünsche → GitHub-Issues im Repo.
