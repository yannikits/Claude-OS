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

echo "[3/4] pkg target=$pkg_target triple=$triple"
echo "[4/4] writing $out_bin"
npx --yes @yao-pkg/pkg@latest "$entry" --target "$pkg_target" --output "$out_bin"

if command -v stat >/dev/null 2>&1; then
  size_bytes=$(stat -c%s "$out_bin" 2>/dev/null || stat -f%z "$out_bin")
  size_mb=$(( size_bytes / 1048576 ))
  echo "[OK] sidecar built: $out_bin (${size_mb} MB)"
else
  echo "[OK] sidecar built: $out_bin"
fi
