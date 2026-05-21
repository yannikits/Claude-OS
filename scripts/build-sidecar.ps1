#Requires -Version 7
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path "$PSScriptRoot\.."
Push-Location $repoRoot
try {
    Write-Host "[1/4] npm run build"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

    $entry = Join-Path $repoRoot "dist\sidecar\index.js"
    if (-not (Test-Path $entry)) {
        throw "dist/sidecar/index.js missing after build"
    }

    Write-Host "[2/4] resolving target triple"
    if ($env:SIDECAR_TRIPLE) {
        $triple = $env:SIDECAR_TRIPLE
        Write-Host "  using SIDECAR_TRIPLE override: $triple"
    } else {
        $rustcCmd = Get-Command rustc -ErrorAction SilentlyContinue
        if ($null -eq $rustcCmd) {
            # Rust nicht installiert — Fallback auf platform-based Default.
            # Sidecar-Build allein braucht Rust nicht, aber tauri:build danach
            # schon. Wir warnen + machen weiter mit dem haeufigsten Triple
            # pro Plattform, damit der sidecar-Build standalone laeuft.
            Write-Host "  WARN: rustc nicht im PATH — fallback auf plattform-Default."
            Write-Host "         Fuer tauri:build wird Rust trotzdem benoetigt:"
            Write-Host "         winget install Rustlang.Rustup"
            if ($IsWindows -or $env:OS -eq 'Windows_NT') {
                $arch = $env:PROCESSOR_ARCHITECTURE
                $triple = if ($arch -eq 'ARM64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
            } elseif ($IsMacOS) {
                $arch = uname -m
                $triple = if ($arch -match 'arm64|aarch64') { 'aarch64-apple-darwin' } else { 'x86_64-apple-darwin' }
            } else {
                $arch = uname -m
                $triple = if ($arch -match 'aarch64|arm64') { 'aarch64-unknown-linux-gnu' } else { 'x86_64-unknown-linux-gnu' }
            }
            Write-Host "         fallback triple: $triple"
        } else {
            $rustcVer = & rustc -Vv 2>$null
            $hostLine = $rustcVer | Select-String -Pattern '^host:\s*(.+)$'
            if (-not $hostLine) { throw "Could not parse host triple from rustc -Vv output" }
            $triple = $hostLine.Matches.Groups[1].Value.Trim()
        }
    }

    $nodeMajor = (node --version) -replace '^v(\d+)\..*', '$1'
    $pkgTarget = switch -Regex ($triple) {
        '^x86_64-pc-windows'     { "node$nodeMajor-win-x64" }
        '^aarch64-pc-windows'    { "node$nodeMajor-win-arm64" }
        '^x86_64-apple-darwin'   { "node$nodeMajor-macos-x64" }
        '^aarch64-apple-darwin'  { "node$nodeMajor-macos-arm64" }
        '^x86_64-unknown-linux'  { "node$nodeMajor-linux-x64" }
        '^aarch64-unknown-linux' { "node$nodeMajor-linux-arm64" }
        default { throw "Unsupported triple: $triple" }
    }

    $outDir = Join-Path $repoRoot "gui\src-tauri\binaries"
    if (-not (Test-Path $outDir)) {
        New-Item -ItemType Directory -Path $outDir | Out-Null
    }
    $outBin = Join-Path $outDir "claude-os-sidecar-$triple.exe"

    Write-Host "[3/5] pkg target=$pkgTarget triple=$triple"
    Write-Host "[4/5] writing $outBin"
    npx --yes @yao-pkg/pkg@latest $entry --target $pkgTarget --output $outBin
    if ($LASTEXITCODE -ne 0) { throw "pkg failed" }

    $sizeMb = [math]::Round((Get-Item $outBin).Length / 1MB, 1)
    Write-Host "[OK] sidecar built: $outBin ($sizeMb MB)"

    # [5/5] node-pty sideload als komplettes Package neben den Sidecar.
    # pkg bundlet `createRequire(import.meta.url).require()` NICHT statisch,
    # und Native-Module funktionieren ohnehin nicht im Snapshot. Wir
    # shippen daher `node-pty/` als ganzes Package. pty-binding-loader.ts
    # resolved via `dirname(process.execPath) + '/node-pty'` — Tauri's
    # bundle.resources copy's `binaries/node-pty/**` ins App-Resource-Dir.
    Write-Host "[5/5] sideloading node-pty package"
    $nodeArchMap = @{
        'x86_64-pc-windows-msvc'    = 'win32-x64'
        'aarch64-pc-windows-msvc'   = 'win32-arm64'
        'x86_64-apple-darwin'       = 'darwin-x64'
        'aarch64-apple-darwin'      = 'darwin-arm64'
        'x86_64-unknown-linux-gnu'  = 'linux-x64'
        'aarch64-unknown-linux-gnu' = 'linux-arm64'
    }
    $nodeArch = $nodeArchMap[$triple]
    if ($null -eq $nodeArch) {
        Write-Host "  WARN: keine node-pty arch-Map fuer $triple — skipping sideload"
    } else {
        $sideloadDir = Join-Path $outDir "node-pty"
        if (Test-Path $sideloadDir) { Remove-Item -Recurse -Force $sideloadDir }
        New-Item -ItemType Directory -Path $sideloadDir -Force | Out-Null

        $src = Join-Path $repoRoot "node_modules\node-pty"
        if (-not (Test-Path $src)) {
            throw "node-pty: $src missing. Run 'npm install' first."
        }

        # Copy package.json + lib/
        Copy-Item (Join-Path $src "package.json") (Join-Path $sideloadDir "package.json")
        Copy-Item -Recurse (Join-Path $src "lib") (Join-Path $sideloadDir "lib")

        # Copy prebuild fuer DIESEN arch (host) — andere arches sparen
        # ~50MB Bundle-Size. Strippen `.pdb` (Win debug-symbols ~30MB).
        $prebuildSrc = Join-Path $src "prebuilds\$nodeArch"
        $prebuildDst = Join-Path $sideloadDir "prebuilds\$nodeArch"
        if (Test-Path $prebuildSrc) {
            Write-Host "  prebuild source: $prebuildSrc"
            New-Item -ItemType Directory -Path $prebuildDst -Force | Out-Null
            Get-ChildItem $prebuildSrc -Recurse -File | Where-Object { $_.Extension -ne '.pdb' } | ForEach-Object {
                $relPath = $_.FullName.Substring($prebuildSrc.Length + 1)
                $destPath = Join-Path $prebuildDst $relPath
                $destParent = Split-Path $destPath -Parent
                if (-not (Test-Path $destParent)) {
                    New-Item -ItemType Directory -Path $destParent -Force | Out-Null
                }
                Copy-Item $_.FullName $destPath
            }
        } else {
            # Linux: kein prebuild — npm install hat source-build
            # ausgefuehrt, Artifacts liegen in build/Release.
            $releaseSrc = Join-Path $src "build\Release"
            if (-not (Test-Path $releaseSrc)) {
                throw "node-pty: weder prebuild ($prebuildSrc) noch build/Release gefunden."
            }
            Write-Host "  source-build artifacts: $releaseSrc"
            $releaseDst = Join-Path $sideloadDir "build\Release"
            New-Item -ItemType Directory -Path $releaseDst -Force | Out-Null
            Get-ChildItem $releaseSrc -File | Where-Object { $_.Extension -in '.node', '' -or $_.Name -eq 'spawn-helper' } | ForEach-Object {
                Copy-Item $_.FullName (Join-Path $releaseDst $_.Name)
            }
        }

        $sideloadBytes = (Get-ChildItem $sideloadDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
        $sideloadMb = [math]::Round($sideloadBytes / 1MB, 1)
        Write-Host "[OK] node-pty sideloaded: $sideloadDir ($sideloadMb MB)"
    }
}
finally {
    Pop-Location
}
