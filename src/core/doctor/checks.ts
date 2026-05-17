/**
 * Individual doctor checks. Each check is independent and returns
 * a structured CheckResult; failures are reported as 'fail' severity
 * rather than thrown exceptions so the runner can present them
 * uniformly.
 *
 * @module @core/doctor/checks
 */

import { exec } from 'node:child_process';
import { accessSync, existsSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ResolvedRoot } from '../environment/index.js';
import type { CheckFn, CheckResult } from './types.js';

const execAsync = promisify(exec);

const MIN_NODE_MAJOR = 20;

async function timed(name: string, fn: CheckFn): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      severity: 'fail',
      message: `Check threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

export async function checkNodeVersion(): Promise<CheckResult> {
  return timed('node-version', () => {
    const versionStr = process.versions.node;
    const majorStr = versionStr.split('.')[0] ?? '0';
    const major = Number.parseInt(majorStr, 10);
    if (major >= MIN_NODE_MAJOR) {
      return Promise.resolve({
        name: 'node-version',
        severity: 'ok',
        message: `Node v${versionStr}`,
      });
    }
    return Promise.resolve({
      name: 'node-version',
      severity: 'fail',
      message: `Node v${versionStr} below required v${MIN_NODE_MAJOR}`,
      hint: `Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org`,
    });
  });
}

export async function checkGitAvailable(): Promise<CheckResult> {
  return timed('git-available', async () => {
    try {
      const { stdout } = await execAsync('git --version');
      return {
        name: 'git-available',
        severity: 'ok',
        message: stdout.trim(),
      };
    } catch {
      return {
        name: 'git-available',
        severity: 'fail',
        message: 'System `git` not found in PATH',
        hint: 'Install Git: `winget install Git.Git` (Win) | `brew install git` (mac) | `apt install git` (Linux)',
      };
    }
  });
}

export async function checkClaudeBinary(rootPath: string): Promise<CheckResult> {
  return timed('claude-binary', () => {
    const win = join(rootPath, 'bin', 'claude.exe');
    const posix = join(rootPath, 'bin', 'claude');
    if (existsSync(win)) {
      return Promise.resolve({
        name: 'claude-binary',
        severity: 'ok',
        message: `Anthropic claude binary present at bin/claude.exe`,
      });
    }
    if (existsSync(posix)) {
      return Promise.resolve({
        name: 'claude-binary',
        severity: 'ok',
        message: `Anthropic claude binary present at bin/claude`,
      });
    }
    return Promise.resolve({
      name: 'claude-binary',
      severity: 'warn',
      message: 'Anthropic claude binary not found in bin/',
      detail: `Checked ${win} and ${posix}`,
      hint: '`claude-os ai` will fail until the Anthropic CLI is installed in bin/',
    });
  });
}

export async function checkMountReachable(root: ResolvedRoot): Promise<CheckResult> {
  return timed('mount-reachable', () => {
    if (!existsSync(root.path)) {
      return Promise.resolve({
        name: 'mount-reachable',
        severity: 'fail',
        message: `Root path "${root.path}" does not exist`,
        hint: 'Check $CLAUDE_OS_ROOT, your cloud-sync client (OneDrive/rclone/Drive), or run from within a claude-os repo',
      });
    }
    return Promise.resolve({
      name: 'mount-reachable',
      severity: 'ok',
      message: `${root.path} (source=${root.source}, cloud=${root.cloudProvider})`,
    });
  });
}

export async function checkWindowsLongPaths(): Promise<CheckResult> {
  return timed('windows-long-paths', async () => {
    if (process.platform !== 'win32') {
      return {
        name: 'windows-long-paths',
        severity: 'ok',
        message: 'not applicable (non-Windows)',
      };
    }
    try {
      const { stdout } = await execAsync('git config --global --get core.longpaths');
      const value = stdout.trim().toLowerCase();
      if (value === 'true') {
        return {
          name: 'windows-long-paths',
          severity: 'ok',
          message: 'git core.longpaths=true (vault deep-tree paths supported)',
        };
      }
      return {
        name: 'windows-long-paths',
        severity: 'warn',
        message: `git core.longpaths="${value}" — paths >260 chars may fail`,
        hint: 'Run: git config --global core.longpaths true',
      };
    } catch {
      // Non-zero exit usually means the key is unset.
      return {
        name: 'windows-long-paths',
        severity: 'warn',
        message: 'git core.longpaths is unset — paths >260 chars may fail',
        hint: 'Run: git config --global core.longpaths true',
      };
    }
  });
}

export async function checkWritePermission(rootPath: string): Promise<CheckResult> {
  return timed('write-permission', () => {
    try {
      accessSync(rootPath, fsConstants.W_OK);
      return Promise.resolve({
        name: 'write-permission',
        severity: 'ok',
        message: `Writable: ${rootPath}`,
      });
    } catch {
      return Promise.resolve({
        name: 'write-permission',
        severity: 'fail',
        message: `Root path is not writable: ${rootPath}`,
        hint: 'Check filesystem permissions, cloud-sync read-only state, or disk-full condition',
      });
    }
  });
}
