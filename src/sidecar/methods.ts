import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveRoot } from '../core/environment/index.js';
import { resolveMachinePaths } from '../core/paths/index.js';
import { AgentRunsRepository, agentRunsIndexPathFor } from '../domains/agent-runs/index.js';
import { ProfileManager } from '../domains/auth/index.js';
import { catalogPathsFor, readCatalog, readCatalogLock } from '../domains/catalog/index.js';
import { createSecretStore } from '../domains/secrets/index.js';
import { SecretsLockedError } from '../domains/secrets/types.js';
import { BusyFlag, loadVaultConfig } from '../domains/vault-sync/index.js';
import type { ChatSessions } from './chat-sessions.js';
import type { RpcDispatcher } from './rpc.js';

interface MethodOpts {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Optional ChatSessions instance (v1.2 MVP) — chat.* RPCs only registered when provided. */
  readonly chatSessions?: ChatSessions;
}

function rootPath(): string {
  return resolveRoot({}).path;
}

export function registerMethods(dispatcher: RpcDispatcher, opts: MethodOpts = {}): void {
  const env = (): NodeJS.ProcessEnv => opts.env ?? process.env;
  const home = (): string => opts.home ?? homedir();
  dispatcher.register('catalog.list', () => {
    const paths = catalogPathsFor(rootPath());
    const catalog = readCatalog(paths.catalogPath);
    const lock = readCatalogLock(paths.lockPath);
    return {
      catalogPath: paths.catalogPath,
      lockPath: paths.lockPath,
      lockResolvedAt: lock?.resolvedAt ?? null,
      entries: catalog.entries,
    };
  });

  dispatcher.register('vault.status', () => {
    const root = rootPath();
    const machine = resolveMachinePaths();
    const vaultPath = join(root, 'vault');
    const busyFlagPath = join(machine.dataDir, 'vault-sync-state.json');
    const configPath = join(machine.dataDir, 'vault-config.json');
    const busy = new BusyFlag({ filePath: busyFlagPath }).read();
    const config = loadVaultConfig(configPath);
    return { vaultPath, busy, config };
  });

  dispatcher.register('inbox.import', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { paths?: readonly string[] };
    if (!Array.isArray(params.paths)) {
      throw new Error('inbox.import: params.paths must be a string[]');
    }
    const inboxDir = join(rootPath(), 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const written: string[] = [];
    for (const src of params.paths) {
      const dest = join(inboxDir, `${stamp}-${basename(src)}`);
      copyFileSync(src, dest);
      written.push(dest);
    }
    return { count: written.length, paths: written };
  });

  dispatcher.register('settings.read', () => {
    const machine = resolveMachinePaths();
    const profileMgr = new ProfileManager({ dataRoot: machine.dataDir });
    const activeProfile = profileMgr.active();
    const profiles = profileMgr.list();
    const e = env();
    const h = home();
    const envOverride = e.ANTHROPIC_CONFIG_DIR ?? null;
    const resolvedAnthropicConfigDir =
      envOverride ?? profileMgr.resolveEnvOverride() ?? join(h, '.claude');
    const credentialsFile = join(resolvedAnthropicConfigDir, '.credentials.json');
    const credentialsFileExists = existsSync(credentialsFile);
    const secretsBackend = createSecretStore({ env: e }).backend;
    const secretsBackendOverride = e.CLAUDE_OS_SECRETS_BACKEND ?? null;

    const claudeCodeRoots = [
      { label: 'global', path: join(h, '.claude') },
      { label: 'project', path: join(rootPath(), '.claude') },
    ];
    const claudeCodeSettings = claudeCodeRoots.flatMap(({ label, path }) => {
      const files: {
        scope: string;
        name: string;
        path: string;
        exists: boolean;
        mtime: string | null;
        size: number | null;
      }[] = [];
      for (const name of ['settings.json', 'settings.local.json']) {
        const full = join(path, name);
        let exists = false;
        let mtime: string | null = null;
        let size: number | null = null;
        try {
          const s = statSync(full);
          exists = true;
          mtime = s.mtime.toISOString();
          size = s.size;
        } catch {
          // not present — leave defaults
        }
        files.push({ scope: label, name, path: full, exists, mtime, size });
      }
      return files;
    });

    return {
      anthropic: {
        resolvedConfigDir: resolvedAnthropicConfigDir,
        envOverride,
        activeProfile,
        availableProfiles: profiles.map((p) => ({ name: p.name, active: p.active })),
        credentialsFile,
        credentialsFileExists,
      },
      secrets: {
        backend: secretsBackend,
        envOverride: secretsBackendOverride,
      },
      claudeCodeSettings,
    };
  });

  dispatcher.register('secrets.list', async () => {
    const store = createSecretStore({ env: env() });
    try {
      const entries = await store.list();
      // SecretMetadata is already values-free: { key, backend } only. Returning it
      // verbatim is safe per ADR-0004 §51 — never log or expose values.
      return {
        backend: store.backend,
        count: entries.length,
        entries,
        locked: false as const,
      };
    } catch (err) {
      if (err instanceof SecretsLockedError) {
        return {
          backend: store.backend,
          count: 0,
          entries: [],
          locked: true as const,
          lockedReason: err.message,
        };
      }
      throw err;
    }
  });

  dispatcher.register('secrets.delete', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { key?: string };
    if (typeof params.key !== 'string' || params.key.length === 0) {
      throw new Error('secrets.delete: params.key must be a non-empty string');
    }
    const store = createSecretStore({ env: env() });
    const deleted = await store.delete(params.key);
    return { key: params.key, deleted, backend: store.backend };
  });

  if (opts.chatSessions !== undefined) {
    const chat = opts.chatSessions;
    dispatcher.register('chat.spawn', (rawParams: unknown) => {
      const params = (rawParams ?? {}) as { args?: readonly string[] };
      const args = Array.isArray(params.args) ? params.args : [];
      return chat.spawn(args);
    });
    dispatcher.register('chat.write', (rawParams: unknown) => {
      const params = (rawParams ?? {}) as { sessionId?: string; input?: string };
      if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) {
        throw new Error('chat.write: params.sessionId must be a non-empty string');
      }
      if (typeof params.input !== 'string') {
        throw new Error('chat.write: params.input must be a string');
      }
      chat.write(params.sessionId, params.input);
      return { ok: true as const };
    });
    dispatcher.register('chat.kill', (rawParams: unknown) => {
      const params = (rawParams ?? {}) as { sessionId?: string };
      if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) {
        throw new Error('chat.kill: params.sessionId must be a non-empty string');
      }
      chat.kill(params.sessionId);
      return { ok: true as const };
    });
  }

  dispatcher.register('agent.list', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { project?: string; limit?: number };
    const root = rootPath();
    const machine = resolveMachinePaths();
    const repo = new AgentRunsRepository({
      agentRunsRoot: join(root, 'vault', 'agent-runs'),
      indexPath: agentRunsIndexPathFor(machine.dataDir),
      vaultRoot: join(root, 'vault'),
    });
    const items = repo.list({
      ...(params.project === undefined ? {} : { project: params.project }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return { count: items.length, items };
  });
}
