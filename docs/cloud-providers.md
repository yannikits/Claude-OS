# Cloud-Provider Setup

claude-os ist provider-agnostisch — alles was als lokales Verzeichnis erscheint und vom OS als regulärer Pfad gemountet ist, funktioniert. Der Vault, die Configs, Skills und Plugin-Manifeste leben dort; per-Machine-Daten (Git-Metadaten, Indizes, Logs, Secrets) bleiben pro Maschine außerhalb (siehe [ADR-0002](architecture/adr/0002-cloud-mount-data-placement.md)).

Diese Doc zeigt für jeden gängigen Provider den Setup-Pfad + bekannte Stolpersteine.

## Was claude-os vom Provider erwartet

- Pfad zum Mount, der in `$CLAUDE_OS_ROOT` (oder via `claude-os --root <pfad>`) gezeigt werden kann.
- `.claude-os-root` Marker-File schreibbar.
- File-by-File-Sync ist OK (Plain-Text + JSON-Lines im Mount sind gegen "wahllose Reihenfolge" tolerant). **Atomic-Lock-Operationen sind nicht erwartet** — deshalb keine SQLite oder `vault/.git/` im Mount.

`claude-os doctor` warnt automatisch wenn der Mount-Pfad wie ein typischer Cloud-Provider aussieht und Empfehlungen für die jeweilige Plattform ausstellt.

## OneDrive (Default, Windows + macOS)

Bevorzugter Provider für v1 (lt. ADR-0002 §15).

```text
$CLAUDE_OS_ROOT = C:\Users\<user>\OneDrive\claude-os
                 (oder ~/OneDrive/claude-os auf macOS)
```

Setup:

1. OneDrive-Client installieren (`winget install Microsoft.OneDrive`).
2. Anmelden, Sync aktivieren.
3. Im OneDrive-Root einen `claude-os/` Folder anlegen.
4. `claude-os doctor --init-marker` legt `.claude-os-root` an.

Bekannt-Stolpersteine:
- **Files-On-Demand** (Files lokal nicht materialisiert) kann ein `EBUSY` beim Lesen liefern. Im Doctor: Empfehlung "Always keep on this device" für `claude-os/`-Folder per Rechtsklick.
- **Long-Path-Limit (Windows)**: `git config --global core.longpaths true` — vom Doctor automatisch geprüft.

## Google Drive (Drive for Desktop)

```text
$CLAUDE_OS_ROOT = G:\My Drive\claude-os   (Windows)
                  ~/Google Drive/My Drive/claude-os  (macOS)
```

Setup:

1. [Google Drive for Desktop](https://www.google.com/drive/download/) installieren.
2. Streaming oder Mirroring? Für claude-os: **Mirroring** wählen — Streaming hat fragwürdiges Verhalten bei häufigen kleinen Schreib-Vorgängen (vault-sync snapshots).
3. `claude-os doctor` warnt wenn Streaming-Mode aktiv ist.

Bekannt-Stolpersteine:
- **Drive-Streaming**: virtuelles Dateisystem das schlechte Latenz auf häufige Reads/Writes hat. Auf Mirroring umschalten.
- **Reservierte Zeichen** (`:`, `?`, `*`, `<`, `>`, `|`) im Filename → Sync stoppt stillschweigend. claude-os snapshot-Filenames nutzen ISO-Timestamps mit Doppelpunkten → wir ersetzen `:` durch `-` (siehe Phase 2b lessons).

## Dropbox

```text
$CLAUDE_OS_ROOT = ~/Dropbox/claude-os
```

Setup:

1. Dropbox-Client installieren.
2. **Selective Sync** für `claude-os/` aktivieren (in Settings → Sync), damit der Folder nicht aus Versehen aus dem lokalen Cache verschwindet.
3. Smart Sync auf "Local" stellen.

Bekannt-Stolpersteine:
- **Lan Sync**: nutzt lokales Netz zur Beschleunigung — generell OK, kann aber bei Restart-Loops kuriose Race-Conditions auslösen. Nur bei reproduzierbaren Problemen deaktivieren.

## Nextcloud / ownCloud

```text
$CLAUDE_OS_ROOT = ~/Nextcloud/claude-os
```

Setup:

1. [Nextcloud Desktop](https://nextcloud.com/install/) installieren.
2. Bei Server anmelden.
3. **Virtual-File-System (VFS)** auf macOS/Windows: empfehlenswert deaktivieren für claude-os/ (gleiche Files-On-Demand-Stolperfalle wie OneDrive).

Vorteile: Self-hostable, keine US-Cloud-Provider-Compliance-Fragen. Nachteile: setup-Aufwand höher.

## rclone (cross-provider)

Für advanced Setups (Backblaze B2, AWS S3, Wasabi, etc.) oder wenn der proprietäre Client unbrauchbar ist.

```bash
rclone mount remote:claude-os ~/cloud/claude-os \
  --vfs-cache-mode writes \
  --vfs-write-back 10s \
  --buffer-size 32M \
  --daemon
```

Wichtig:
- `--vfs-cache-mode writes` (oder `full`): lokal cachen vor Upload — sonst latency-Probleme bei vault-snapshot.
- `--vfs-write-back 10s`: bündelt schnelle aufeinanderfolgende Writes.
- `--daemon`: läuft im Hintergrund. Auf systemd: als User-Service einrichten.

## abraunegg/onedrive (Linux)

Microsofts offizieller OneDrive-Client unterstützt Linux nicht. [abraunegg/onedrive](https://github.com/abraunegg/onedrive) ist die best-maintained Alternative.

```bash
sudo apt install onedrive
onedrive --synchronize --single-directory 'claude-os'
```

Als systemd-Unit (User-Service):

```bash
systemctl --user enable --now onedrive
```

Bekannt-Stolpersteine:
- Initial-Sync von großen Vaults kann mehrere Stunden dauern; danach inkrementell.
- `~/.config/onedrive/config` kann auf `monitor_interval = 60` (Default 300) reduziert werden für reaktiveres Sync.

## Lokal (kein Cloud)

Für Single-Machine-Setups oder Tests:

```text
$CLAUDE_OS_ROOT = ~/claude-os
```

Einfach Folder anlegen + Marker schreiben. Nichts wird synchronisiert. Sinnvoll für Dev-Setups oder Air-Gapped-Maschinen.

## Was claude-os pro Provider erkennt

`claude-os doctor` ruft intern `detectCloudProvider(rootPath)` auf — die Heuristik prüft Pfad-Substrings (`/OneDrive/`, `/Dropbox/`, `/Google Drive/`, etc.) und liefert ein optionales Hint-Banner. Detection ist nur informational; die volle Funktionalität läuft unabhängig vom Provider, solange der Mount ein regulärer FS-Pfad ist.
