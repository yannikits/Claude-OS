#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';

const cmd = isWin ? 'pwsh' : 'bash';
const args = isWin
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'build-sidecar.ps1')]
  : [join(here, 'build-sidecar.sh')];

const result = spawnSync(cmd, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
