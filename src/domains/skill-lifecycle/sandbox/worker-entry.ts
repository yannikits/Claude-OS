/**
 * Worker-Entry — runs INSIDE the forked child-process.
 *
 * Receives a `SandboxIpcRequest` via `process.on('message')`, loads
 * the skill-script (dynamic-import), invokes its default `run(input)`,
 * and posts the result back via `process.send()`.
 *
 * **Skill-Author Contract** (Phase-5 Foundation):
 *
 * ```js
 * // <sandbox>/<skill-id>/script.mjs
 * export default async function run(input) {
 *   return { answer: 42 };
 * }
 * ```
 *
 * The default export must be an async function that takes `input`
 * and returns a JSON-serializable result.
 *
 * Errors from skill-load or skill-run are caught and forwarded as
 * `{kind: 'error', message}` — the parent never sees the child
 * crashing silently.
 *
 * @module @domains/skill-lifecycle/sandbox/worker-entry
 */
import { installNetGuard } from './net-guard.js';
import type { SandboxIpcRequest, SandboxIpcResponse } from './types.js';

type SkillRun = (input: unknown) => unknown | Promise<unknown>;

interface SkillModule {
  default?: SkillRun;
  run?: SkillRun;
}

async function loadAndRun(req: SandboxIpcRequest): Promise<SandboxIpcResponse> {
  // Phase-5b net-guard MUST be installed before skill-import so that
  // top-level `await fetch(...)` in the skill module already sees the
  // guarded version. Empty/undefined allowlist → deny all.
  const allowlist = req.netAllowlist ?? [];
  installNetGuard(allowlist);

  let mod: SkillModule;
  try {
    // Dynamic-import — works for both ESM (.mjs) and CJS (.cjs).
    // The path is already validated by the parent.
    mod = (await import(req.skillScriptPath)) as SkillModule;
  } catch (err) {
    return {
      kind: 'error',
      message: `skill-load failed: ${(err as Error).message}`,
    };
  }

  const run = mod.default ?? mod.run;
  if (typeof run !== 'function') {
    return {
      kind: 'error',
      message: 'skill module exports no `default` or `run` function',
    };
  }

  try {
    const output = await run(req.input);
    return { kind: 'ok', output };
  } catch (err) {
    return {
      kind: 'error',
      message: `skill-run failed: ${(err as Error).message}`,
    };
  }
}

function isRunRequest(msg: unknown): msg is SandboxIpcRequest {
  if (msg === null || typeof msg !== 'object') return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj.kind === 'run' && typeof obj.skillId === 'string' && typeof obj.skillScriptPath === 'string'
  );
}

// Only attach handler when this module is the entrypoint of a fork.
// `process.send` is undefined when run outside an IPC channel — keeps
// the file harmless in regular `node worker-entry.js` invocations.
if (typeof process.send === 'function') {
  process.on('message', (msg: unknown) => {
    if (!isRunRequest(msg)) {
      process.send?.({
        kind: 'error',
        message: 'malformed IPC request',
      } satisfies SandboxIpcResponse);
      return;
    }
    void loadAndRun(msg).then((response) => {
      process.send?.(response);
      // Exit cleanly so the parent's `'exit'` handler doesn't fire
      // a spurious crash entry.
      process.exit(0);
    });
  });
}
