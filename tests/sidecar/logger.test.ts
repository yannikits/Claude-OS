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
});
