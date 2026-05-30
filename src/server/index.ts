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
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { resolveRoot } from '../core/environment/index.js';
import { resolveMachinePaths } from '../core/paths/index.js';
import {
  type ActionSink,
  createFiredActionLog,
  dispatchFiredAction,
  type FiredActionLog,
  loadRules,
  startAutomationEngine,
} from '../domains/automation/index.js';
import { McpTrustStore, mcpTrustPathFor, startMcpWatcher } from '../domains/mcp-clients/index.js';
import type { MspHealthAggregator } from '../domains/msp-aggregate/index.js';
import { startScheduler } from '../domains/scheduler/index.js';
import { resolveVaultRoot } from '../domains/workspace/index.js';
import { ChatSessions } from '../sidecar/chat-sessions.js';
import { createSidecarLogger } from '../sidecar/logger.js';
import { registerMethods } from '../sidecar/methods.js';
import { PtyChatSessions } from '../sidecar/pty-chat-sessions.js';
import { RpcDispatcher } from '../sidecar/rpc.js';
import { type InboxOutboxWatchers, setupWatchers } from '../sidecar/watchers.js';

import { makeAuthHook, parseTokenList } from './auth.js';
import { makeCookieAuthHook } from './cookie-auth.js';
import { createNotificationBus, registerSseRoute } from './events-sse.js';
import { registerAdminRoutes } from './routes-admin.js';
import { registerAuditRoutes } from './routes-audit.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerAutomationRoutes } from './routes-automation.js';
import { registerMspHealthRoutes } from './routes-msp-health.js';
import { registerInboxUpload, registerRpcRoutes } from './rpc-http.js';
import { registerStaticRoutes } from './static.js';
import type { ServerConfig } from './types.js';
import { registerPtyWebSocket } from './ws-pty.js';

export interface ServerHandle {
  readonly fastify: FastifyInstance;
  readonly url: string;
  shutdown(): Promise<void>;
}

interface BackgroundServices {
  readonly chatSessions: ChatSessions;
  readonly ptyChatSessions: PtyChatSessions | null;
  readonly watchers: InboxOutboxWatchers | null;
  readonly mcpWatcher: ReturnType<typeof startMcpWatcher> | null;
  readonly schedulerStop: () => Promise<void>;
  readonly mcpWatcherStop: () => Promise<void>;
  readonly automationStop: () => void;
}

/** Wiring for the automation engine; null disables it (no aggregator / no vault). */
interface AutomationWiring {
  readonly aggregator: MspHealthAggregator;
  readonly rulesDir: string;
  readonly firedLog: FiredActionLog;
}

