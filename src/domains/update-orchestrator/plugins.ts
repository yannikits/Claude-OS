/**
 * plugins.ts — explicit plugin-update handling per ADR-0005 + Memory
 * 587/593 (claude-flow peer-deps regression: plugin installs must
 * never piggyback on the env-repo pull cycle).
 *
 * v1 scope: ships the per-run log-file infrastructure (the
 * Memory-587 mitigation) but the actual install path is deferred to
 * Phase 5 when the catalog (ADR-0009) lands. Calling this today
 * returns state `no-remote` with a hint pointing to Phase 5.
 *
 * @module @domains/update-orchestrator/plugins
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateResult } from './types.js';

interface UpdatePluginsOpts {
  /** Per-machine `<dataRoot>/logs/` for the dedicated plugin-update log. */
  readonly logsDir: string;
  /** Override clock (tests). */
  readonly now?: () => Date;
}

function refSafeIso(d: Date): string {
  return d.toISOString().replaceAll(':', '-').replace('.', '-');
}

/** Returns the dedicated log-file path for a plugin-update run. */
export function pluginUpdateLogPath(logsDir: string, now: Date = new Date()): string {
  return join(logsDir, `plugin-update-${refSafeIso(now)}.log`);
}

export async function updatePlugins(opts: UpdatePluginsOpts): Promise<UpdateResult> {
  const startedAt = Date.now();
  const now = (opts.now ?? (() => new Date()))();
  const logPath = pluginUpdateLogPath(opts.logsDir, now);

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      [
        `# plugin-update run @ ${now.toISOString()}`,
        '# status: not-implemented-in-v1',
        '# note: full plugin updates require Phase 5 catalog (ADR-0009)',
        '',
      ].join('\n'),
      { mode: 0o644 },
    );
  } catch {
    /* logging is best-effort */
  }

  return {
    scope: 'plugins',
    state: 'no-remote',
    message:
      'plugin updates require Phase 5 catalog (ADR-0009). ' +
      'See `claude-os catalog` (stub) for the planned surface.',
    durationMs: Date.now() - startedAt,
  };
}

/** Re-exported for the CLI presenter. */
export const PLUGINS_V1_HINT =
  'Plugins are managed by Phase 5 catalog (ADR-0009). Skipping in v1.';
