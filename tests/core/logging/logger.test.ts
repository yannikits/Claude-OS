import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/core/logging/index.js';

/**
 * Synchronous in-memory destination for deterministic test assertions.
 * Pino writes one JSON line per log call to the underlying stream.
 */
function captureLogger(level: 'trace' | 'debug' | 'info' | 'warn' = 'trace') {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ level, stream });
  return { logger, chunks };
}

function lastLog(chunks: string[]): Record<string, unknown> {
  const raw = chunks[chunks.length - 1];
  if (raw === undefined) {
    throw new Error('No log entries captured');
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('createLogger — basic output', () => {
  it('produces JSON output with msg and level', () => {
    const { logger, chunks } = captureLogger();
    logger.info('hello world');
    const parsed = lastLog(chunks);
    expect(parsed.msg).toBe('hello world');
    expect(parsed.level).toBe(30); // info = 30 per pino convention
  });

  it('serializes structured object payload', () => {
    const { logger, chunks } = captureLogger();
    logger.info({ user: 'yannik', action: 'login' }, 'user action');
    const parsed = lastLog(chunks);
    expect(parsed.user).toBe('yannik');
    expect(parsed.action).toBe('login');
    expect(parsed.msg).toBe('user action');
  });

  it('respects level: trace logs at trace level', () => {
    const { logger, chunks } = captureLogger('trace');
    logger.trace('deep diagnostic');
    expect(chunks.length).toBe(1);
  });

  it('respects level: info-only suppresses debug', () => {
    const { logger, chunks } = captureLogger('info');
    logger.debug('should not appear');
    logger.info('should appear');
    expect(chunks.length).toBe(1);
    expect(lastLog(chunks).msg).toBe('should appear');
  });
});

describe('createLogger — redaction (ADR-0013 §3)', () => {
  it('redacts top-level credentials object', () => {
    const { logger, chunks } = captureLogger();
    logger.info({ credentials: { apiKey: 'sk-secret', other: 'visible' } }, 'creds load');
    const parsed = lastLog(chunks);
    expect(parsed.credentials).toBe('[REDACTED]');
  });

  it('redacts *.password at any depth', () => {
    const { logger, chunks } = captureLogger();
    logger.info({ user: { password: 'p@ssw0rd' } }, 'login attempt');
    const parsed = lastLog(chunks);
    const user = parsed.user as Record<string, unknown>;
    expect(user.password).toBe('[REDACTED]');
  });

  it('redacts *.token, *.accessToken, *.refreshToken, *.apiKey', () => {
    const { logger, chunks } = captureLogger();
    logger.info({
      a: { token: 'X1' },
      b: { accessToken: 'X2' },
      c: { refreshToken: 'X3' },
      d: { apiKey: 'X4' },
    });
    const p = lastLog(chunks);
    expect((p.a as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((p.b as Record<string, unknown>).accessToken).toBe('[REDACTED]');
    expect((p.c as Record<string, unknown>).refreshToken).toBe('[REDACTED]');
    expect((p.d as Record<string, unknown>).apiKey).toBe('[REDACTED]');
  });

  it('redacts env.ANTHROPIC_API_KEY specifically while keeping other env vars', () => {
    const { logger, chunks } = captureLogger();
    logger.info({
      env: {
        ANTHROPIC_API_KEY: 'sk-very-secret',
        CLAUDE_OS_LOG_LEVEL: 'info',
        UNRELATED: 'visible',
      },
    });
    const env = lastLog(chunks).env as Record<string, unknown>;
    expect(env.ANTHROPIC_API_KEY).toBe('[REDACTED]');
    expect(env.CLAUDE_OS_LOG_LEVEL).toBe('info');
    expect(env.UNRELATED).toBe('visible');
  });

  it('redacts env.CLAUDE_CODE_OAUTH_TOKEN + refresh token', () => {
    const { logger, chunks } = captureLogger();
    logger.info({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: 'tok-123',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ref-456',
      },
    });
    const env = lastLog(chunks).env as Record<string, unknown>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('[REDACTED]');
    expect(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe('[REDACTED]');
  });

  it('redacts env.GITHUB_TOKEN', () => {
    const { logger, chunks } = captureLogger();
    logger.info({ env: { GITHUB_TOKEN: 'ghp_secret' } });
    const env = lastLog(chunks).env as Record<string, unknown>;
    expect(env.GITHUB_TOKEN).toBe('[REDACTED]');
  });

  it('does NOT redact innocent fields', () => {
    const { logger, chunks } = captureLogger();
    logger.info({ name: 'Yannik', count: 42, ok: true });
    const parsed = lastLog(chunks);
    expect(parsed.name).toBe('Yannik');
    expect(parsed.count).toBe(42);
    expect(parsed.ok).toBe(true);
  });
});

describe('createLogger — log level resolution', () => {
  const ENV_KEY = 'CLAUDE_OS_LOG_LEVEL';
  let savedEnv: string | undefined;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    savedEnv = undefined;
  });

  function saveEnv() {
    savedEnv = process.env[ENV_KEY];
  }

  it('uses $CLAUDE_OS_LOG_LEVEL when set', () => {
    saveEnv();
    process.env[ENV_KEY] = 'debug';
    const logger = createLogger();
    expect(logger.level).toBe('debug');
  });

  it('falls back to info for unknown level string', () => {
    saveEnv();
    process.env[ENV_KEY] = 'BOGUS';
    const logger = createLogger();
    expect(logger.level).toBe('info');
  });

  it('explicit level overrides env-var', () => {
    saveEnv();
    process.env[ENV_KEY] = 'trace';
    const logger = createLogger({ level: 'warn' });
    expect(logger.level).toBe('warn');
  });

  it('case-insensitive env-var', () => {
    saveEnv();
    process.env[ENV_KEY] = 'WARN';
    const logger = createLogger();
    expect(logger.level).toBe('warn');
  });
});
