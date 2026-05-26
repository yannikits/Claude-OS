/**
 * Server-Sent-Events stream for sidecar notifications.
 *
 * The sidecar emits notifications via `emitNotification(method, params)` —
 * in Tauri-mode those go to stdout as JSON-RPC envelopes without `id`. In
 * server-mode we route the same call into the SSE-subscriber-set; each
 * connected browser receives the event with `event: <method>` and
 * `data: <json-params>`.
 *
 * Heartbeats: emit `: heartbeat` comment-line every `sseHeartbeatMs` to
 * keep cloudflare-proxied connections alive (CF idle-timeout 100s) and
 * detect dead clients so we can release subscriber-slots.
 *
 * @module @server/events-sse
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface NotificationBus {
  /** Used by sidecar wiring: methods.ts emits via this signature. */
  emit(method: string, params: unknown): void;
  /** Internal: subscribe a fresh SSE-reply. Returns an unsubscribe fn. */
  subscribe(handler: (method: string, params: unknown) => void): () => void;
  /** Active subscriber count (introspection / tests). */
  subscriberCount(): number;
}

export function createNotificationBus(): NotificationBus {
  const subscribers = new Set<(method: string, params: unknown) => void>();
  return {
    emit(method, params) {
      for (const handler of subscribers) {
        try {
          handler(method, params);
        } catch {
          // A single subscriber misbehaving must not crash siblings or
          // the sidecar emitter. Errors here are dropped silently —
          // disconnected clients are cleaned up via subscribe-return.
        }
      }
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}

interface SseRouteOptions {
  readonly bus: NotificationBus;
  readonly heartbeatMs: number;
}

export function registerSseRoute(app: FastifyInstance, opts: SseRouteOptions): void {
  app.get('/api/events', async (req, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);

    const writeEvent = (method: string, params: unknown): void => {
      const data = JSON.stringify(params ?? null);
      reply.raw.write(`event: ${method}\n`);
      reply.raw.write(`data: ${data}\n\n`);
    };

    const unsubscribe = opts.bus.subscribe(writeEvent);

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, opts.heartbeatMs);
    heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    return reply;
  });
}
