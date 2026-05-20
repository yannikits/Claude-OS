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
        $rustcVer = & rustc -Vv 2>$null
        if ($LASTEXITCODE -ne 0) {
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

    Write-Host "[3/4] pkg target=$pkgTarget triple=$triple"
    Write-Host "[4/4] writing $outBin"
    npx --yes @yao-pkg/pkg@latest $entry --target $pkgTarget --output $outBin
    if ($LASTEXITCODE -ne 0) { throw "pkg failed" }

    $sizeMb = [math]::Round((Get-Item $outBin).Length / 1MB, 1)
    Write-Host "[OK] sidecar built: $outBin ($sizeMb MB)"
}
finally {
    Pop-Location
}
