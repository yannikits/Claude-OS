#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Adds required workspace/tenant/classification/schema_version frontmatter
  to MSP-Notes (msp-customers/<id>/ + msp-internal/) without touching
  existing keys or note body. Dry-run by default.

.DESCRIPTION
  Implements the post-migration step from `docs/vault-migration-guide.md`
  §"Frontmatter (Pflicht pro Note in MSP-Workspaces)" — adds the four
  keys required by ADR-0031 + SECURITY.md §2 to every MSP-Note that is
  missing them.

  Scope:
    - <vault>/Claude-OS/workspaces/msp-customers/<customer>/**/*.md
      → workspace: msp-customers/<customer>
      → tenant:    <tanss-id> (numeric prefix of <customer>, fallback <customer>)
      → classification: customer-confidential
      → schema_version: 1
    - <vault>/Claude-OS/workspaces/msp-internal/**/*.md
      → workspace: msp-internal
      → classification: operational
      → schema_version: 1
    - personal/ is NOT touched.
    - README.md files are skipped (workspace metadata).

  Behavior:
    - Existing frontmatter is preserved verbatim. Only missing keys are
      appended to the closing `---` of the block.
    - Files without frontmatter get a fresh block prepended.
    - Body content is preserved byte-for-byte.
    - The folder name (everything between msp-customers/ and the next
      slash) is parsed for a leading numeric run as the tenant id.
      "10011 - Foo GmbH" → tenant: 10011. No-digits fallback uses the
      full folder name.
    - Existing `tenant`/`workspace`/etc. values are never overwritten.

.PARAMETER VaultPath
  Vault root. Default: $env:CLAUDE_OS_ROOT/vault.

.PARAMETER Execute
  Actually write changes. Without this flag, dry-run only.

.EXAMPLE
  pwsh ./scripts/augment-msp-frontmatter.ps1 -VaultPath D:\vault
  # Dry-run: lists per-file deltas

.EXAMPLE
  pwsh ./scripts/augment-msp-frontmatter.ps1 -VaultPath D:\vault -Execute
  # Real run

.NOTES
  Idempotent: a second -Execute lauf adds nothing if all keys already exist.
#>

