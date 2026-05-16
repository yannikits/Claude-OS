/**
 * Streaming claude-binary bridge (Phase 3b).
 *
 * Uses `child_process.spawn` with `stdio: 'inherit'` so the parent TTY
 * is passed straight through — no buffering, no 120 s cutoff regression
 * (Memory 569 / 577 / 578). Heartbeat logging runs in parallel for
 * liveness observability since stdio is no longer in our reach.
 *
 * Cancellation: parent SIGINT forwards to the child; if the child has
 * not exited after `killGracePeriodMs` (default 5 s), it is SIGKILL'd.
 *
 * @module @domains/claude-bridge/spawn
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createLogger } from '../../core/logging/index.js';
import { startHeartbeat } from './heartbeat.js';
import { resolveClaudeBinary } from './resolve-binary.js';
import type { BridgeOpts, BridgeResult } from './types.js';

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

const logger = createLogger().child({ component: 'claude-bridge' });

/**
 * Spawns the Anthropic claude binary as a child process, streaming all
 * I/O via stdio-inherit, and returns once the child exits.
 *
 * Rejects only on spawn-time errors (binary not found, ENOENT, EACCES).
 * Non-zero child exits resolve with `exitCode` set — callers propagate
 * that to `process.exit()` themselves.
 */
export async function spawnClaudeBridge(opts: BridgeOpts): Promise<BridgeResult> {
  const binary = resolveClaudeBinary({
    ...(opts.binaryPath === undefined ? {} : { binaryPath: opts.binaryPath }),
    ...(opts.rootPath === undefined ? {} : { rootPath: opts.rootPath }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });

  const spawnImpl = opts.spawnFn ?? nodeSpawn;
  const startedAt = Date.now();
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const killGraceMs = opts.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;

  logger.info(
    {
      binary: binary.path,
      source: binary.source,
      args: opts.args.length,
    },
    'claude-bridge.spawn',
  );

  const child = spawnImpl(binary.path, [...opts.args], {
    stdio: 'inherit',
    env: opts.env ?? process.env,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });

  return new Promise<BridgeResult>((resolve, reject) => {
    const heartbeat = startHeartbeat(heartbeatMs, (elapsedMs) => {
      logger.info({ pid: child.pid, elapsedMs }, 'claude-bridge.heartbeat');
    });

    let killTimer: NodeJS.Timeout | null = null;
    let sigintForwarded = false;

    const cleanup = (): void => {
      heartbeat.stop();
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      process.off('SIGINT', onParentSigint);
      process.off('SIGTERM', onParentSigterm);
    };

    const onParentSigint = (): void => {
      if (sigintForwarded) {
        // Second Ctrl-C from the user — escalate immediately.
        logger.warn({ pid: child.pid }, 'claude-bridge.sigkill (second SIGINT)');
        child.kill('SIGKILL');
        return;
      }
      sigintForwarded = true;
      logger.info({ pid: child.pid }, 'claude-bridge.forward-sigint');
      child.kill('SIGINT');
      killTimer = setTimeout(() => {
        if (!child.killed) {
          logger.warn(
            { pid: child.pid, graceMs: killGraceMs },
            'claude-bridge.sigkill (grace expired)',
          );
          child.kill('SIGKILL');
        }
      }, killGraceMs);
      killTimer.unref?.();
    };

    const onParentSigterm = (): void => {
      logger.info({ pid: child.pid }, 'claude-bridge.forward-sigterm');
      child.kill('SIGTERM');
    };

    process.on('SIGINT', onParentSigint);
    process.on('SIGTERM', onParentSigterm);

    child.once('error', (err) => {
      cleanup();
      reject(err);
    });

    child.once('exit', (code, signal) => {
      cleanup();
      const durationMs = Date.now() - startedAt;
      logger.info(
        { pid: child.pid, exitCode: code, signal, durationMs },
        'claude-bridge.exit',
      );
      resolve({ exitCode: code, signal, durationMs, binary });
    });
  });
}
