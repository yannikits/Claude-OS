/**
 * Server composer — assembles Fastify with auth, RPC, SSE, and static serve.
 *
 * This is the entry-point of the HTTP-variant. It owns the lifecycle of
 * the `RpcDispatcher` instance and the long-running services that the
 * sidecar normally hosts (scheduler, MCP watcher, inbox/outbox watchers).
 *
 * The dispatcher is the SAME class used by the stdio sidecar — only the
 * transport differs. See ADR-0032.
 *
 * @module @server
 */
import { randomBytes } from 'node:crypto';
import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { resolveRoot } from '../core/environment/index.js';
import { resolveMachinePaths } from '../core/paths/index.js';
import { McpTrustStore, mcpTrustPathFor, startMcpWatcher } from '../domains/mcp-clients/index.js';
import { startScheduler } from '../domains/scheduler/index.js';
import { ChatSessions } from '../sidecar/chat-sessions.js';
import { createSidecarLogger } from '../sidecar/logger.js';
import { registerMethods } from '../sidecar/methods.js';
import { PtyChatSessions } from '../sidecar/pty-chat-sessions.js';
import { RpcDispatcher } from '../sidecar/rpc.js';
import { type InboxOutboxWatchers, setupWatchers } from '../sidecar/watchers.js';

import { makeAuthHook } from './auth.js';
import { createNotificationBus, registerSseRoute } from './events-sse.js';
import { registerRpcRoutes } from './rpc-http.js';
import { registerStaticRoutes } from './static.js';
import type { ServerConfig } from './types.js';

export interface ServerHandle {
  readonly fastify: FastifyInstance;
  readonly url: string;
  shutdown(): Promise<void>;
}

interface BackgroundServices {
  readonly chatSessions: ChatSessions;
  readonly ptyChatSessions: PtyChatSessions | null;
  readonly watchers: InboxOutboxWatchers | null;
  readonly schedulerStop: () => Promise<void>;
  readonly mcpWatcherStop: () => Promise<void>;
}

async function startBackgroundServices(
  emit: (method: string, params: unknown) => void,
  logger: ReturnType<typeof createSidecarLogger> extends Promise<infer L> ? L : never,
): Promise<BackgroundServices> {
  const chatSessions = new ChatSessions(emit);
  logger.logger.info('server: chat-sessions ready');

  let ptyChatSessions: PtyChatSessions | null = null;
  try {
    ptyChatSessions = new PtyChatSessions(emit);
    logger.logger.info('server: pty-chat-sessions ready');
  } catch (err) {
    logger.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'server: pty-chat-sessions disabled (node-pty failed to load — headless env without pty support)',
    );
  }

  let watchers: InboxOutboxWatchers | null = null;
  try {
    watchers = setupWatchers(resolveRoot({}).path);
    logger.logger.info('server: inbox/outbox watchers running');
  } catch (err) {
    logger.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'server: watchers disabled',
    );
  }

  const schedulerHandle = startScheduler({
    dataDir: resolveMachinePaths().dataDir,
    emit: (event) => emit('schedule://event', event),
  });
  logger.logger.info('server: scheduler runner started');

  const probeTimeoutFromEnv = Number.parseInt(process.env.CLAUDE_OS_MCP_PROBE_TIMEOUT_MS ?? '', 10);
  const probeTimeoutMs =
    Number.isFinite(probeTimeoutFromEnv) && probeTimeoutFromEnv > 0 ? probeTimeoutFromEnv : 15_000;
  const mcpTrustStore = new McpTrustStore({
    filePath: mcpTrustPathFor(resolveMachinePaths().dataDir),
  });
  const mcpWatcherHandle = startMcpWatcher({
    emit: (event) => emit('mcp-client://event', event),
    projectCwd: resolveRoot({}).path,
    probeTimeoutMs,
    isTrusted: (serverKey) => mcpTrustStore.isAcknowledged(serverKey),
  });
  logger.logger.info({ probeTimeoutMs }, 'server: mcp watcher started');

  return {
    chatSessions,
    ptyChatSessions,
    watchers,
    schedulerStop: () => schedulerHandle.stop(),
    mcpWatcherStop: () => mcpWatcherHandle.stop(),
  };
}

export async function startServer(config: ServerConfig): Promise<ServerHandle> {
  if (config.authToken.length === 0) {
    throw new Error(
      'server: authToken must be non-empty. Set $CLAUDE_OS_AUTH_TOKEN before starting the server.',
    );
  }

  const sidecarLog = await createSidecarLogger();
  const log = sidecarLog.logger;
  log.info({ port: config.port, host: config.host }, 'server: booting');

  // Fastify gets its own logger config to avoid the FastifyChildLoggerFactory
  // generic mismatch when handing in our pino instance. The sidecar `log`
  // (above) continues to capture all non-Fastify server events.
  const fastify = Fastify({
    logger: { level: process.env.CLAUDE_OS_LOG_LEVEL ?? 'info' },
    trustProxy: config.trustProxy,
    disableRequestLogging: false,
    bodyLimit: 4 * 1024 * 1024,
  });

  if (config.corsOrigin !== null) {
    await fastify.register(fastifyCors, {
      origin: config.corsOrigin,
      credentials: false,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
  }

  const bus = createNotificationBus();
  const emit = (method: string, params: unknown): void => bus.emit(method, params);

  const dispatcher = new RpcDispatcher();
  dispatcher.register('ping', () => ({ pong: true, ts: Date.now() }));

  const services = await startBackgroundServices(emit, sidecarLog);

  registerMethods(dispatcher, {
    chatSessions: services.chatSessions,
    ...(services.ptyChatSessions !== null ? { ptyChatSessions: services.ptyChatSessions } : {}),
    emit,
  });

  // Public health-check (NO auth, NO domain info leak). Useful for nginx
  // proxy manager / cloudflare upstream health probes.
  fastify.get('/healthz', async () => ({ ok: true, ts: Date.now() }));

  // Gate every /api/* route behind Bearer-Token auth. The hook runs before
  // route handlers and short-circuits with 401 on rejection.
  const authHook = makeAuthHook(config.authToken);
  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    await authHook(req, reply);
  });

  registerRpcRoutes(fastify, dispatcher);
  registerSseRoute(fastify, { bus, heartbeatMs: config.sseHeartbeatMs });

  if (config.staticDir !== null) {
    await registerStaticRoutes(fastify, config.staticDir);
  }

  const address = await fastify.listen({ host: config.host, port: config.port });
  log.info({ address, subscribers: bus.subscriberCount() }, 'server: listening');

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    shutdownPromise = (async (): Promise<void> => {
      log.info('server: shutting down');
      await fastify.close();
      await services.chatSessions.shutdownAll();
      await services.ptyChatSessions?.shutdownAll();
      await services.schedulerStop();
      await services.mcpWatcherStop();
      await services.watchers?.close();
      log.info('server: shut down clean');
    })();
    return shutdownPromise;
  };

  return { fastify, url: address, shutdown };
}

/**
 * Generate a fresh server-token for first-time setup. 32-byte random,
 * hex-encoded → 64 chars. Match this against `$CLAUDE_OS_AUTH_TOKEN`
 * in the docker env.
 */
export function generateAuthToken(): string {
  return randomBytes(32).toString('hex');
}
