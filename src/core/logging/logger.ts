/**
 * Logger factory per ADR-0013.
 *
 * Produces a pino logger with:
 *   - Centralized secret-redaction (see {@link REDACT_PATHS})
 *   - ISO-timestamps
 *   - Log-level resolved from `$CLAUDE_OS_LOG_LEVEL` or explicit override
 *
 * Pino-roll file-rotation and Tauri-stderr-mirroring (per ADR-0013 §3
 * transport.targets) are wired up by the application composition root
 * (Phase 6 GUI) — Phase 1d only ships the in-memory base config.
 *
 * Convention: caller caches its own logger instance; this factory is NOT
 * a singleton accessor. Pass the logger via constructor injection to
 * domain code rather than calling `createLogger()` ad-hoc.
 *
 * @module @core/logging/logger
 */
import { pino, type Logger, type LoggerOptions, type DestinationStream } from 'pino';
import { REDACT_PATHS, REDACT_CENSOR } from './redact-paths.js';

const VALID_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof VALID_LEVELS)[number];

function isValidLevel(value: string): value is LogLevel {
  return (VALID_LEVELS as readonly string[]).includes(value);
}

function resolveLevelFromEnv(envValue: string | undefined): LogLevel {
  if (envValue === undefined) return 'info';
  const normalized = envValue.toLowerCase();
  if (isValidLevel(normalized)) return normalized;
  return 'info';
}

export interface CreateLoggerOpts {
  /** Explicit log level (highest priority). Defaults to `$CLAUDE_OS_LOG_LEVEL` or 'info'. */
  readonly level?: LogLevel;
  /** When true, pipe through pino-pretty for human-readable dev output. */
  readonly pretty?: boolean;
  /** Custom destination stream (primarily for tests). */
  readonly stream?: DestinationStream | NodeJS.WritableStream;
}

export function createLogger(opts: CreateLoggerOpts = {}): Logger {
  const level = opts.level ?? resolveLevelFromEnv(process.env.CLAUDE_OS_LOG_LEVEL);

  const baseConfig: LoggerOptions = {
    level,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
    },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts.pretty === true) {
    return pino({
      ...baseConfig,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l' },
      },
    });
  }

  if (opts.stream !== undefined) {
    return pino(baseConfig, opts.stream as DestinationStream);
  }

  return pino(baseConfig);
}
