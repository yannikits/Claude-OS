/**
 * Sandbox-Runner — Phase 5 Gate 1 per ADR-0026 §"Sandbox" + ADR-0034.
 *
 * Forks the worker-entry as a separate Node child-process, sends the
 * skill-script path + input via IPC, awaits result with a hard
 * timeout, and kills the child on overshoot.
 *
 * Trust-boundary:
 *   - Parent assumes the child WILL try to do anything (LLM-generated
 *     code), but cannot ESCAPE the process (no eval into parent)
 *   - 30s hard-kill prevents runaway loops / hang-forever-skills
 *   - Path-validation prevents `fork()` of a script outside the
 *     sandbox-root (defense-in-depth, not OS-enforced on Windows)
 *
 * NOT enforced here (deferred to Phase-5b):
 *   - fs-API patching inside the child (skill can read /etc/passwd)
 *   - net-API patching inside the child (skill can `fetch` anywhere)
 *
 * Both of those need the worker-entry to monkey-patch `node:fs` and
 * `node:net` before importing the skill. Foundation-spike here just
 * provides the process-boundary + timeout + IPC contract.
 *
 * @module @domains/skill-lifecycle/sandbox/runner
 */
import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertSkillScriptUnderRoot,
  assertValidSandboxRoot,
  assertValidSkillId,
} from './path-guard.js';
import {
  DEFAULT_TIMEOUT_MS,
  type SandboxIpcRequest,
  type SandboxIpcResponse,
  type SandboxOpts,
  type SandboxRunInput,
  type SandboxRunResult,
} from './types.js';

const DEFAULT_WORKER_ENTRY = fileURLToPath(new URL('./worker-entry.js', import.meta.url));

const noopLog: NonNullable<SandboxOpts['log']> = () => {};

/**
 * Runs `skillScriptPath` in an isolated child-process. Returns a
 * structured result; never throws for skill-level errors (timeout,
 * crash). Only throws SandboxError on caller-side validation failures
 * (invalid path, invalid skill-id) — pre-fork.
 */
export function runSkillInSandbox(
  input: SandboxRunInput,
  opts: SandboxOpts,
): Promise<SandboxRunResult> {
  const log = opts.log ?? noopLog;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workerEntry = opts.workerEntry ?? DEFAULT_WORKER_ENTRY;

  // Pre-fork validation — wrapped in Promise so SandboxError surfaces
  // consistently as a rejection (caller writes `await runSkillInSandbox(...)
  // .catch(...)` in one branch).
  return new Promise<SandboxRunResult>((resolveResult, rejectResult) => {
    let normalizedScript: string;
    try {
      assertValidSkillId(input.skillId);
      assertValidSandboxRoot(opts.sandboxRoot);
      normalizedScript = assertSkillScriptUnderRoot(input.skillScriptPath, opts.sandboxRoot);
    } catch (err) {
      rejectResult(err);
      return;
    }

    const startedAt = Date.now();
    let child: ChildProcess | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (result: SandboxRunResult): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already-dead */
        }
      }
      resolveResult(result);
    };

    try {
      child = fork(workerEntry, [], {
        silent: true,
        // Strip secrets from the child env — same pattern as
        // chat-sessions.ts (Memory-Note: m13 secret-env-strip).
        env: stripSecretEnv(process.env),
        // Don't share stdin — child should not steal keyboard input.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      log('error', `sandbox: fork failed: ${(err as Error).message}`);
      finish({
        status: 'error',
        skillId: input.skillId,
        output: null,
        durationMs: Date.now() - startedAt,
        errorMessage: `fork failed: ${(err as Error).message}`,
        killedBy: 'spawn-failure',
      });
      return;
    }

    child.on('error', (err) => {
      log('warn', `sandbox: child error: ${err.message}`);
      finish({
        status: 'error',
        skillId: input.skillId,
        output: null,
        durationMs: Date.now() - startedAt,
        errorMessage: err.message,
        killedBy: 'crash',
      });
    });

    child.on('exit', (code, signal) => {
      // Only fires if the child died without sending us a response.
      if (settled) return;
      log('warn', `sandbox: child exited code=${code} signal=${signal} without response`);
      finish({
        status: 'error',
        skillId: input.skillId,
        output: null,
        durationMs: Date.now() - startedAt,
        errorMessage: `child exited without response (code=${code} signal=${signal})`,
        killedBy: 'crash',
      });
    });

    child.on('message', (msg) => {
      const response = msg as SandboxIpcResponse;
      if (response.kind === 'ok') {
        finish({
          status: 'ok',
          skillId: input.skillId,
          output: response.output,
          durationMs: Date.now() - startedAt,
          killedBy: null,
        });
      } else {
        finish({
          status: 'error',
          skillId: input.skillId,
          output: null,
          durationMs: Date.now() - startedAt,
          errorMessage: response.message,
          killedBy: 'crash',
        });
      }
    });

    const request: SandboxIpcRequest = {
      kind: 'run',
      skillId: input.skillId,
      skillScriptPath: normalizedScript,
      input: input.input,
    };

    try {
      child.send(request);
    } catch (err) {
      log('error', `sandbox: send failed: ${(err as Error).message}`);
      finish({
        status: 'error',
        skillId: input.skillId,
        output: null,
        durationMs: Date.now() - startedAt,
        errorMessage: `IPC send failed: ${(err as Error).message}`,
        killedBy: 'crash',
      });
      return;
    }

    killTimer = setTimeout(() => {
      log('warn', `sandbox: skill "${input.skillId}" timed out after ${timeoutMs}ms`);
      finish({
        status: 'timeout',
        skillId: input.skillId,
        output: null,
        durationMs: Date.now() - startedAt,
        killedBy: 'timeout',
      });
    }, timeoutMs);
    // Don't keep the event loop alive solely for the kill-timer.
    killTimer.unref();
  });
}

/**
 * Strips secret-shaped env-vars from the child's environment. Same
 * Pattern wie chat-sessions.ts / pty-chat-sessions.ts.
 */
function stripSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      key === 'CLAUDE_OS_SECRETS_KEY' ||
      key === 'CLAUDE_OS_SECRETS_PASSPHRASE' ||
      key === 'CLAUDE_OS_AUTH_TOKEN' ||
      key.startsWith('ANTHROPIC_')
    ) {
      continue;
    }
    if (value !== undefined) out[key] = value;
  }
  // Tag the child env so worker-entry knows it's sandboxed (could
  // matter later for fs/net-patch-decisions).
  out.CLAUDE_OS_SANDBOX = '1';
  return out;
}
