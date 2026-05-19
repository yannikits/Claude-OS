/**
 * Sidecar logger factory with daily-rotating file output (pino-roll).
 *
 * Writes to two destinations via `pino.multistream`:
 *   1. `process.stderr` — picked up by the Tauri supervisor's stderr-router
 *      and forwarded to the renderer as a `sidecar://stderr` event (v1.1).
 *   2. `<logsDir>/sidecar-YYYY-MM-DD.log` via pino-roll — persistent
 *      per-day rotation (10 MB size-cap as secondary guardrail).
 *
 * Resolves `logsDir` in this order:
 *   1. `opts.logsDir` (explicit)
 *   2. `$CLAUDE_OS_LOGS_DIR` env-var
 *   3. `resolveMachinePaths().logsDir` (e.g. `%APPDATA%/claude-os/logs/`)
 *
 * If pino-roll cannot create the file stream (permissions, disk full,
 * read-only mount), falls back to stderr-only and logs the error. The
 * sidecar must not die because of a logging failure — observability is
 * a nice-to-have, the RPC channel is the contract.
 *
 * @module sidecar/logger
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Logger, multistream, pino } from 'pino';
import { resolveMachinePaths } from '../core/paths/index.js';

export interface CreateSidecarLoggerOpts {
  /** Explicit logs dir (skips env + machine-paths resolution). */
  readonly logsDir?: string;
  /** Pino log level. Defaults to `$CLAUDE_OS_LOG_LEVEL` or 'info'. */
  readonly level?: string;
  /** Skip file-rotation setup (tests + pkg-bundled smoke runs). */
  readonly stderrOnly?: boolean;
}

export interface SidecarLogger {
  readonly logger: Logger;
  /** Resolved logs directory (null when stderrOnly or pino-roll failed). */
  readonly logsDir: string | null;
  /** Full path to today's log file (null when stderrOnly or pino-roll failed). */
  readonly currentFile: string | null;
}

function resolveLogsDir(opts: CreateSidecarLoggerOpts): string {
  if (opts.logsDir !== undefined && opts.logsDir.length > 0) return opts.logsDir;
  const envDir = process.env.CLAUDE_OS_LOGS_DIR;
  if (envDir !== undefined && envDir.trim().length > 0) return envDir;
  return resolveMachinePaths().logsDir;
}

function resolveLevel(opts: CreateSidecarLoggerOpts): string {
  if (opts.level !== undefined && opts.level.length > 0) return opts.level;
  const envLevel = process.env.CLAUDE_OS_LOG_LEVEL;
  if (envLevel !== undefined && envLevel.trim().length > 0) return envLevel.toLowerCase();
  return 'info';
}

export async function createSidecarLogger(
  opts: CreateSidecarLoggerOpts = {},
): Promise<SidecarLogger> {
  const level = resolveLevel(opts);
  const baseConfig = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts.stderrOnly === true) {
    return {
      logger: pino(baseConfig, process.stderr),
      logsDir: null,
      currentFile: null,
    };
  }

  const logsDir = resolveLogsDir(opts);
  try {
    mkdirSync(logsDir, { recursive: true });
    const roll = (await import('pino-roll')).default;
    const filePrefix = join(logsDir, 'sidecar');
    const fileStream = await roll({
      file: filePrefix,
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      size: '10m',
      mkdir: true,
      extension: '.log',
    });
    const logger = pino(
      baseConfig,
      multistream([
        { stream: process.stderr, level },
        { stream: fileStream as unknown as NodeJS.WritableStream, level },
      ]),
    );
    const today = new Date().toISOString().slice(0, 10);
    return {
      logger,
      logsDir,
      currentFile: `${filePrefix}.${today}.log`,
    };
  } catch (err) {
    const fallback = pino(baseConfig, process.stderr);
    fallback.warn(
      { logsDir, err: err instanceof Error ? err.message : String(err) },
      'sidecar: pino-roll setup failed, falling back to stderr-only',
    );
    return { logger: fallback, logsDir: null, currentFile: null };
  }
}
