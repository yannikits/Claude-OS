# Tauri-Updater Setup (Phase 8, ADR-0028)

Auto-update für Windows + macOS basiert auf dem [Tauri-Updater-Plugin](https://v2.tauri.app/plugin/updater/). Linux nutzt zsync per AppImage (ADR-0018) — separate Doku.

Das Plugin ist **inaktiv per default** im Repo (`tauri.conf.json` → `plugins.updater.active=false`). Dev-Builds und CI-Bundles pingen keinen Endpoint. Wer Auto-Update in einem Fork aktivieren will, braucht einen eigenen Signing-Keypair.

## Voraussetzungen

- `@tauri-apps/cli` ≥ 2.11 (im Repo `gui/package.json` als devDep)
- Schreibrechte auf einen sicheren Pfad für den Private-Key (NICHT im Repo)

## 1. Signing-Keypair generieren

```bash
# Im claude-os Repo-Root:
npx tauri signer generate -w ~/.tauri/claude-os.key
```

Output:

- `~/.tauri/claude-os.key` — Ed25519 **Private**-Key, Base64-encoded mit Passphrase
- `~/.tauri/claude-os.key.pub` — Ed25519 **Public**-Key

Der Private-Key gehört in einen OS-Keychain-Slot ODER eine GitHub-Repo-Secret (`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). **Niemals committen.**

## 2. Public-Key in `tauri.conf.json` einsetzen

```jsonc
// gui/src-tauri/tauri.conf.json
{
  "plugins": {
    "updater": {
      "active": true,              // ← flip true
      "endpoints": [
        "https://github.com/<owner>/<repo>/releases/latest/download/latest.json"
      ],
      "pubkey": "<INHALT VON ~/.tauri/claude-os.key.pub>",
      "dialog": false,             // false → app rendert eigene UI via gui/src/lib/updater.ts
      "windows": {
        "installMode": "passive"   // MSI im Hintergrund + App-Quit
      }
    }
  }
}
```

## 3. Update-Manifest + Signaturen beim Release hochladen

Tauri-Updater erwartet im Release-Asset eine JSON-Datei `latest.json` mit dieser Form:

```json
{
  "version": "1.6.0",
  "notes": "Phase 8 GUI Polish + Auto-Update.",
  "pub_date": "2026-06-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<INHALT VON claude-os_1.6.0_x64_en-US.msi.sig>",
      "url": "https://github.com/<owner>/<repo>/releases/download/v1.6.0/claude-os_1.6.0_x64_en-US.msi"
    },
    "darwin-aarch64": {
      "signature": "<INHALT VON claude-os.app.tar.gz.sig>",
      "url": "https://github.com/<owner>/<repo>/releases/download/v1.6.0/claude-os.app.tar.gz"
    }
  }
}
```

Die `.sig`-Files werden vom `tauri build` automatisch generiert wenn `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` als env-vars gesetzt sind. Beispiel in CI:

```yaml
- name: Build tauri bundle (signed)
  env:
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  run: npm --prefix gui run tauri:build
```

Den `latest.json`-Generator könnt ihr mit einem kleinen Node-Skript bauen (siehe `tauri-action`'s offizielles Beispiel) oder die `.sig`-Files inline in der Workflow-Step zusammenfügen.

## 4. App-Side: Update-Check + Install

`gui/src/lib/updater.ts` shipped als Foundation:

```ts
import { checkForUpdate, installUpdate } from './lib/updater';

const outcome = await checkForUpdate();
if (outcome.available && outcome.update) {
  console.info(`Update ${outcome.version} verfügbar: ${outcome.notes}`);
  // Optional UX: Banner zeigen, "Jetzt installieren"-Button rendern
  await installUpdate(outcome.update);
}
```

`installMode: "passive"` quittet die App während die Installation läuft — caller sollte in-flight-work draining vor dem Aufruf (z. B. `memoryIndexService.flush()` analog Sidecar-shutdown).

## 5. macOS-Signing (zusätzlich)

Tauri-Updater verifiziert nur die App-internen Updates — Gatekeeper auf macOS verlangt eine separate Apple-Developer-Signatur. Solange [`docs/macos-gatekeeper.md`](./macos-gatekeeper.md) "noch nicht signed" sagt, ist macOS-Auto-Update nur intern brauchbar (User braucht xattr-cleanup pro Update). Apple-Notarisierung ist v1.x-Track.

## 6. Linux

Linux nutzt **nicht** dieses Plugin. AppImage-zsync (ADR-0018) ist der separate Pfad — eigene Doku folgt.

## Out of scope für die Phase-8-Foundation

- Die GitHub-Release-pipeline (`tauri-bundle.yml`) wird in einem **Folge-PR** erweitert um `TAURI_SIGNING_*` env-injection + `latest.json`-Generator.
- Tray-Integration (System-tray-icon + menu) — separater Phase-8-Schritt.
- macOS-Signing-Workflow — separat sobald Apple-Developer-Account verfügbar.