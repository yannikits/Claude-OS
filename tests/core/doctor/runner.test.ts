import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../../src/core/doctor/index.js';

describe('runDoctor', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-doctor-test-'));
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs all 13 checks when root resolves', async () => {
    const report = await runDoctor({ explicitRoot: tmpRoot });
    expect(report.checks).toHaveLength(13);
    const names = report.checks.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'claude-binary',
        'git-available',
        'mount-reachable',
        'node-version',
        'securepoint-config',
        'server-env',
        'signing-keypair',
        'sophos-config',
        'tanss-config',
        'user-store',
        'veeam-config',
        'windows-long-paths',
        'write-permission',
      ].sort(),
    );
  });

  it('produces overall=warn when no claude binary present (but all other ok)', async () => {
    const report = await runDoctor({ explicitRoot: tmpRoot });
    const claudeCheck = report.checks.find((c) => c.name === 'claude-binary');
    expect(claudeCheck?.severity).toBe('warn');
    expect(report.overall).toBe('warn');
  });

  it('reports root-resolution fail when explicit path invalid', async () => {
    const bogus = join(tmpRoot, 'does-not-exist');
    const report = await runDoctor({ explicitRoot: bogus });
    const rootCheck = report.checks.find((c) => c.name === 'root-resolution');
    expect(rootCheck?.severity).toBe('fail');
    expect(report.overall).toBe('fail');
  });

  it('runs only root-independent checks when root unresolvable', async () => {
    const bogus = join(tmpRoot, 'does-not-exist');
    const report = await runDoctor({ explicitRoot: bogus });
    // root-resolution + node + git + windows + server-env + signing + user-store +
    // tanss + veeam + sophos + securepoint = 11
    expect(report.checks).toHaveLength(11);
  });

  it('summary counts match check severities', async () => {
    const report = await runDoctor({ explicitRoot: tmpRoot });
    const { ok, warn, fail } = report.summary;
    expect(ok + warn + fail).toBe(report.checks.length);
  });

  it('totalDurationMs is non-negative', async () => {
    const report = await runDoctor({ explicitRoot: tmpRoot });
    expect(report.summary.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
