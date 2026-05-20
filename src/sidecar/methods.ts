import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveRoot } from '../core/environment/index.js';
import { resolveMachinePaths } from '../core/paths/index.js';
import { AgentRunsRepository, agentRunsIndexPathFor } from '../domains/agent-runs/index.js';
import { ProfileManager } from '../domains/auth/index.js';
import { catalogPathsFor, readCatalog, readCatalogLock } from '../domains/catalog/index.js';
import {
  addSchedule,
  CronParseError,
  nextFire,
  parseCron,
  readSchedules,
  removeSchedule,
  type ScheduleEntry,
  ScheduleError,
  setEnabled as setScheduleEnabled,
  writeSchedules,
} from '../domains/scheduler/index.js';
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

  dispatcher.register('schedule.add', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as {
      id?: string;
      cron?: string;
      command?: string;
      description?: string;
      disabled?: boolean;
    };
    if (typeof params.id !== 'string' || params.id.length === 0) {
      throw new Error('schedule.add: params.id muss ein non-empty string sein');
    }
    if (typeof params.cron !== 'string' || params.cron.length === 0) {
      throw new Error('schedule.add: params.cron muss ein non-empty string sein');
    }
    if (typeof params.command !== 'string' || params.command.length === 0) {
      throw new Error('schedule.add: params.command muss ein non-empty string sein');
    }
    try {
      parseCron(params.cron);
    } catch (err) {
      if (err instanceof CronParseError) {
        throw new Error(`schedule.add: cron invalid — ${err.message}`);
      }
      throw err;
    }
    const machine = resolveMachinePaths();
    const store = readSchedules(machine.dataDir);
    const entry: ScheduleEntry = {
      id: params.id,
      cron: params.cron,
      command: params.command,
      createdAt: new Date().toISOString(),
      enabled: params.disabled !== true,
      ...(params.description === undefined ? {} : { description: params.description }),
    };
    try {
      writeSchedules(machine.dataDir, addSchedule(store, entry));
    } catch (err) {
      if (err instanceof ScheduleError) {
        throw new Error(`schedule.add: ${err.message}`);
      }
      throw err;
    }
    return { entry };
  });

  dispatcher.register('schedule.remove', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { id?: string };
    if (typeof params.id !== 'string' || params.id.length === 0) {
      throw new Error('schedule.remove: params.id muss ein non-empty string sein');
    }
    const machine = resolveMachinePaths();
    try {
      writeSchedules(machine.dataDir, removeSchedule(readSchedules(machine.dataDir), params.id));
    } catch (err) {
      if (err instanceof ScheduleError) {
        throw new Error(`schedule.remove: ${err.message}`);
      }
      throw err;
    }
    return { id: params.id, removed: true };
  });

  dispatcher.register('schedule.setEnabled', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { id?: string; enabled?: boolean };
    if (typeof params.id !== 'string' || params.id.length === 0) {
      throw new Error('schedule.setEnabled: params.id muss ein non-empty string sein');
    }
    if (typeof params.enabled !== 'boolean') {
      throw new Error('schedule.setEnabled: params.enabled muss boolean sein');
    }
    const machine = resolveMachinePaths();
    try {
      writeSchedules(
        machine.dataDir,
        setScheduleEnabled(readSchedules(machine.dataDir), params.id, params.enabled),
      );
    } catch (err) {
      if (err instanceof ScheduleError) {
        throw new Error(`schedule.setEnabled: ${err.message}`);
      }
      throw err;
    }
    return { id: params.id, enabled: params.enabled };
  });

  dispatcher.register('schedule.list', () => {
    const machine = resolveMachinePaths();
    const store = readSchedules(machine.dataDir);
    const enriched = store.entries.map((entry: ScheduleEntry) => {
      let next: string | null = null;
      try {
        const fire = nextFire(parseCron(entry.cron));
        next = fire === null ? null : fire.toISOString();
      } catch {
        next = null;
      }
      return { ...entry, next };
    });
    return { count: enriched.length, entries: enriched };
  });

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
