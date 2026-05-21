import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSidecarLogger } from '../../src/sidecar/logger.js';

describe('createSidecarLogger', () => {
  let tmp: string;

  beforeEach(() => {
    // No afterEach rmSync — pino-roll's internal SonicBoom stream keeps a
    // file-handle that races a sync cleanup on Windows (ENOENT mkdir from
    // pino-roll's next flush-attempt after the dir vanished). The OS will
    // reclaim the tmpdir eventually; the test footprint is a few KB.
    tmp = mkdtempSync(join(tmpdir(), 'claude-os-logger-'));
  });

  it('schreibt sidecar-YYYY-MM-DD.log in den explizit übergebenen logsDir', async () => {
    const { logger, logsDir, currentFile } = await createSidecarLogger({
      logsDir: tmp,
      level: 'info',
    });

    expect(logsDir).toBe(tmp);
    expect(currentFile).not.toBeNull();

    logger.info({ marker: 'sidecar-test-line' }, 'hallo welt');
    // pino-roll uses sonic-boom under the hood (async). Give it a moment
    // to flush — readFile may otherwise see an empty file.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const files = readdirSync(tmp).filter((f) => f.startsWith('sidecar.') && f.endsWith('.log'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const firstFile = files[0];
    expect(firstFile).toBeDefined();
    const contents = readFileSync(join(tmp, firstFile as string), 'utf8');
    expect(contents).toContain('"marker":"sidecar-test-line"');
    expect(contents).toContain('"msg":"hallo welt"');
  });

  it('liest $CLAUDE_OS_LOGS_DIR wenn opts.logsDir nicht gesetzt ist', async () => {
    const previous = process.env.CLAUDE_OS_LOGS_DIR;
    process.env.CLAUDE_OS_LOGS_DIR = tmp;
    try {
      const { logsDir } = await createSidecarLogger({ level: 'info' });
      expect(logsDir).toBe(tmp);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_OS_LOGS_DIR;
      else process.env.CLAUDE_OS_LOGS_DIR = previous;
    }
  });

  it('falls back to stderr-only wenn stderrOnly=true', async () => {
    const { logsDir, currentFile, logger } = await createSidecarLogger({ stderrOnly: true });
    expect(logsDir).toBeNull();
    expect(currentFile).toBeNull();
    expect(typeof logger.info).toBe('function');
    expect(existsSync(tmp)).toBe(true);
  });

  it('M20: redact-paths greifen — secrets in logs werden zu [REDACTED]', async () => {
    const { logger } = await createSidecarLogger({ logsDir: tmp, level: 'info' });
    // Pino redact-paths `*.password` ist depth-2+ (per fast-redact-Spec).
    // Top-level wuerde `password` direkt sein — wir nesten unter `user.*`
    // wie es in echten Logging-Kontexten typisch ist (req/user/auth-Body).
    logger.info(
      {
        marker: 'redact-test',
        user: {
          password: 'super-secret',
          accessToken: 'at-supersecret',
        },
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-supersecret',
          GITHUB_TOKEN: 'ghp_supersecret',
          SAFE_VAR: 'this-is-fine',
        },
        credentials: { token: 'oauth-token' },
      },
      'log with secrets',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const files = readdirSync(tmp).filter((f) => f.startsWith('sidecar.') && f.endsWith('.log'));
    const firstFile = files[0];
    expect(firstFile).toBeDefined();
    const contents = readFileSync(join(tmp, firstFile as string), 'utf8');
    // Secret-Felder MUESSEN [REDACTED] sein
    expect(contents).toContain('"password":"[REDACTED]"');
    expect(contents).toContain('"accessToken":"[REDACTED]"');
    expect(contents).toContain('"ANTHROPIC_API_KEY":"[REDACTED]"');
    expect(contents).toContain('"GITHUB_TOKEN":"[REDACTED]"');
    expect(contents).toContain('"credentials":"[REDACTED]"');
    // Non-secret-Felder bleiben normal
    expect(contents).toContain('"SAFE_VAR":"this-is-fine"');
    // Critical: KEIN clear-text secret im Log
    expect(contents).not.toContain('super-secret');
    expect(contents).not.toContain('sk-ant-supersecret');
    expect(contents).not.toContain('ghp_supersecret');
    expect(contents).not.toContain('at-supersecret');
    expect(contents).not.toContain('oauth-token');
  });
});
