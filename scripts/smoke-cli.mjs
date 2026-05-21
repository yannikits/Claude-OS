#!/usr/bin/env node
/**
 * M37 (2026-05-21 code-review): CLI smoke-test script.
 *
 * Vorher gab es keinen echten Smoke-Test fuer die CLI-Subcommands —
 * README §v1-Abweichungen erwaehnt "real-binary Smoke" als
 * Coverage-Ersatz, aber kein Driver existierte. Dieser Script invokt
 * den built `dist/cli/index.js` mit `--json` fuer jedes Subcommand und
 * verifiziert exit 0 + valid JSON.
 *
 * Use:
 *   npm run build && node scripts/smoke-cli.mjs
 * Or wired into:
 *   npm run ci   (siehe package.json)
 *
 * Errors landen auf stderr; exit 0 nur wenn ALLE Smokes passen.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'dist/cli/index.js';

/**
 * Subcommands die `--json` unterstuetzen UND ohne side-effects laufen.
 * `migrate` braucht --from-portable; `update` macht network-pulls;
 * `ai` forwarded an claude.exe; daher hier nicht.
 */
const SMOKE_SUBCOMMANDS = [
  ['doctor', '--json'],
  ['vault', 'status', '--json'],
  ['secrets', 'list', '--json'],
  ['auth', 'status', '--json'],
  ['catalog', 'list', '--json'],
  ['schedule', 'list', '--json'],
];

function setupRoot() {
  const root = mkdtempSync(join(tmpdir(), 'claude-os-smoke-'));
  writeFileSync(join(root, '.claude-os-root'), '');
  return root;
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.signal === 'SIGTERM',
  };
}

function isValidJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

let passed = 0;
let failed = 0;
const root = setupRoot();
const env = { CLAUDE_OS_ROOT: root };

console.error(`[smoke] CLAUDE_OS_ROOT=${root}`);

for (const args of SMOKE_SUBCOMMANDS) {
  const label = `claude-os ${args.join(' ')}`;
  const { exitCode, stdout, stderr, timedOut } = runCli(args, env);
  if (timedOut) {
    console.error(`[FAIL] ${label}: TIMEOUT after 30s`);
    failed++;
    continue;
  }
  // doctor exits 0 or non-zero based on checks; we accept anything that's
  // not a hard crash (>1) AND output is JSON when --json was passed.
  // For other subcommands: exit 0 expected, JSON output expected.
  const isJsonExpected = args.includes('--json');
  const acceptsNonZero = args[0] === 'doctor';
  const exitOk = acceptsNonZero ? exitCode !== null && exitCode <= 1 : exitCode === 0;
  const jsonOk = !isJsonExpected || isValidJson(stdout);
  if (exitOk && jsonOk) {
    console.error(`[OK] ${label} (exit ${exitCode}, ${stdout.length}B stdout)`);
    passed++;
  } else {
    console.error(`[FAIL] ${label} (exit ${exitCode}, exitOk=${exitOk}, jsonOk=${jsonOk})`);
    if (stderr.length > 0) console.error(`  stderr: ${stderr.slice(0, 400)}`);
    if (!jsonOk && stdout.length > 0) {
      console.error(`  stdout (not JSON): ${stdout.slice(0, 200)}`);
    }
    failed++;
  }
}

console.error(`\n[smoke] ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
