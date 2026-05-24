#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Migrates an existing flat Obsidian-Vault into the Multi-Workspace layout
  defined by ADR-0031.

.DESCRIPTION
  Dry-run by default. Pass -Execute to actually move files.

  Layout produced:
    <vault>/Claude-OS/
    ├── workspaces/
    │   ├── personal/        (everything existing lands here)
    │   ├── msp-internal/
    │   └── msp-customers/
    └── .claude-os/

  Skips the following at the vault root (never moved):
    - Obsidian / git metadata: .obsidian, .git, .gitignore, .gitattributes
    - Migration markers: .claude-os-root, Claude-OS (the target)
    - Claude Code / claude-mem state: .claude, .claudian
    - AgentDB / ruvector runtime: agentdb.rvf*, ruvector.db*
    - Editor / OS junk: *.swp, .DS_Store, Thumbs.db

  Stray 0-byte files with no extension at the root are reported and
  skipped (typical PowerShell-redirection accidents like `> nul`).
  Review them manually and delete after the dry-run if confirmed-junk.

.PARAMETER VaultPath
  Path to the vault root. Default: $env:CLAUDE_OS_ROOT/vault

.PARAMETER Execute
  Actually perform the migration. Without this flag the script is dry-run.

.PARAMETER NoBackup
  Skip the backup zip. Default is to create
  <vault-parent>/vault-backup-<timestamp>.zip before any move.

.PARAMETER Force
  Bypass the "Claude-OS/ already exists" abort. Use with caution — implies
  the migration was already run; a second run will fail mid-way if file
  collisions occur.

.EXAMPLE
  pwsh ./scripts/migrate-vault.ps1
  # Dry-run with vault at $env:CLAUDE_OS_ROOT/vault

.EXAMPLE
  pwsh ./scripts/migrate-vault.ps1 -VaultPath D:\OneDrive\Claude\vault -Execute
  # Real run with backup

.EXAMPLE
  pwsh ./scripts/migrate-vault.ps1 -Execute -NoBackup
  # Real run without backup (you have your own snapshot strategy)

.NOTES
  See docs/vault-migration-guide.md for the full walkthrough.
  Implements ADR-0031 §Migration.
#>