[CmdletBinding()]
param(
  [string]$VaultPath,
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------------------
# Resolve vault path
# ----------------------------------------------------------------------------

if (-not $VaultPath) {
  if ($env:CLAUDE_OS_ROOT) {
    $VaultPath = Join-Path $env:CLAUDE_OS_ROOT 'vault'
  } else {
    Write-Error 'No -VaultPath given and $env:CLAUDE_OS_ROOT not set.'
    exit 1
  }
}

if (-not (Test-Path $VaultPath -PathType Container)) {
  Write-Error "Vault path does not exist or is not a directory: $VaultPath"
  exit 1
}

$VaultPath = (Resolve-Path $VaultPath).Path
$WorkspaceRoot = Join-Path $VaultPath 'Claude-OS\workspaces'

if (-not (Test-Path $WorkspaceRoot -PathType Container)) {
  Write-Error "Multi-Workspace layout not found at $WorkspaceRoot. Run migrate-vault.ps1 first."
  exit 1
}

Write-Host "Vault path : $VaultPath"
Write-Host "Mode       : $(if ($Execute) { 'EXECUTE' } else { 'DRY-RUN' })"
Write-Host ''

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

# UTF-8 without BOM (Obsidian convention)
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

# Parse the existing YAML frontmatter block. Returns @{ Keys, RawFm, Body }.
function Read-Frontmatter {
  param([string]$Content)
  $rxOpen = '\A---\r?\n'
  $rxFull = '\A---\r?\n([\s\S]*?)\r?\n---\r?\n?'
  if ($Content -match $rxFull) {
    $fmText = $Matches[1]
    $body = $Content.Substring($Matches[0].Length)
    $keys = [ordered]@{}
    foreach ($line in ($fmText -split "`r?`n")) {
      if ($line -match '^([A-Za-z_][\w-]*):\s*(.*)$') {
        $keys[$Matches[1]] = $Matches[2]
      }
    }
    return @{ Keys = $keys; RawFm = $fmText; Body = $body; HasFm = $true }
  }
  return @{ Keys = [ordered]@{}; RawFm = $null; Body = $Content; HasFm = $false }
}

# Apply required-key augmentation. Returns @{ Changed, Added, NewContent }.
function Get-AugmentedContent {
  param([string]$Content, [hashtable]$Required)
  $parsed = Read-Frontmatter $Content
  $toAdd = [ordered]@{}
  foreach ($k in $Required.Keys) {
    if (-not $parsed.Keys.Contains($k)) {
      $toAdd[$k] = $Required[$k]
    }
  }
  if ($toAdd.Count -eq 0) {
    return @{ Changed = $false; Added = $toAdd; NewContent = $Content }
  }
  $addedLines = $toAdd.Keys | ForEach-Object { "${_}: $($toAdd[$_])" }
  if ($parsed.HasFm) {
    $rebuilt = "---`n$($parsed.RawFm)`n$($addedLines -join "`n")`n---`n$($parsed.Body)"
  } else {
    $rebuilt = "---`n$($addedLines -join "`n")`n---`n`n$($parsed.Body)"
  }
  return @{ Changed = $true; Added = $toAdd; NewContent = $rebuilt }
}

# Extract numeric tenant id from a customer folder name like "10011 - Foo GmbH".
function Get-TenantId {
  param([string]$FolderName)
  if ($FolderName -match '^\s*(\d+)\s*[-_\s]') {
    return $Matches[1]
  }
  return $FolderName
}

# Apply augmentation to a single file. Returns the $Added hashtable or $null.
function Invoke-AugmentFile {
  param([string]$Path, [hashtable]$Required)
  $content = [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
  $result = Get-AugmentedContent -Content $content -Required $Required
  if (-not $result.Changed) { return $null }
  if ($Execute) {
    [System.IO.File]::WriteAllText($Path, $result.NewContent, $Utf8NoBom)
  }
  return $result.Added
}

# ----------------------------------------------------------------------------
# Process msp-customers
# ----------------------------------------------------------------------------

$totalFiles = 0
$totalChanged = 0

$customersRoot = Join-Path $WorkspaceRoot 'msp-customers'
if (Test-Path $customersRoot) {
  $customerDirs = Get-ChildItem $customersRoot -Directory -Force
  foreach ($cust in $customerDirs) {
    $tenant = Get-TenantId $cust.Name
    $workspace = "msp-customers/$($cust.Name)"
    $required = [ordered]@{
      workspace        = $workspace
      tenant           = $tenant
      classification   = 'customer-confidential'
      schema_version   = '1'
    }
    Write-Host "msp-customers/$($cust.Name)/ (tenant=$tenant)" -ForegroundColor Cyan
    $mdFiles = Get-ChildItem $cust.FullName -Filter *.md -Recurse -File -Force |
      Where-Object { $_.Name -ne 'README.md' }
    foreach ($f in $mdFiles) {
      $totalFiles++
      $added = Invoke-AugmentFile -Path $f.FullName -Required $required
      $rel = $f.FullName.Substring($cust.FullName.Length).TrimStart('\','/')
      if ($null -ne $added) {
        $totalChanged++
        $addedSummary = ($added.Keys | ForEach-Object { "$_=$($added[$_])" }) -join ', '
        Write-Host "  ADD  $rel  → [$addedSummary]" -ForegroundColor Green
      } else {
        Write-Host "  OK   $rel  (already complete)" -ForegroundColor DarkGray
      }
    }
  }
}

# ----------------------------------------------------------------------------
# Process msp-internal
# ----------------------------------------------------------------------------

$internalRoot = Join-Path $WorkspaceRoot 'msp-internal'
if (Test-Path $internalRoot) {
  $required = [ordered]@{
    workspace        = 'msp-internal'
    classification   = 'operational'
    schema_version   = '1'
  }
  $mdFiles = Get-ChildItem $internalRoot -Filter *.md -Recurse -File -Force |
    Where-Object { $_.Name -ne 'README.md' }
  if ($mdFiles.Count -gt 0) {
    Write-Host ''
    Write-Host 'msp-internal/' -ForegroundColor Cyan
    foreach ($f in $mdFiles) {
      $totalFiles++
      $added = Invoke-AugmentFile -Path $f.FullName -Required $required
      $rel = $f.FullName.Substring($internalRoot.Length).TrimStart('\','/')
      if ($null -ne $added) {
        $totalChanged++
        $addedSummary = ($added.Keys | ForEach-Object { "$_=$($added[$_])" }) -join ', '
        Write-Host "  ADD  $rel  → [$addedSummary]" -ForegroundColor Green
      } else {
        Write-Host "  OK   $rel  (already complete)" -ForegroundColor DarkGray
      }
    }
  }
}

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------

Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Cyan
Write-Host "Files scanned : $totalFiles"
Write-Host "Files changed : $totalChanged"
if (-not $Execute) {
  Write-Host ''
  Write-Host "Dry-run complete. To actually write, re-run with -Execute." -ForegroundColor Green
}
