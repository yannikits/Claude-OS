#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

echo "[1/4] npm run build"
npm run build

entry="$repo_root/dist/sidecar/index.js"
[[ -f "$entry" ]] || { echo "dist/sidecar/index.js missing after build" >&2; exit 1; }

echo "[2/4] resolving target triple"
if [[ -n "${SIDECAR_TRIPLE:-}" ]]; then
  triple="$SIDECAR_TRIPLE"
  echo "  using SIDECAR_TRIPLE override: $triple"
else
  if ! command -v rustc >/dev/null 2>&1; then
    echo "rustc not found; install rustup first, or set SIDECAR_TRIPLE env-var" >&2
    exit 1
  fi
  triple="$(rustc -Vv | sed -n 's/^host:[[:space:]]*//p' | tr -d '[:space:]')"
  [[ -n "$triple" ]] || { echo "Could not parse host triple from rustc -Vv" >&2; exit 1; }
fi

node_major="$(node --version | sed 's/^v\([0-9]*\)\..*/\1/')"
ext=""
case "$triple" in
  x86_64-pc-windows*)      pkg_target="node${node_major}-win-x64";    ext=".exe" ;;
  aarch64-pc-windows*)     pkg_target="node${node_major}-win-arm64";  ext=".exe" ;;
  x86_64-apple-darwin)     pkg_target="node${node_major}-macos-x64" ;;
  aarch64-apple-darwin)    pkg_target="node${node_major}-macos-arm64" ;;
  x86_64-unknown-linux*)   pkg_target="node${node_major}-linux-x64" ;;
  aarch64-unknown-linux*)  pkg_target="node${node_major}-linux-arm64" ;;
  *) echo "Unsupported triple: $triple" >&2; exit 1 ;;
esac

out_dir="$repo_root/gui/src-tauri/binaries"
mkdir -p "$out_dir"
out_bin="$out_dir/claude-os-sidecar-$triple$ext"

echo "[3/5] pkg target=$pkg_target triple=$triple"
echo "[4/5] writing $out_bin"
npx --yes @yao-pkg/pkg@latest "$entry" --target "$pkg_target" --output "$out_bin"

if command -v stat >/dev/null 2>&1; then
  size_bytes=$(stat -c%s "$out_bin" 2>/dev/null || stat -f%z "$out_bin")
  size_mb=$(( size_bytes / 1048576 ))
  echo "[OK] sidecar built: $out_bin (${size_mb} MB)"
else
  echo "[OK] sidecar built: $out_bin"
fi

# [5/5] node-pty sideload als komplettes Package neben den Sidecar.
# pkg bundlet `createRequire(import.meta.url).require()` NICHT statisch,
# und Native-Module funktionieren ohnehin nicht im Snapshot. Wir shippen
# daher `node-pty/` als ganzes Package. pty-binding-loader.ts resolved
# via `dirname(process.execPath) + '/node-pty'` — Tauri's
# bundle.resources copy's `binaries/node-pty/**` ins App-Resource-Dir.
echo "[5/5] sideloading node-pty package"
case "$triple" in
  x86_64-pc-windows*)      node_arch="win32-x64" ;;
  aarch64-pc-windows*)     node_arch="win32-arm64" ;;
  x86_64-apple-darwin)     node_arch="darwin-x64" ;;
  aarch64-apple-darwin)    node_arch="darwin-arm64" ;;
  x86_64-unknown-linux*)   node_arch="linux-x64" ;;
  aarch64-unknown-linux*)  node_arch="linux-arm64" ;;
  *) echo "  WARN: keine node-pty arch-Map fuer $triple — skipping sideload"; exit 0 ;;
esac

sideload_dir="$out_dir/node-pty"
rm -rf "$sideload_dir"
mkdir -p "$sideload_dir"

src="$repo_root/node_modules/node-pty"
[[ -d "$src" ]] || { echo "node-pty: $src missing. Run 'npm install' first." >&2; exit 1; }

# Copy package.json + lib/
cp "$src/package.json" "$sideload_dir/package.json"
cp -R "$src/lib" "$sideload_dir/lib"

# Copy prebuild fuer DIESEN arch (host) — andere arches sparen ~50MB
# Bundle-Size. Strippen `.pdb` (Win debug-symbols ~30MB).
prebuild_src="$src/prebuilds/$node_arch"
prebuild_dst="$sideload_dir/prebuilds/$node_arch"
release_src="$src/build/Release"

if [[ -d "$prebuild_src" ]]; then
  echo "  prebuild source: $prebuild_src"
  mkdir -p "$prebuild_dst"
  (cd "$prebuild_src" && find . -type f ! -name '*.pdb' -print0 | while IFS= read -r -d '' f; do
    dest="$prebuild_dst/$f"
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
  done)
elif [[ -d "$release_src" ]]; then
  # Linux: kein prebuild — npm install hat source-build ausgefuehrt
  echo "  source-build artifacts: $release_src"
  release_dst="$sideload_dir/build/Release"
  mkdir -p "$release_dst"
  for f in "$release_src"/pty.node "$release_src"/spawn-helper; do
    [[ -e "$f" ]] && cp "$f" "$release_dst/"
  done
else
  echo "node-pty: weder prebuild ($prebuild_src) noch build/Release ($release_src) gefunden." >&2
  exit 1
fi

if command -v du >/dev/null 2>&1; then
  echo "[OK] node-pty sideloaded: $sideload_dir ($(du -sh "$sideload_dir" | cut -f1))"
else
  echo "[OK] node-pty sideloaded: $sideload_dir"
fi
