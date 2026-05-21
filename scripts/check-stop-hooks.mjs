#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: CLI-Tool — console-Output ist gewollt.
// Diagnose-Skript für Stop-Hook-Hänger auf Windows.
//
// Liest alle settings*.json unter ~/.claude/{settings.json,plugins/marketplaces/**/.claude/settings.json}
// und gibt pro Stop-Hook eine Zeile aus mit:
//   - Pfad der Settings-Datei
//   - Command (ggf. mit hervorgehobenem POSIX-$VAR-Risiko)
//   - Timeout / continueOnError
//   - "OK" / "RISK" Marker
//
// Aufruf:  node scripts/check-stop-hooks.mjs
// Exit-Code: 0 wenn alle Hooks OK sind, 1 wenn mind. ein Risk-Hook gefunden wurde.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_DIR = join(homedir(), '.claude');

function walkForSettings(rootDir, depthLimit = 8) {
  const found = [];
  if (!existsSync(rootDir)) return found;
  const stack = [{ path: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const { path, depth } = stack.pop();
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (depth >= depthLimit) continue;
        if (
          entry.name === 'node_modules' ||
          entry.name === 'old' ||
          entry.name.startsWith('temp_')
        ) {
          continue;
        }
        stack.push({ path: full, depth: depth + 1 });
      } else if (entry.isFile() && /^settings(\.local)?\.json$/.test(entry.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

function findSettingsFiles() {
  const candidates = new Set([
    join(CLAUDE_DIR, 'settings.json'),
    join(CLAUDE_DIR, 'settings.local.json'),
  ]);
  const marketplaces = join(CLAUDE_DIR, 'plugins', 'marketplaces');
  for (const f of walkForSettings(marketplaces)) candidates.add(f);
  return [...candidates].filter((p) => existsSync(p));
}

function safeParse(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    // JSONC oder Quoting-Fehler — fallback auf simple Regex-Extraktion
    return { ok: false, raw, error: err.message };
  }
}

function extractStopHooks(parsed) {
  if (!parsed.hooks) return [];
  const stop = parsed.hooks.Stop;
  if (!Array.isArray(stop)) return [];
  const flat = [];
  for (const group of stop) {
    if (!Array.isArray(group?.hooks)) continue;
    for (const h of group.hooks) flat.push(h);
  }
  return flat;
}

function classifyCommand(cmd) {
  const isWindows = process.platform === 'win32';
  // POSIX-Env-Var-Pattern: $VAR oder ${VAR} außerhalb von "echo"-Strings.
  const posixVar = /\$\{?[A-Z_][A-Z0-9_]*\}?/.test(cmd);
  // cmd.exe-Aufruf?
  const isCmdInvoke = /^\s*cmd\s+\/c\b/i.test(cmd);
  if (isWindows && posixVar && !isCmdInvoke) {
    return {
      risk: 'high',
      reason: 'POSIX-Env-Var in direktem Command — Windows expandiert das nicht',
    };
  }
  if (isWindows && posixVar && isCmdInvoke) {
    return {
      risk: 'medium',
      reason: 'POSIX-Env-Var in cmd /c — cmd.exe expandiert $VAR ebenfalls nicht',
    };
  }
  // Einfache Echo-Commands sind OK
  if (/^\s*echo\b/.test(cmd)) {
    return { risk: 'none', reason: 'echo-only — kein FS-Zugriff, kein Process-Spawn' };
  }
  return { risk: 'low', reason: 'kein offensichtliches Plattform-Problem' };
}

function main() {
  const files = findSettingsFiles();
  let totalHooks = 0;
  let risks = 0;

  console.info(
    `Stop-Hook-Audit (${process.platform}, ${files.length} Settings-Dateien gescannt)\n`,
  );

  for (const file of files) {
    const parseResult = safeParse(file);
    if (!parseResult.ok) {
      console.info(`! ${file}\n  (JSON-Parse-Fehler — ueberspringe: ${parseResult.error})\n`);
      continue;
    }
    const hooks = extractStopHooks(parseResult.data);
    if (hooks.length === 0) continue;
    console.info(`--- ${file.replace(homedir(), '~')} ---`);
    for (const hook of hooks) {
      totalHooks++;
      const klass = classifyCommand(hook.command ?? '');
      const marker =
        klass.risk === 'high'
          ? '[RISK-HIGH]'
          : klass.risk === 'medium'
            ? '[RISK-MED]'
            : klass.risk === 'none'
              ? '[OK-trivial]'
              : '[OK]';
      if (klass.risk === 'high' || klass.risk === 'medium') risks++;
      const tmo = hook.timeout ?? '(default)';
      const onErr =
        hook.continueOnError === true ? 'continueOnError=true' : 'continueOnError=false';
      console.info(`  ${marker}  timeout=${tmo}  ${onErr}`);
      console.info(`    cmd: ${hook.command}`);
      console.info(`    why: ${klass.reason}`);
    }
    console.info('');
  }

  console.info(`\nZusammenfassung: ${totalHooks} Stop-Hook(s) gefunden, ${risks} mit Risiko.`);
  if (risks > 0) {
    console.info(
      '\nEmpfehlung: Plattform-uebergreifender Hook-Konflikt — siehe docs/troubleshooting/stop-hook-hang.md',
    );
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
