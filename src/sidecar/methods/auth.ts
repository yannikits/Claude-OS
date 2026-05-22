/**
 * Auth-Namespace RPCs: status + login.
 *
 * `auth.status` wrapped `checkAuthState()` aus der auth-domain — die
 * 4-stufige Resolution (CI-env → CLI-subprocess → file → no-creds).
 * `auth.login` spawnt `claude auth login` als PTY-Session (reuse
 * existing PtyChatSessions infrastructure aus ADR-0021), mit
 * profile-aware `ANTHROPIC_CONFIG_DIR` via ProfileManager.
 *
 * Beide RPCs sind nur registriert wenn `ptyChatSessions` injected ist
 * (analog zu `pty.*`-Methoden in methods.ts) — auf dem MCP-Pfad ohne
 * PTY laufen sie nicht.
 *
 * @module @sidecar/methods/auth
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { checkAuthState, ProfileManager } from '../../domains/auth/index.js';
import { resolveClaudeBinary } from '../../domains/claude-bridge/index.js';
import type { PtyChatSessions } from '../pty-chat-sessions.js';
import type { RpcDispatcher } from '../rpc.js';
import type { MethodsContext } from './_shared.js';

type AuthExecutor = (
  binaryPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

interface AuthMethodsOpts {
  readonly ptyChatSessions: PtyChatSessions;
  /**
   * Override resolveClaudeBinary fuer Tests. Default: production-resolver.
   * Return null to skip the CLI-status path entirely (forces file/no-creds).
   */
  readonly binaryResolver?: (rootPath: string) => string | null;
  /**
   * Override executor fuer Tests. Default: node:child_process.spawn.
   */
  readonly executor?: AuthExecutor;
}

/**
 * Default-Executor fuer state-check's CLI-Subprocess (`claude auth
 * status --json`). Injectable in Tests via Constructor-Param der
 * `checkAuthState()`-Aufrufer-API; hier nutzen wir die echte
 * node:child_process.spawn-Variante.
 */
function defaultExecutor(
  binaryPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(binaryPath, [...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

export function registerAuthMethods(
  dispatcher: RpcDispatcher,
  ctx: MethodsContext,
  opts: AuthMethodsOpts,
): void {
  const resolver =
    opts.binaryResolver ??
    ((rootPath: string) => {
      try {
        return resolveClaudeBinary({ rootPath }).path;
      } catch {
        return null;
      }
    });
  const executor = opts.executor ?? defaultExecutor;

  dispatcher.register('auth.status', async () => {
    const machine = ctx.machinePaths();
    const profileMgr = new ProfileManager({ dataRoot: machine.dataDir });
    const activeProfile = profileMgr.active();

    const binaryPath = resolver(ctx.rootPath());

    return checkAuthState({
      env: ctx.env(),
      home: ctx.home(),
      ...(binaryPath === null ? {} : { binaryPath, exec: executor }),
      ...(activeProfile === null ? {} : { profile: activeProfile }),
    });
  });

  dispatcher.register('auth.login', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { cols?: number; rows?: number };
    const cols =
      typeof params.cols === 'number' && Number.isInteger(params.cols) && params.cols > 0
        ? params.cols
        : 80;
    const rows =
      typeof params.rows === 'number' && Number.isInteger(params.rows) && params.rows > 0
        ? params.rows
        : 24;

    const machine = ctx.machinePaths();
    const profileMgr = new ProfileManager({ dataRoot: machine.dataDir });
    const envOverride = profileMgr.resolveEnvOverride();
    const envOverrides: Record<string, string> =
      envOverride === null ? {} : { ANTHROPIC_CONFIG_DIR: envOverride };

    return opts.ptyChatSessions.spawn(['auth', 'login'], {
      cols,
      rows,
      envOverrides,
    });
  });
}
