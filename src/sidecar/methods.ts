/**
 * Sidecar RPC-method Orchestrator.
 *
 * M21 (2026-05-21 code-review): Vorher 549 LOC in einer Datei mit allen
 * Dispatchern. Jetzt thin orchestrator der per-namespace `methods/<name>.ts`
 * Module komponiert. Public API (`registerMethods`) unveraendert.
 *
 * @module @sidecar/methods
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveMachinePaths } from '../core/paths/index.js';
import { AgentRunsRepository, agentRunsIndexPathFor } from '../domains/agent-runs/index.js';
import type { readCatalog, readCatalogLock } from '../domains/catalog/index.js';
import type { WatcherHandle } from '../domains/mcp-clients/index.js';
import type { readSchedules } from '../domains/scheduler/index.js';
import type { loadVaultConfig } from '../domains/vault-sync/index.js';
import type { ChatSessions } from './chat-sessions.js';
import type { MemoryIndexService } from './memory-index-service.js';
import { type MethodsContext, rootPath } from './methods/_shared.js';
import { registerAgentMethods } from './methods/agent.js';
import { registerAuthMethods } from './methods/auth.js';
import { registerCatalogMethods } from './methods/catalog.js';
import { registerChatMethods } from './methods/chat.js';
import { registerInboxMethods } from './methods/inbox.js';
import { registerMcpMethods } from './methods/mcp.js';
import { registerMemoryMethods } from './methods/memory.js';
import { registerNotesMethods } from './methods/notes.js';
import { registerPtyMethods } from './methods/pty.js';
import { registerRetrievalMethods } from './methods/retrieval.js';
import { registerScheduleMethods } from './methods/schedule.js';
import { registerSecretsMethods } from './methods/secrets.js';
import { registerSettingsMethods } from './methods/settings.js';
import { registerVaultMethods } from './methods/vault.js';
import { registerWorkspaceMethods } from './methods/workspace.js';
import { createMtimeCache } from './mtime-cache.js';
import type { PtyChatSessions } from './pty-chat-sessions.js';
import type { RpcDispatcher } from './rpc.js';

interface MethodOpts {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Optional ChatSessions instance (v1.2 MVP) — chat.* RPCs only registered when provided. */
  readonly chatSessions?: ChatSessions;
  /** Optional PtyChatSessions instance (v1.x) — pty.* RPCs only registered when provided. */
  readonly ptyChatSessions?: PtyChatSessions;
  /** Optional MCP-Watcher handle (v1.7) — mcp.clients.status only registered when provided. */
  readonly mcpWatcher?: WatcherHandle;
  /**
   * Notification emitter — written to stdout as a JSON-RPC notification
   * (no `id`). Workspace switches emit `workspace://switched`. When
   * omitted (e.g. tests), notifications are dropped silently.
   */
  readonly emit?: (method: string, params: unknown) => void;
  /** Optional MemoryIndexService (Phase 3f) — memory.* RPCs only when provided. */
  readonly memoryIndex?: MemoryIndexService;
}

export function registerMethods(dispatcher: RpcDispatcher, opts: MethodOpts = {}): void {
  // M14 (2026-05-21 code-review): mtime-keyed caches fuer haeufig
  // gepollte konfigurations-files. Pro registerMethods-call eigene
  // cache-Instanzen — bei sidecar-restart (Tauri-shell-relaunch) sind
  // sie weg, das ist die User-Aktion fuer "fresh state".
  const catalogCache = createMtimeCache<ReturnType<typeof readCatalog>>();
  const catalogLockCache = createMtimeCache<ReturnType<typeof readCatalogLock>>();
  const vaultConfigCache = createMtimeCache<ReturnType<typeof loadVaultConfig>>();
  const schedulesCache = createMtimeCache<ReturnType<typeof readSchedules>>();

  // M13 (2026-05-21 code-review): AgentRunsRepository wird einmal pro
  // Sidecar-Lifetime instanziert, NICHT pro RPC-Call. Vorher wurde
  // `new AgentRunsRepository()` bei jedem agent.list aufgerufen — und
  // dessen loadOrRebuild walked alle JSONLs wenn der on-disk-Index
  // fehlt/korrupt. Mit Singleton bleibt der Index-State im Speicher.
  let agentRunsRepoCache: AgentRunsRepository | null = null;

  const ctx: MethodsContext = {
    env: () => opts.env ?? process.env,
    home: () => opts.home ?? homedir(),
    rootPath,
    machinePaths: () => resolveMachinePaths(),
    catalogCache,
    catalogLockCache,
    vaultConfigCache,
    schedulesCache,
    getAgentRunsRepo: () => {
      if (agentRunsRepoCache !== null) return agentRunsRepoCache;
      const r = rootPath();
      const machine = resolveMachinePaths();
      agentRunsRepoCache = new AgentRunsRepository({
        agentRunsRoot: join(r, 'vault', 'agent-runs'),
        indexPath: agentRunsIndexPathFor(machine.dataDir),
        vaultRoot: join(r, 'vault'),
      });
      return agentRunsRepoCache;
    },
  };

  registerCatalogMethods(dispatcher, ctx);
  registerVaultMethods(dispatcher, ctx);
  registerInboxMethods(dispatcher, ctx);
  registerSettingsMethods(dispatcher, ctx);
  registerSecretsMethods(dispatcher, ctx);
  if (opts.chatSessions !== undefined) registerChatMethods(dispatcher, opts.chatSessions);
  if (opts.ptyChatSessions !== undefined) {
    registerPtyMethods(dispatcher, opts.ptyChatSessions);
    registerAuthMethods(dispatcher, ctx, { ptyChatSessions: opts.ptyChatSessions });
  }
  registerScheduleMethods(dispatcher, ctx);
  if (opts.mcpWatcher !== undefined) registerMcpMethods(dispatcher, opts.mcpWatcher);
  registerAgentMethods(dispatcher, ctx);

  // Phase 2f (Memory MVP GUI surface). These live on top of the Phase
  // 2a–2c domains and have no side-effects when the vault is not yet
  // configured — RPCs throw a WorkspaceError that the GUI renders as a
  // setup hint instead of crashing the supervisor.
  registerWorkspaceMethods(dispatcher, opts.emit ?? (() => {}));
  registerNotesMethods(dispatcher);
  registerRetrievalMethods(dispatcher);

  // Phase 3f (Memory FTS). Memory.* RPCs only registered when the sidecar
  // has actually booted a MemoryIndexService (vault-configured + db open).
  if (opts.memoryIndex !== undefined) registerMemoryMethods(dispatcher, opts.memoryIndex);
}