[CmdletBinding()]
param(
  [string]$VaultPath,
  [switch]$Execute,
  [switch]$NoBackup,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------------------
# Resolve vault path
# ----------------------------------------------------------------------------

if (-not $VaultPath) {
  if ($env:CLAUDE_OS_ROOT) {
    $VaultPath = Join-Path $env:CLAUDE_OS_ROOT 'vault'
  } else {
    Write-Error 'No -VaultPath given and $env:CLAUDE_OS_ROOT not set. Either set the environment variable or pass -VaultPath explicitly.'
    exit 1
  }
}

if (-not (Test-Path $VaultPath -PathType Container)) {
  Write-Error "Vault path does not exist or is not a directory: $VaultPath"
  exit 1
}

$VaultPath = (Resolve-Path $VaultPath).Path
$ClaudeOsDir = Join-Path $VaultPath 'Claude-OS'

Write-Host "Vault path : $VaultPath"
Write-Host "Target dir : $ClaudeOsDir"
Write-Host "Mode       : $(if ($Execute) { 'EXECUTE' } else { 'DRY-RUN' })"
Write-Host ''

# ----------------------------------------------------------------------------
# Pre-flight checks
# ----------------------------------------------------------------------------

if (Test-Path $ClaudeOsDir) {
  if ($Force) {
    Write-Warning "Claude-OS/ already exists. -Force is set, continuing — collisions will hard-fail."
  } else {
    Write-Error "Claude-OS/ already exists at $ClaudeOsDir. Migration appears already done. Pass -Force to override (dangerous)."
    exit 1
  }
}

# Items at vault root that must NEVER be moved.
#
# These fall into three buckets:
#  - Obsidian/git metadata that lives at the vault root by convention
#  - Migration target (Claude-OS/) and marker file
#  - Per-tool runtime state (Claude Code, AgentDB, ruvector, OS junk)
#    that happens to land in the vault on a typical developer machine
$SkipExact = @(
  # Obsidian / git
  '.obsidian',
  '.git',
  '.gitignore',
  '.gitattributes',

  # Migration markers
  '.claude-os-root',
  'Claude-OS',

  # Claude Code per-project config (ADR-0011 etc.)
  '.claude',
  '.claudian',

  # OS junk
  '.DS_Store',
  'Thumbs.db'
)

# Wildcard patterns for runtime-state files that match by prefix
$SkipPatterns = @(
  'agentdb.rvf*',     # AgentDB sqlite + lockfile
  'ruvector.db*',     # ruvector store + sidecar files
  '*.swp'             # editor swap
)

function Test-ShouldSkip {
  param([string]$Name)
  if ($SkipExact -contains $Name) { return $true }
  foreach ($pat in $SkipPatterns) {
    if ($Name -like $pat) { return $true }
  }
  return $false
}

# Stray-file heuristic: 0-byte files at the vault root with no extension are
# almost always PowerShell-redirection accidents (`command > nul` typos,
# encoded-Unicode garbage). Skip and warn rather than spread them into the
# personal workspace.
function Test-IsStray {
  param([System.IO.FileSystemInfo]$Item)
  if ($Item.PSIsContainer) { return $false }
  if ($Item.Length -ne 0) { return $false }
  if ($Item.Extension) { return $false }
  return $true
}

# Enumerate top-level items
$AllRoot = Get-ChildItem -Path $VaultPath -Force
$ToMove = @()
$Skipped = @()
$Strays = @()
foreach ($item in $AllRoot) {
  if (Test-ShouldSkip $item.Name) {
    $Skipped += $item
  } elseif (Test-IsStray $item) {
    $Strays += $item
  } else {
    $ToMove += $item
  }
}

Write-Host "Top-level items to move into Claude-OS/workspaces/personal/:" -ForegroundColor Cyan
foreach ($item in $ToMove) {
  $kind = if ($item.PSIsContainer) { 'DIR ' } else { 'FILE' }
  Write-Host "  $kind  $($item.Name)"
}
Write-Host ''
Write-Host "Items skipped (preserved at vault root):" -ForegroundColor DarkGray
foreach ($item in $Skipped) {
  $kind = if ($item.PSIsContainer) { 'DIR ' } else { 'FILE' }
  Write-Host "  SKIP  $kind  $($item.Name)"
}
Write-Host ''
if ($Strays.Count -gt 0) {
  Write-Host "Stray 0-byte / no-extension files (skipped — likely PowerShell artifacts):" -ForegroundColor Yellow
  foreach ($item in $Strays) {
    Write-Host "  STRAY  $($item.Name)"
  }
  Write-Host "  → review and delete manually if confirmed-junk." -ForegroundColor Yellow
  Write-Host ''
}

if ($ToMove.Count -eq 0) {
  Write-Host "Vault has no movable items (only skipped + stray). Will only create the new directory skeleton." -ForegroundColor Yellow
}

# Back-compat: the rest of the script uses $RootItems
$RootItems = $ToMove

# ----------------------------------------------------------------------------
# Backup plan
# ----------------------------------------------------------------------------

$Timestamp = (Get-Date -Format 'yyyyMMdd-HHmmss')
$BackupZip = Join-Path (Split-Path $VaultPath -Parent) "vault-backup-$Timestamp.zip"

if (-not $NoBackup) {
  Write-Host "Backup target: $BackupZip" -ForegroundColor Cyan
} else {
  Write-Host "Backup       : SKIPPED (-NoBackup)" -ForegroundColor Yellow
}
Write-Host ''

# ----------------------------------------------------------------------------
# Dry-run: stop here
# ----------------------------------------------------------------------------

if (-not $Execute) {
  Write-Host "Dry-run complete. To actually migrate, re-run with -Execute." -ForegroundColor Green
  exit 0
}

# ----------------------------------------------------------------------------
# Execute migration
# ----------------------------------------------------------------------------

# Step 1: backup
#
# The backup zips only the items that will actually be moved ($ToMove).
# Skipped items (.git, .obsidian, agentdb.rvf*, ruvector.db, .claude, …)
# stay at the vault root and are not at risk during this migration, so
# including them in the backup adds noise — and worse, runtime-state
# files like ruvector.db are frequently locked by live processes, which
# would crash a wholesale `Compress-Archive *` on a live vault.
if (-not $NoBackup) {
  if ($ToMove.Count -eq 0) {
    Write-Host "Backup skipped: no movable items, nothing at risk." -ForegroundColor DarkGray
  } else {
    Write-Host "Creating backup zip (movables only — $($ToMove.Count) item(s); skipped/stray entries stay at vault root and are not at risk)..."
    $sourcePaths = $ToMove | ForEach-Object { $_.FullName }
    Compress-Archive -Path $sourcePaths -DestinationPath $BackupZip -CompressionLevel Optimal -Force
    $size = [math]::Round((Get-Item $BackupZip).Length / 1MB, 1)
    Write-Host "  OK  $BackupZip ($size MB)" -ForegroundColor Green
  }
}

# Step 2: create directory skeleton
Write-Host "Creating Claude-OS/ skeleton..."
$Dirs = @(
  'Claude-OS\workspaces\personal',
  'Claude-OS\workspaces\msp-internal',
  'Claude-OS\workspaces\msp-customers',
  'Claude-OS\.claude-os'
)
foreach ($d in $Dirs) {
  $full = Join-Path $VaultPath $d
  New-Item -ItemType Directory -Path $full -Force | Out-Null
  Write-Host "  OK  $d" -ForegroundColor Green
}

# Step 3: move top-level items into personal/
$PersonalDir = Join-Path $VaultPath 'Claude-OS\workspaces\personal'
Write-Host "Moving top-level items into $PersonalDir ..."
$Moved = 0
$Failed = @()
foreach ($item in $RootItems) {
  try {
    Move-Item -Path $item.FullName -Destination $PersonalDir -Force
    Write-Host "  OK  $($item.Name)" -ForegroundColor Green
    $Moved++
  } catch {
    Write-Host "  FAIL  $($item.Name): $($_.Exception.Message)" -ForegroundColor Red
    $Failed += @{ Name = $item.Name; Error = $_.Exception.Message }
  }
}

# Step 4: write workspace READMEs
$ReadmeTemplates = @{
  'Claude-OS\workspaces\personal\README.md' = @'
# Workspace: personal

Yannik privat. Default-Workspace beim Session-Start.

## Frontmatter-Erwartung (ab Memory-Phase 3)

```yaml
---
created: <ISO-8601>
updated: <ISO-8601>
tags: [...]
type: session | skill-memory | person | project | note
workspace: personal
classification: personal | operational | ephemeral
schema_version: 1
---
```

`tenant`-Field bleibt leer (kein Customer-Bezug).

## Was hier rein gehört

- Eigene Notizen, Gedanken, Lernlogs
- Skill-Memory der User-Skills
- Personen-Profile aus dem privaten Umfeld
- Aktive private Projekte

## Was hier NICHT rein gehört

- Customer-bezogene Notes → `msp-customers/<customer-id>/`
- ITeen-interne MSP-Doku → `msp-internal/`
- Geheimnisse (API-Keys, Passwörter) → OS-Keyring per ADR-0004
'@

  'Claude-OS\workspaces\msp-internal\README.md' = @'
# Workspace: msp-internal

ITeen-Schmiede-interne MSP-Doku ohne Customer-Bezug.

## Frontmatter-Erwartung

```yaml
---
created: <ISO-8601>
updated: <ISO-8601>
tags: [...]
type: skill-memory | project | note
workspace: msp-internal
classification: operational | customer-confidential
schema_version: 1
---
```

`tenant`-Field bleibt leer.

## Was hier rein gehört

- Standard-Operating-Procedures (SOPs)
- Tooling-Konfigurationen (Ninja-Templates, Veeam-Job-Patterns, etc.)
- Lessons-Learned aus MSP-Arbeit
- Allgemeine Compliance-/DSGVO-Notes

## Was hier NICHT rein gehört

- Customer-spezifische Tickets → `msp-customers/<customer-id>/`
- Privates → `personal/`
'@

  'Claude-OS\workspaces\msp-customers\README.md' = @'
# Workspace: msp-customers

Customer-isoliert. Ein Unterordner pro Customer.

## Layout

```
msp-customers/
├── <customer-id-1>/
│   ├── README.md           Customer-Profil
│   ├── Tickets/
│   ├── Inventory/
│   └── Sessions/
└── <customer-id-2>/
    └── ...
```

`<customer-id>` konsistent halten — idealerweise TANSS- oder Ninja-ID.

## Frontmatter-Erwartung (Pflicht)

```yaml
---
created: <ISO-8601>
updated: <ISO-8601>
tags: [...]
type: session | ticket | inventory | note
workspace: msp-customers/<customer-id>
tenant: <customer-id>
classification: customer-confidential   # Default für msp-customers
schema_version: 1
---
```

## Trust-Regel

Beim Session-Start mit aktivem `msp-customers/<id>`-Workspace:

- FTS-Queries sind workspace + tenant gefiltert (ADR-0027 + ADR-0031)
- Provider-Calls laufen durch den Redaction-Hook (SECURITY.md §3.4)
- MSP-Bridge-Calls (Phase 6+) gehen nur an genau diesen Customer
- Audit-Log markiert jeden Call mit `tenant: <id>`

## Was hier nicht rein gehört

- Eigene Notizen → `personal/`
- Allgemeine MSP-Doku ohne Customer-Bezug → `msp-internal/`
- Geheimnisse → OS-Keyring (ADR-0004); niemals als Plain-Text in Notes
'@
}

Write-Host "Writing workspace READMEs..."
foreach ($pair in $ReadmeTemplates.GetEnumerator()) {
  $full = Join-Path $VaultPath $pair.Key
  Set-Content -Path $full -Value $pair.Value -Encoding UTF8
  Write-Host "  OK  $($pair.Key)" -ForegroundColor Green
}

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------

Write-Host ''
Write-Host '=== Migration Summary ===' -ForegroundColor Cyan
Write-Host "Moved   : $Moved item(s) into Claude-OS/workspaces/personal/"
Write-Host "Skipped : $($SkipNames.Count) protected items at vault root"
Write-Host "READMEs : $($ReadmeTemplates.Count) workspace READMEs written"
if (-not $NoBackup) {
  Write-Host "Backup  : $BackupZip"
}
if ($Failed.Count -gt 0) {
  Write-Host "FAILED  : $($Failed.Count) item(s)" -ForegroundColor Red
  foreach ($f in $Failed) {
    Write-Host "  - $($f.Name): $($f.Error)" -ForegroundColor Red
  }
}

Write-Host ''
Write-Host 'Next steps (manual):' -ForegroundColor Yellow
Write-Host '  1. Open Obsidian, verify notes are visible under Claude-OS/workspaces/personal/'
Write-Host '  2. Sort MSP-relevant notes into msp-internal/ or msp-customers/<id>/'
Write-Host '  3. Add frontmatter to msp-* notes (workspace, tenant, classification)'
Write-Host '  4. See docs/vault-migration-guide.md for the full walkthrough'
if (-not $NoBackup) {
  Write-Host "  5. Keep $BackupZip until you've verified nothing is missing"
}
