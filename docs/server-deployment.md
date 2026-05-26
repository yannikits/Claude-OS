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

## Was du nicht bekommst (bewusst out-of-scope für Phase Web)

- Native Drag-and-Drop im Browser (Tauri-only)
- Live Chat-PTY-Streaming im Browser (kommt in Phase Web-3)
- Multi-User-Login mit Registrierung (siehe ADR-0032 §"Out-of-Scope")
- MSP-Bridges (TANSS/Ninja/Veeam) — leben im privaten `claude-os-msp`-Repo

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

## Sicherheits-Hinweise

- **Token-Rotation:** bei Verdacht auf Compromise: `.env` ändern, `docker compose up -d`. Alle aktiven Browser-Sessions verlieren ihre Auth → Re-Login.
- **Network-Layer:** Cloudflare proxied (3.B) oder Tunnel (3.C) sind sicherer als direktes Port-Exposing.
- **Token-Logging:** das Token landet bei `?token=...` für SSE in nginx-Access-Logs. Mitigation: Token regelmäßig rotieren, oder die SSE-Connection via WebSocket-Upgrade umgehen (Phase Web-3+).
- **Backup-Geheimnisse:** `CLAUDE_OS_SECRETS_PASSPHRASE` darf nie verloren gehen. Im Passwortmanager + auf einem zweiten Medium ablegen.
- **Updates:** der Image-Tag `:latest` wird durch CI/CD aktualisiert. Pinning auf `:v1.x.y` ist vorgesehen, sobald die erste Server-Variante geshipped ist.

---

## Weiter

- **Phase Web-3** (folgt): Chat/PTY-Streaming via WebSocket — interaktive Claude-Sessions im Browser
- **Phase Multi-User** (späterer ADR): mehrere User mit pro-User-Workspace-Isolation
- **MSP-Customer-Workspace via Server**: konzeptuell vorbereitet via `tenant`-Domain, Auth-Layer-Erweiterung nötig

Fragen, Bugs, Wünsche → GitHub-Issues im Repo.
