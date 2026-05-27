import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runSkillInSandbox,
  SandboxError,
} from '../../../../src/domains/skill-lifecycle/sandbox/index.js';

/**
 * Smoke-Test of the runner using inline-written worker-entry + skill
 * scripts so we don't depend on `dist/` being built. The production
 * worker-entry.ts is tested via its own contract (parent sees ok or
 * error) — here we simulate it with a minimal inline .mjs.
 *
 * Gated tests (real fork + real timeout):
 *   `RUN_SLOW_TESTS=1 vitest run tests/domains/skill-lifecycle/sandbox/runner.test.ts`
 *
 * Default `npm test` skips the runner-test (slow ~3-5s with fork
 * startup) — pre-fork validation still runs unconditionally below.
 */

const RUN_SLOW = process.env.RUN_SLOW_TESTS === '1';

describe('runSkillInSandbox — pre-fork validation', () => {
  it('rejects invalid skill-id before fork', async () => {
    await expect(
      runSkillInSandbox(
        {
          skillScriptPath: join(tmpdir(), 'sandbox', 'skill.mjs'),
          skillId: 'bad id!',
          input: {},
        },
        { sandboxRoot: tmpdir() },
      ),
    ).rejects.toThrow(SandboxError);
  });

  it('rejects relative sandbox-root before fork', async () => {
    await expect(
      runSkillInSandbox(
        {
          skillScriptPath: join(tmpdir(), 'skill.mjs'),
          skillId: 'ok',
          input: {},
        },
        { sandboxRoot: './relative' },
      ),
    ).rejects.toThrow(SandboxError);
  });

  it('rejects path outside sandbox-root before fork', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-root-'));
    try {
      await expect(
        runSkillInSandbox(
          {
            skillScriptPath: process.platform === 'win32' ? 'C:\\Windows\\evil.mjs' : '/etc/passwd',
            skillId: 'ok',
            input: {},
          },
          { sandboxRoot: root },
        ),
      ).rejects.toThrow(SandboxError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!RUN_SLOW)('runSkillInSandbox — real fork (gated)', () => {
  let root: string;
  let workerEntry: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-real-'));
    // Inline worker-entry: minimal contract — receives request, loads
    // the skill, sends back the result. Matches the production
    // worker-entry.ts shape so this smoke verifies the same protocol.
    workerEntry = join(root, 'worker-entry.mjs');
    writeFileSync(
      workerEntry,
      `
        process.on('message', async (msg) => {
          try {
            const mod = await import(msg.skillScriptPath);
            const run = mod.default ?? mod.run;
            const output = await run(msg.input);
            process.send({ kind: 'ok', output });
          } catch (err) {
            process.send({ kind: 'error', message: err.message });
          }
          process.exit(0);
        });
      `,
      'utf8',
    );
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('runs a simple skill and returns its output', async () => {
    const skillScriptPath = join(root, 'echo.mjs');
    writeFileSync(
      skillScriptPath,
      `export default async function run(input) { return { echo: input }; }`,
      'utf8',
    );

    const result = await runSkillInSandbox(
      { skillScriptPath, skillId: 'echo', input: { hello: 'world' } },
      { sandboxRoot: root, workerEntry, timeoutMs: 5_000 },
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.output).toEqual({ echo: { hello: 'world' } });
    }
  }, 15_000);

  it('kills the child on timeout', async () => {
    const skillScriptPath = join(root, 'hang.mjs');
    writeFileSync(
      skillScriptPath,
      `export default async function run() {
        await new Promise((r) => setTimeout(r, 10_000));
        return 'never';
      }`,
      'utf8',
    );

    const result = await runSkillInSandbox(
      { skillScriptPath, skillId: 'hang', input: null },
      { sandboxRoot: root, workerEntry, timeoutMs: 500 },
    );

    expect(result.status).toBe('timeout');
    if (result.status === 'timeout') {
      expect(result.killedBy).toBe('timeout');
      expect(result.durationMs).toBeGreaterThanOrEqual(500);
    }
  }, 15_000);

  it('reports skill-run errors as status=error', async () => {
    const skillScriptPath = join(root, 'boom.mjs');
    writeFileSync(
      skillScriptPath,
      `export default async function run() { throw new Error('intentional boom'); }`,
      'utf8',
    );

    const result = await runSkillInSandbox(
      { skillScriptPath, skillId: 'boom', input: null },
      { sandboxRoot: root, workerEntry, timeoutMs: 5_000 },
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.errorMessage).toContain('intentional boom');
    }
  }, 15_000);

  it('strips CLAUDE_OS_AUTH_TOKEN from child env (m13 secret-strip)', async () => {
    const skillScriptPath = join(root, 'env-leak.mjs');
    writeFileSync(
      skillScriptPath,
      `export default async function run() {
        return {
          authTokenInEnv: process.env.CLAUDE_OS_AUTH_TOKEN ?? null,
          sandboxFlag: process.env.CLAUDE_OS_SANDBOX ?? null,
        };
      }`,
      'utf8',
    );

    const before = process.env.CLAUDE_OS_AUTH_TOKEN;
    process.env.CLAUDE_OS_AUTH_TOKEN = 'super-secret-12345';
    try {
      const result = await runSkillInSandbox(
        { skillScriptPath, skillId: 'env-leak', input: null },
        { sandboxRoot: root, workerEntry, timeoutMs: 5_000 },
      );
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        const out = result.output as { authTokenInEnv: string | null; sandboxFlag: string };
        expect(out.authTokenInEnv).toBeNull();
        expect(out.sandboxFlag).toBe('1');
      }
    } finally {
      if (before === undefined) {
        process.env.CLAUDE_OS_AUTH_TOKEN = undefined;
      } else {
        process.env.CLAUDE_OS_AUTH_TOKEN = before;
      }
    }
  }, 15_000);
});
