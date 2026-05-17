import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

export interface WatcherEmitter {
  emit(method: string, params: unknown): void;
}

export const stdoutEmitter: WatcherEmitter = {
  emit(method, params) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  },
};

export interface InboxOutboxWatchers {
  inbox: FSWatcher;
  outbox: FSWatcher;
  close(): Promise<void>;
}

export function setupWatchers(
  rootPath: string,
  emitter: WatcherEmitter = stdoutEmitter,
): InboxOutboxWatchers {
  const inboxPath = join(rootPath, 'inbox');
  const outboxPath = join(rootPath, 'outbox');
  mkdirSync(inboxPath, { recursive: true });
  mkdirSync(outboxPath, { recursive: true });

  const make = (dir: string, channel: 'inbox://changed' | 'outbox://changed'): FSWatcher => {
    const w = chokidar.watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: ['**/.*'],
    });
    for (const ev of ['add', 'change', 'unlink'] as const) {
      w.on(ev, (path) => emitter.emit(channel, { event: ev, path }));
    }
    return w;
  };

  const inbox = make(inboxPath, 'inbox://changed');
  const outbox = make(outboxPath, 'outbox://changed');

  return {
    inbox,
    outbox,
    async close() {
      await Promise.all([inbox.close(), outbox.close()]);
    },
  };
}
