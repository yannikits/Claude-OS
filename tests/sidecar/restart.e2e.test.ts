import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.RUN_SLOW_TESTS === '1';
const SIDECAR_JS = resolve(__dirname, '../../dist/sidecar/index.js');
const RESTART_BUDGET_MS = 5_000;

class SidecarHarness {
  child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private pending = new Map<number, (line: unknown) => void>();
  private nextId = 1;

  start(): void {
    this.child = spawn(process.execPath, [SIDECAR_JS], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_OS_SECRETS_BACKEND: 'file' },
    });
    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      for (;;) {
        const nl = this.buf.indexOf('\n');
        if (nl === -1) break;
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let env: { id?: number };
        try {
          env = JSON.parse(line);
        } catch {
          continue;
        }
        if (env.id !== undefined) {
          const resolver = this.pending.get(env.id);
          if (resolver) {
            this.pending.delete(env.id);
            resolver(env);
          }
        }
      }
    });
  }

  async call(method: string, params: unknown = null, timeoutMs = 2_000): Promise<unknown> {
    const child = this.child;
    if (!child) throw new Error('sidecar not spawned');
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolveResult, rejectResult) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        rejectResult(new Error(`rpc.call(${method}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (v) => {
        clearTimeout(timeoutHandle);
        resolveResult(v);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    return new Promise((res) => {
      child.on('exit', () => res());
      child.kill();
    });
  }
}

describe.skipIf(!RUN || !existsSync(SIDECAR_JS))(
  'sidecar restart e2e (gated: RUN_SLOW_TESTS=1 + dist/sidecar/index.js)',
  () => {
    const harness1 = new SidecarHarness();
    const harness2 = new SidecarHarness();

    beforeAll(() => {
      harness1.start();
    });

    afterAll(async () => {
      await harness1.stop();
      await harness2.stop();
    });

    it('first sidecar responds to ping', async () => {
      const res = (await harness1.call('ping')) as { result?: { pong: boolean } };
      expect(res.result?.pong).toBe(true);
    });

    it('respawned sidecar responds to ping within the 5s restart budget', async () => {
      await harness1.stop();
      const start = Date.now();
      harness2.start();
      const res = (await harness2.call('ping')) as { result?: { pong: boolean } };
      const elapsed = Date.now() - start;
      expect(res.result?.pong).toBe(true);
      expect(elapsed).toBeLessThan(RESTART_BUDGET_MS);
    });
  },
);
