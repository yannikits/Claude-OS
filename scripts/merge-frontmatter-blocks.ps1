#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Merges two consecutive YAML frontmatter blocks at the top of a markdown
  note into one block. Dry-run by default.

.DESCRIPTION
  Some notes in the vault have two frontmatter blocks back-to-back
  (e.g., from a mine-obsidian / claude-chat export plus a manual
  augmentation):

    ---
    tags: [#sql-fehler]
    classification: customer-confidential
    workspace: msp-customers/10011
    ---

    ---
    uuid: 100448df-...
    date: 2026-03-13
    title: "SQL Server Anmeldefehler"
    source: claude-chat
    ---

    body...

  Obsidian only recognises the first block as canonical frontmatter; the
  second block renders as a horizontal-rule + key-value text. This
  script combines both blocks into one, preserving all keys.

  Merge rules:
    - Block 1'\''s keys come first (in original order)
    - Block 2'\''s keys are appended (in original order) unless they
      already exist in block 1
    - If a key exists in both AND both values look like YAML arrays
      ([a, b, c]), the arrays are concatenated with de-duplication
      (e.g., `tags: [#sql-fehler] + tags: [claude-chat]` →
      `tags: [#sql-fehler, claude-chat]`)
    - If a key exists in both AND values are NOT arrays, the file is
      flagged as a CONFLICT and left untouched (default) — pass
      -PreferFirst to auto-resolve by keeping block 1'\''s value

  Body content after the second `---` is preserved byte-for-byte.

.PARAMETER VaultPath
  Vault root. Default: $env:CLAUDE_OS_ROOT/vault.

.PARAMETER Execute
  Actually write changes. Without this flag, dry-run only.

.PARAMETER PreferFirst
  When a non-array key exists in both blocks with different values,
  keep block 1'\''s value (block 1 contains the user-augmented keys
  like workspace/tenant/classification, so first-wins is the safer
  default). Without this flag, such files are reported and skipped.

.EXAMPLE
  pwsh ./scripts/merge-frontmatter-blocks.ps1 -VaultPath D:\vault
  # Dry-run

.EXAMPLE
  pwsh ./scripts/merge-frontmatter-blocks.ps1 -VaultPath D:\vault -Execute -PreferFirst
  # Real run, auto-resolve conflicts

.NOTES
  Idempotent. Only files with exactly two leading frontmatter blocks
  are touched; everything else (single block, no block, blocks
  separated by content) is left alone.
#>

[CmdletBinding()]
param(
  [string]$VaultPath,
  [switch]$Execute,
  [switch]$PreferFirst
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
Write-Host "Conflicts  : $(if ($PreferFirst) { 'auto-resolve (block 1 wins)' } else { 'skip + report' })"
Write-Host ''

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Get-FrontmatterKeys {
  param([string]$BlockText)
  $keys = [ordered]@{}
  foreach ($line in ($BlockText -split "`r?`n")) {
    if ($line -match '^([A-Za-z_][\w-]*):\s*(.*)$') {
      $keys[$Matches[1]] = $Matches[2]
    }
  }
  return $keys
}

function Test-IsYamlArray {
  param([string]$Value)
  return $Value -match '^\s*\[.*\]\s*$'
}

function Merge-YamlArrays {
  param([string]$V1, [string]$V2)
  $inner1 = ($V1 -replace '^\s*\[|\]\s*$','').Trim()
  $inner2 = ($V2 -replace '^\s*\[|\]\s*$','').Trim()
  $items1 = if ($inner1) { ($inner1 -split ',\s*') } else { @() }
  $items2 = if ($inner2) { ($inner2 -split ',\s*') } else { @() }
  $combined = @($items1) + @($items2) | Where-Object { $_ -ne '' } | Select-Object -Unique
  return '[' + ($combined -join ', ') + ']'
}

function Invoke-MergeBlocks {
  param([string]$Path)

  $content = [System.IO.File]::ReadAllText($Path, $Utf8NoBom)

  # Match exactly two FM blocks at start; allow blank lines between them.
  $rx = '\A(---\r?\n[\s\S]*?\r?\n---\r?\n)(?:\s*\r?\n)*(---\r?\n[\s\S]*?\r?\n---\r?\n?)'
  if ($content -notmatch $rx) {
    return @{ State = 'no-double' }
  }

  $b1Full = $Matches[1]
  $b2Full = $Matches[2]
  $consumed = $Matches[0].Length
  $body = $content.Substring($consumed)

  # Strip the leading and trailing --- delimiters to get just the key:value lines
  $b1Inner = ($b1Full -replace '\A---\r?\n','' -replace '\r?\n---\r?\n?\z','')
  $b2Inner = ($b2Full -replace '\A---\r?\n','' -replace '\r?\n---\r?\n?\z','')

  $k1 = Get-FrontmatterKeys $b1Inner
  $k2 = Get-FrontmatterKeys $b2Inner

  $merged = [ordered]@{}
  foreach ($k in $k1.Keys) { $merged[$k] = $k1[$k] }
  $conflicts = @()
  foreach ($k in $k2.Keys) {
    if ($merged.Contains($k)) {
      $v1 = $merged[$k]; $v2 = $k2[$k]
      if ($v1 -eq $v2) {
        continue  # identical, nothing to do
      }
      if ((Test-IsYamlArray $v1) -and (Test-IsYamlArray $v2)) {
        $merged[$k] = Merge-YamlArrays $v1 $v2
      } else {
        $conflicts += @{ Key = $k; V1 = $v1; V2 = $v2 }
        if ($PreferFirst) {
          # keep $merged[$k] = $v1
        } else {
          # leave as is, will be reported and file untouched
        }
      }
    } else {
      $merged[$k] = $k2[$k]
    }
  }

  if ($conflicts.Count -gt 0 -and -not $PreferFirst) {
    return @{ State = 'conflict'; Conflicts = $conflicts }
  }

  $mergedLines = $merged.Keys | ForEach-Object { "${_}: $($merged[$_])" }
  $newBlock = "---`n" + ($mergedLines -join "`n") + "`n---`n"
  $newContent = $newBlock + $body

  if ($Execute) {
    [System.IO.File]::WriteAllText($Path, $newContent, $Utf8NoBom)
  }
  return @{
    State = 'merged'
    B1Count = $k1.Count
    B2Count = $k2.Count
    MergedCount = $merged.Count
    ConflictsResolved = $conflicts.Count
  }
}

# ----------------------------------------------------------------------------
# Scan
# ----------------------------------------------------------------------------

$mdFiles = Get-ChildItem $WorkspaceRoot -Filter *.md -Recurse -File -Force |
  Where-Object { $_.Name -ne 'README.md' }

$stats = @{
  TotalScanned = 0
  Merged = 0
  NoDouble = 0
  ConflictSkipped = 0
}
$conflictList = @()

foreach ($f in $mdFiles) {
  $stats.TotalScanned++
  $rel = $f.FullName.Substring($WorkspaceRoot.Length).TrimStart('\','/')
  $result = Invoke-MergeBlocks -Path $f.FullName

  switch ($result.State) {
    'merged' {
      $stats.Merged++
      Write-Host "  MERGE  $rel  (b1=$($result.B1Count), b2=$($result.B2Count) → $($result.MergedCount) keys$(if($result.ConflictsResolved){"; $($result.ConflictsResolved) conflict(s) resolved"})" -ForegroundColor Green
    }
    'conflict' {
      $stats.ConflictSkipped++
      Write-Host "  SKIP   $rel  (CONFLICT — re-run with -PreferFirst to auto-resolve)" -ForegroundColor Yellow
      foreach ($c in $result.Conflicts) {
        Write-Host "         conflict on `"$($c.Key)`": `"$($c.V1)`" vs `"$($c.V2)`"" -ForegroundColor DarkYellow
      }
      $conflictList += @{ Path = $rel; Conflicts = $result.Conflicts }
    }
    'no-double' {
      $stats.NoDouble++
      # quiet — too noisy otherwise
    }
  }
}

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------

Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Cyan
Write-Host "Scanned         : $($stats.TotalScanned)"
Write-Host "Merged          : $($stats.Merged)"
Write-Host "Conflict-skipped: $($stats.ConflictSkipped)"
Write-Host "No double-block : $($stats.NoDouble)"
if (-not $Execute) {
  Write-Host ''
  Write-Host "Dry-run complete. To actually write, re-run with -Execute." -ForegroundColor Green
  if ($stats.ConflictSkipped -gt 0) {
    Write-Host "Conflicts above need -PreferFirst (block-1-wins) or manual edit." -ForegroundColor Yellow
  }
}
