import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type InboxOutboxWatchers,
  setupWatchers,
  type WatcherEmitter,
} from '../../src/sidecar/watchers.js';

interface Emission {
  method: string;
  params: { event: string; path: string };
}

function makeEmitter(): { emitter: WatcherEmitter; emissions: Emission[] } {
  const emissions: Emission[] = [];
  const emitter: WatcherEmitter = {
    emit(method, params) {
      emissions.push({ method, params: params as Emission['params'] });
    },
  };
  return { emitter, emissions };
}

function waitFor<T>(predicate: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const val = predicate();
      if (val !== null && val !== undefined) {
        resolve(val);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('setupWatchers', () => {
  let root: string;
  let watchers: InboxOutboxWatchers | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-os-watchers-'));
  });

  afterEach(async () => {
    await watchers?.close();
    watchers = null;
    rmSync(root, { recursive: true, force: true });
  });

  it('creates inbox and outbox directories if missing', () => {
    const { emitter } = makeEmitter();
    watchers = setupWatchers(root, emitter);
    expect(watchers.inbox).toBeDefined();
    expect(watchers.outbox).toBeDefined();
  });

  it('emits inbox://changed with event=add when a file appears in inbox/', async () => {
    const { emitter, emissions } = makeEmitter();
    watchers = setupWatchers(root, emitter);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(root, 'inbox', 'hello.txt'), 'hi');
    const inboxEmission = await waitFor(() =>
      emissions.find((e) => e.method === 'inbox://changed' && e.params.event === 'add'),
    );
    expect(inboxEmission.params.path).toMatch(/hello\.txt$/);
  });

  it('emits outbox://changed when a file appears in outbox/', async () => {
    const { emitter, emissions } = makeEmitter();
    watchers = setupWatchers(root, emitter);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(root, 'outbox', 'reply.txt'), 'ok');
    const outboxEmission = await waitFor(() =>
      emissions.find((e) => e.method === 'outbox://changed' && e.params.event === 'add'),
    );
    expect(outboxEmission.params.path).toMatch(/reply\.txt$/);
  });
});