async function startBackgroundServices(
  emit: (method: string, params: unknown) => void,
  logger: ReturnType<typeof createSidecarLogger> extends Promise<infer L> ? L : never,
  automation: AutomationWiring | null,
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

  // Automation engine (Phase MC-B): poll the cached aggregate snapshot, diff
  // against the prior tick, evaluate rules, dispatch fired actions. Only runs
  // when MSP-health is configured (aggregator present) and the vault resolves.
  let automationStop: () => void = () => {
    /* no-op when automation disabled */
  };
  if (automation !== null) {
    const sink: ActionSink = {
      alert: (fired) => emit('automation://alert', fired),
      audit: (fired) =>
        logger.logger.info({ automation: fired }, 'automation: rule fired (audit-log action)'),
    };
    const engine = startAutomationEngine({
      loadRules: () => {
        const { rules, errors } = loadRules(automation.rulesDir);
        for (const issue of errors) {
          logger.logger.warn(
            { file: issue.file, reason: issue.message },
            'automation: skipping invalid rule file',
          );
        }
        return rules;
      },
      getSnapshot: () => automation.aggregator.getSnapshot(),
      emit: (fired) => {
        automation.firedLog.record(fired);
        dispatchFiredAction(fired, sink);
      },
      onError: (err) =>
        logger.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'automation: tick failed (snapshot unavailable) — retrying next tick',
        ),
    });
    automationStop = engine.stop;
    logger.logger.info({ rulesDir: automation.rulesDir }, 'server: automation engine started');
  }

  const probeTimeoutFromEnv = Number.parseInt(process.env.CLAUDE_OS_MCP_PROBE_TIMEOUT_MS ?? '', 10);
  const probeTimeoutMs =
    Number.isFinite(probeTimeoutFromEnv) && probeTimeoutFromEnv > 0 ? probeTimeoutFromEnv : 15_000;

  // MCP-watcher needs a project root for discovery. In headless server
  // deployments resolveRoot() may legitimately fail (no marker file in
  // the container). Degrade gracefully — MCP-clients UI shows empty
  // and the server keeps running.
  let mcpWatcher: ReturnType<typeof startMcpWatcher> | null = null;
  let mcpWatcherStop: () => Promise<void> = async () => {
    /* no-op when watcher disabled */
  };
  try {
    const projectCwd = resolveRoot({}).path;
    const mcpTrustStore = new McpTrustStore({
      filePath: mcpTrustPathFor(resolveMachinePaths().dataDir),
    });
    mcpWatcher = startMcpWatcher({
      emit: (event) => emit('mcp-client://event', event),
      projectCwd,
      probeTimeoutMs,
      isTrusted: (serverKey) => mcpTrustStore.isAcknowledged(serverKey),
    });
    mcpWatcherStop = () => mcpWatcher?.stop() ?? Promise.resolve();
    logger.logger.info({ probeTimeoutMs }, 'server: mcp watcher started');
  } catch (err) {
    logger.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'server: mcp watcher disabled (no claude-os root — set $CLAUDE_OS_ROOT or create .claude-os-root marker)',
    );
  }

  return {
    chatSessions,
    ptyChatSessions,
    watchers,
    mcpWatcher,
    schedulerStop: () => schedulerHandle.stop(),
    mcpWatcherStop,
    automationStop,
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

  // Automation wiring: only when MSP-health is configured (aggregator owns the
  // probe cache) AND the vault resolves (rules live there). Either missing →
  // engine stays off. Vault resolution is best-effort: a headless server
  // without CLAUDE_OS_VAULT_PATH simply runs without automation.
  let automation: AutomationWiring | null = null;
  if (config.mspHealth !== undefined) {
    try {
      const vaultRoot = resolveVaultRoot();
      automation = {
        aggregator: config.mspHealth,
        rulesDir: join(vaultRoot, 'Claude-OS', 'automation', 'rules'),
        firedLog: createFiredActionLog(),
      };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'server: automation engine disabled (vault not configured)',
      );
    }
  }

  const services = await startBackgroundServices(emit, sidecarLog, automation);

  registerMethods(dispatcher, {
    chatSessions: services.chatSessions,
    ...(services.ptyChatSessions !== null ? { ptyChatSessions: services.ptyChatSessions } : {}),
    ...(services.mcpWatcher !== null ? { mcpWatcher: services.mcpWatcher } : {}),
    emit,
  });

  // Public health-check (NO auth, NO domain info leak). Useful for nginx
  // proxy manager / cloudflare upstream health probes.
  fastify.get('/healthz', async () => ({ ok: true, ts: Date.now() }));

  // Gate every /api/* route behind Bearer-Token auth. The hook runs before
  // route handlers and short-circuits with 401 on rejection. Multi-User
  // Stage 1: the env-var may carry a comma-separated list of valid tokens
  // (ADR-0033); the matched token's hash becomes req.tenant.
  //
  // Stage 2 (Phase Web-7-2 per ADR-0036 draft): when `config.multiUser` is
  // set, the cookie-first hook replaces the bearer-only one. Bearer remains
  // available as a fallback so service-tokens / CLI clients keep working.
  const expectedTokens = parseTokenList(config.authToken);
  if (expectedTokens.length === 0) {
    throw new Error('server: authToken parsed to empty list after CSV split');
  }
  if (config.multiUser !== undefined) {
    await fastify.register(fastifyCookie);
    log.info(
      { tokenCount: expectedTokens.length, insecureCookies: config.multiUser.insecureCookies },
      'server: multi-user Stage-2 enabled (cookie-first auth + email/password login)',
    );
    const cookieAuthHook = makeCookieAuthHook({
      expectedTokens,
      sessionRepo: config.multiUser.sessionRepo,
      userRepo: config.multiUser.userRepo,
    });
    fastify.addHook('preHandler', cookieAuthHook);
    registerAuthRoutes(fastify, {
      userRepo: config.multiUser.userRepo,
      sessionRepo: config.multiUser.sessionRepo,
      rateLimiter: config.multiUser.rateLimiter,
      ...(config.multiUser.audit !== undefined ? { audit: config.multiUser.audit } : {}),
      insecureCookies: config.multiUser.insecureCookies,
      sessionMaxAgeSec: config.multiUser.sessionMaxAgeSec,
      ...(config.multiUser.allowRegistration === true
        ? {
            allowRegistration: true,
            ...(config.multiUser.registrationRateLimiter !== undefined
              ? { registrationRateLimiter: config.multiUser.registrationRateLimiter }
              : {}),
          }
        : {}),
      ...(config.multiUser.adminEmails !== undefined
        ? { adminEmails: config.multiUser.adminEmails }
        : {}),
    });
    if (config.multiUser.adminEmails !== undefined && config.multiUser.adminEmails.length > 0) {
      registerAdminRoutes(fastify, {
        userRepo: config.multiUser.userRepo,
        sessionRepo: config.multiUser.sessionRepo,
        ...(config.multiUser.audit !== undefined ? { audit: config.multiUser.audit } : {}),
        adminEmails: config.multiUser.adminEmails,
      });
      registerAuditRoutes(fastify, { adminEmails: config.multiUser.adminEmails });
      if (config.mspHealth !== undefined) {
        registerMspHealthRoutes(fastify, {
          adminEmails: config.multiUser.adminEmails,
          aggregator: config.mspHealth,
        });
      }
      if (automation !== null) {
        registerAutomationRoutes(fastify, {
          adminEmails: config.multiUser.adminEmails,
          rulesDir: automation.rulesDir,
          firedLog: automation.firedLog,
        });
      }
      log.info(
        {
          adminCount: config.multiUser.adminEmails.length,
          mspHealth: config.mspHealth !== undefined,
        },
        'server: admin HTTP API + audit-trail enabled (Web-7-7 + audit-dashboard)',
      );
    }
  } else {
    log.info(
      { tokenCount: expectedTokens.length },
      expectedTokens.length === 1
        ? 'server: single-user auth (1 token)'
        : `server: multi-user-stage-1 auth (${expectedTokens.length} tokens)`,
    );
    const authHook = makeAuthHook(expectedTokens);
    fastify.addHook('preHandler', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      await authHook(req, reply);
    });
  }

  registerRpcRoutes(fastify, dispatcher);
  await registerInboxUpload(fastify, dispatcher);
  registerSseRoute(fastify, { bus, heartbeatMs: config.sseHeartbeatMs });

  // WebSocket bridge for interactive PTY sessions (Phase Web-3).
  // Register only when node-pty actually loaded — on a fully-headless
  // host the plugin would still expose the upgrade endpoint and the
  // /api/pty/ws handler would tell the client "pty-disabled", which is
  // fine. We register unconditionally so the route exists.
  await fastify.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 1024 },
  });
  await registerPtyWebSocket(fastify, {
    pty: services.ptyChatSessions,
    bus,
    expectedToken: config.authToken,
    ...(config.multiUser !== undefined
      ? {
          sessionRepo: config.multiUser.sessionRepo,
          userRepo: config.multiUser.userRepo,
        }
      : {}),
  });

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
      services.automationStop();
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
