# claude-os GUI (Phase 6)

Tauri-2-Desktop-Shell für claude-os.

## Voraussetzungen

- Node ≥ 20 (gleicher Stack wie das CLI-Projekt)
- Rust-Toolchain via [rustup](https://rustup.rs/)
- Plattform-spezifisch:
  - Windows: Visual Studio 2022 Build Tools mit C++-Workload
  - macOS: Xcode CLI Tools (`xcode-select --install`)
  - Linux: `libwebkit2gtk-4.1-dev`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `xdotool`

## Verifikation (Phase 6a)

```powershell
cd gui\src-tauri
cargo check
```

`cargo check` validiert dass die Rust-Shell-Sources kompilieren ohne die volle Binary zu linken. Erster Lauf nach rustup-Install lädt Tauri + Transitive-Crates (~300 MB Cargo-Cache, ~3-5 min).

## Sub-Phasen-Status

| Sub-Phase | Inhalt | Status |
|-----------|--------|--------|
| 6a | Tauri-Rust-Shell-Scaffold | shipped |
| 6b | Sidecar-Binary-Build-Script (`$TARGET_TRIPLE`) | shipped |
| 6c | JSON-RPC-Bridge (Rust + Node) | shipped |
| 6d | Sidecar-Lifecycle + Health-Check | shipped |
| 6e | Vite + React + TS Frontend | shipped |
| 6f | 7 Views (4 wired, 3 stubs) | shipped |
| 6g | Drag-Drop + inbox/outbox Watcher | shipped |
| 6h | Bundling (MSI/DMG/AppImage) + E2E | shipped |

## Sidecar bauen (Phase 6b)

```powershell
npm run sidecar:build
```

Wrappt `scripts/build-sidecar.{ps1,sh}` plattform-bewusst. Schritte:

1. `npm run build` → frische `dist/cli/index.js`
2. `rustc -Vv` → host-triple (Hoppscotch-Pattern)
3. Triple → pkg-target (z.B. `x86_64-pc-windows-msvc` → `node24-win-x64`)
4. `npx @yao-pkg/pkg dist/cli/index.js --target ... --output gui/src-tauri/binaries/claude-os-sidecar-<TRIPLE>.exe`

Output landet unter `gui/src-tauri/binaries/` mit Triple-Suffix, der Tauris `bundle.externalBin` Auto-Discovery erlaubt.

### Native-Module-Caveat

`@napi-rs/keyring` (Phase 3d Secrets-Store) hat `.node`-Bindings, die `pkg` nicht in den V8-Snapshot embedded. Mitigation: Sidecar setzt `CLAUDE_OS_SECRETS_BACKEND=file` (Force `EncryptedFileStore`-Fallback) — keyring-API umgangen. Wird in Phase 6d beim Sidecar-Spawn als Env-Var injiziert. Alternative (später): `--public-packages "@napi-rs/keyring"` + `.node`-Files neben dem Binary ausliefern. Für v1 ist der File-Fallback sauber & ausreichend.

## Bundle bauen (Phase 6h)

```powershell
# 1. Sidecar binary (im Repo-Root)
npm run sidecar:build

# 2. Tauri bundle (Win MSI / macOS DMG / Linux AppImage)
cd gui
npm install
npm run tauri:build
```

`tauri:build` führt `npm run build` (Vite → `gui/dist/`) und `cargo build --release` aus, dann packt die Plattform-spezifische Installer. Output unter `gui/src-tauri/target/release/bundle/`.

### Icons regenerieren

```powershell
npx tauri icon src-tauri/icons/source.png
```

`source.png` (512×512, brand-color background mit "C") wird zu allen Platform-Variants expanded (32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico, Square*Logo.png) und in `src-tauri/icons/` geschrieben.

### Verifikation

- `cargo check` (rustup vorausgesetzt)
- `cargo test` (6 supervisor-tests + 2 DropDedup-tests)
- Vom Repo-Root: `RUN_SLOW_TESTS=1 npx vitest run tests/sidecar/restart.e2e.test.ts` (real `node dist/sidecar/index.js`, ping → stop → respawn → ping, asserts ≤5s)

## macOS DMG-Installation

Der DMG-Build ist in v1.x **noch nicht signiert/notarisiert** — Gatekeeper
blockt den ersten Start. Workarounds (xattr-Cleanup, Right-Click→Open) sind
in [`../docs/macos-gatekeeper.md`](../docs/macos-gatekeeper.md) dokumentiert.
Signing kommt mit v1.3+ sobald ein Apple-Developer-Account verfügbar ist.
