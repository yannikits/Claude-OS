$ErrorActionPreference = 'Stop'
$portableRoot = $PSScriptRoot

Write-Host "[Claude Portable]" -ForegroundColor Cyan
Write-Host "Root: $portableRoot"
Write-Host ""

$nodePath = "$portableRoot\bin\node\node.exe"
$decryptScript = "$portableRoot\bin\decrypt.js"
$keyFile = "$portableRoot\.key"

if (-not (Test-Path $nodePath)) {
    Write-Host "FEHLER: Portable Node.js nicht gefunden. Bitte erst setup.bat ausfuehren." -ForegroundColor Red
    Read-Host "Enter druecken zum Beenden"
    exit 1
}
if (-not (Test-Path $keyFile)) {
    Write-Host "FEHLER: .key nicht gefunden. Bitte erst setup.bat ausfuehren." -ForegroundColor Red
    Read-Host "Enter druecken zum Beenden"
    exit 1
}

$securePass = Read-Host -AsSecureString "Passwort"
$plainPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass))

$apiKey = $plainPass | & $nodePath $decryptScript $keyFile 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Falsches Passwort oder beschaedigte .key-Datei." -ForegroundColor Red
    Read-Host "Enter druecken zum Beenden"
    exit 1
}
$env:ANTHROPIC_API_KEY = $apiKey
Write-Host "API-Key geladen." -ForegroundColor Green

$claudeDir = "$env:USERPROFILE\.claude"
$configDir = "$portableRoot\config"
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupDir = "$env:USERPROFILE\.claude.bak.$timestamp"
$createdJunction = $false

if (Test-Path $claudeDir) {
    $item = Get-Item $claudeDir -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Write-Host "Junction bereits vorhanden." -ForegroundColor Green
    } else {
        Write-Host "Sichere .claude nach $backupDir ..."
        try {
            Rename-Item $claudeDir $backupDir -ErrorAction Stop
        } catch {
            Write-Host "Umbenennen fehlgeschlagen - versuche robocopy..." -ForegroundColor Yellow
            robocopy $claudeDir $backupDir /E /COPYALL /NFL /NDL /NJH /NJS | Out-Null
            Remove-Item $claudeDir -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $claudeDir) {
                Write-Host ""
                Write-Host "FEHLER: .claude ist gesperrt. Bitte Claude Code zuerst schliessen, dann start.bat neu starten." -ForegroundColor Red
                exit 1
            }
        }
        cmd /c "mklink /J `"$claudeDir`" `"$configDir`"" | Out-Null
        $createdJunction = $true
        Write-Host "Junction erstellt." -ForegroundColor Green
    }
} else {
    cmd /c "mklink /J `"$claudeDir`" `"$configDir`"" | Out-Null
    $createdJunction = $true
    Write-Host "Junction erstellt." -ForegroundColor Green
}

$env:PATH = "$portableRoot\bin\node;$portableRoot\bin;$env:PATH"
$env:NODE_PATH = "$portableRoot\bin\node\node_modules"
$env:NPM_CONFIG_PREFIX = "$portableRoot\bin\node"

$vaultDir = "$portableRoot\vault"
if (Test-Path "$vaultDir\.git") {
    Write-Host "Vault-Update..." -ForegroundColor Yellow
    git -C $vaultDir pull --rebase origin main 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "Vault aktuell." -ForegroundColor Green }
    else { Write-Host "Vault-Pull fehlgeschlagen (kein Internet?). Fahre fort." -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "Starte Claude..." -ForegroundColor Cyan
& "$portableRoot\bin\claude.exe"

Write-Host ""
Write-Host "Session beendet. Raeume auf..." -ForegroundColor Yellow

if ($createdJunction -and (Test-Path $claudeDir)) {
    $item = Get-Item $claudeDir -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [IO.Directory]::Delete($claudeDir)
        Write-Host "Junction entfernt." -ForegroundColor Green
    }
}

if (Test-Path $backupDir) {
    Rename-Item $backupDir ".claude"
    Write-Host "Original .claude wiederhergestellt." -ForegroundColor Green
}

Write-Host "Fertig." -ForegroundColor Green
