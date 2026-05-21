import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { copyFile as fspCopyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { resolveRoot } from '../core/environment/index.js';
import { resolveMachinePaths } from '../core/paths/index.js';
import { AgentRunsRepository, agentRunsIndexPathFor } from '../domains/agent-runs/index.js';
import { ProfileManager } from '../domains/auth/index.js';
import {
  AutoDepsInstallError,
  catalogPathsFor,
  InvalidCatalogError,
  installFromGithubWithAutoDeps,
  readCatalog,
  readCatalogLock,
  removeCatalogEntry,
  tarballCacheDirFor,
  UnknownCatalogEntryError,
} from '../domains/catalog/index.js';
import type { WatcherHandle } from '../domains/mcp-clients/index.js';
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
import { createSecretStore, SecretsLockedError } from '../domains/secrets/index.js';
import { BusyFlag, loadVaultConfig } from '../domains/vault-sync/index.js';
import type { ChatSessions } from './chat-sessions.js';
import type { RpcDispatcher } from './rpc.js';

interface MethodOpts {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Optional ChatSessions instance (v1.2 MVP) — chat.* RPCs only registered when provided. */
  readonly chatSessions?: ChatSessions;
  /** Optional MCP-Watcher handle (v1.7) — mcp.clients.status only registered when provided. */
  readonly mcpWatcher?: WatcherHandle;
}

function rootPath(): string {
  return resolveRoot({}).path;
}

/**
 * Canonicalisiert eine Liste von Root-Pfaden via `realpathSync`. Fehler
 * (z. B. wenn die Pfad noch nicht existiert) werden geschluckt: dann
 * bleibt der raw-Pfad in der Liste — `isUnder` wird sich auf Mismatch
 * konservativ verhalten.
 */
function canonicalizeRoots(roots: readonly string[]): readonly string[] {
  return roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
}

/**
 * C2 (2026-05-21 code-review): true wenn `candidate` denselben Pfad ODER
 * eine Subdirectory von `root` ist. Beide muessen bereits canonical /
 * absolute sein. Plattform-unabhaengig via `path.relative`.
 */
function isUnder(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  // Auf Windows kann relative absolute paths zurueckgeben (verschiedene
  // Laufwerke). Solche Pfade sind NICHT unter `root`.
  if (/^[A-Za-z]:[/\\]/.test(rel) || rel.startsWith('/')) return false;
  return true;
}

export function registerMethods(dispatcher: RpcDispatcher, opts: MethodOpts = {}): void {
  const env = (): NodeJS.ProcessEnv => opts.env ?? process.env;
  const home = (): string => opts.home ?? homedir();
  dispatcher.register('catalog.list', () => {
    const paths = catalogPathsFor(rootPath());
    // M11 (2026-05-21 code-review): InvalidCatalogError propagiert sonst
    // den File-Path in der Error-Message — RPC-Peers (GUI) bekommen die
    // interne Pfad-Struktur zu sehen. Catch + opaque error-shape, success
    // shape bleibt back-compat-stabil.
    try {
      const catalog = readCatalog(paths.catalogPath);
      const lock = readCatalogLock(paths.lockPath);
      return {
        catalogPath: paths.catalogPath,
        lockPath: paths.lockPath,
        lockResolvedAt: lock?.resolvedAt ?? null,
        entries: catalog.entries,
      };
    } catch (err) {
      if (err instanceof InvalidCatalogError) {
        return { ok: false as const, code: 'invalid-catalog' as const };
      }
      throw err;
    }
  });

  dispatcher.register('catalog.removeEntry', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { id?: string };
    if (typeof params.id !== 'string' || params.id.length === 0) {
      throw new Error('catalog.removeEntry: params.id muss ein non-empty string sein');
    }
    // m16 (2026-05-21 code-review): id-pattern matched gegen
    // CatalogEntrySchema (`^[A-Za-z0-9._-]+$`). Defense gegen Inject-
    // Attempts via crafted id (z. B. path-traversal-Segmente in
    // catalog.json-Lookups).
    if (!/^[A-Za-z0-9._-]+$/.test(params.id)) {
      throw new Error(
        `catalog.removeEntry: params.id "${params.id}" enthaelt invalid characters (allowed: A-Za-z0-9._-)`,
      );
    }
    const paths = catalogPathsFor(rootPath());
    try {
      const result = removeCatalogEntry(paths.catalogPath, params.id);
      return { ok: true as const, id: params.id, removedEntry: result.removed };
    } catch (err) {
      if (err instanceof UnknownCatalogEntryError) {
        return { ok: false as const, code: 'unknown-id', id: params.id, message: err.message };
      }
      throw err;
    }
  });

  dispatcher.register('catalog.installAutoDeps', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { source?: string; registryPath?: string };
    if (typeof params.source !== 'string' || params.source.length === 0) {
      throw new Error('catalog.installAutoDeps: params.source muss ein non-empty string sein');
    }
    if (typeof params.registryPath !== 'string' || params.registryPath.length === 0) {
      throw new Error(
        'catalog.installAutoDeps: params.registryPath muss ein non-empty string sein',
      );
    }
    const root = rootPath();
    const machine = resolveMachinePaths();
    const cacheDir = tarballCacheDirFor(machine.dataRoot);
    try {
      const result = await installFromGithubWithAutoDeps({
        source: params.source,
        registryPath: params.registryPath,
        root,
        cacheDir,
      });
      return {
        ok: true as const,
        target: { id: result.targetManifest.id, version: result.targetManifest.version },
        newEntries: result.newEntries,
        iterations: result.iterations,
        catalogPath: result.catalogPath,
        lockPath: result.lockPath,
        lockWarnings: result.lockWarnings,
        applied: result.applyResult.applied.length,
        skipped: result.applyResult.skipped.length,
        errors: result.applyResult.errors,
      };
    } catch (err) {
      if (err instanceof AutoDepsInstallError) {
        return { ok: false as const, code: err.code, message: err.message };
      }
      throw err;
    }
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

  dispatcher.register('inbox.import', async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { paths?: readonly string[] };
    if (!Array.isArray(params.paths)) {
      throw new Error('inbox.import: params.paths must be a string[]');
    }
    const root = rootPath();
    const inboxDir = join(root, 'inbox');
    mkdirSync(inboxDir, { recursive: true });

    // C2 (2026-05-21 code-review): Path-traversal + symlink-exfil-Schutz.
    // Vorher konnte ein RPC-caller `inbox.import({paths: ["~/.claude/.credentials.json"]})`
    // rufen, das file ins vault/inbox/ kopieren und via vault-sync git-push
    // exfiltrieren. Fix: lstat (kein symlink-follow) + realpath + deny-list
    // gegen sensitive Roots. Codex-Round-2: denyRoots MUSS canonicalized
    // sein damit ein symlink in `machine.dataDir` oder `home` nicht den
    // isUnder-Vergleich umgeht (canonical src vs non-canonical denyRoot).
    const machine = resolveMachinePaths();
    const h = home();
    const denyRoots: readonly string[] = canonicalizeRoots([
      machine.dataDir,
      join(h, '.claude'),
      root,
    ]);

    const stamp = new Date().toISOString().replaceAll(':', '-');
    const written: string[] = [];
    let counter = 0;
    for (const src of params.paths) {
      if (typeof src !== 'string' || src.length === 0) {
        throw new Error(`inbox.import: each path must be a non-empty string, got ${typeof src}`);
      }
      // lstat (NICHT stat) — symlink-target wird NICHT gefolgt.
      let lstatInfo: ReturnType<typeof lstatSync>;
      try {
        lstatInfo = lstatSync(src);
      } catch (err) {
        throw new Error(
          `inbox.import: cannot stat "${src}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (lstatInfo.isSymbolicLink()) {
        throw new Error(`inbox.import: refusing to copy symlink "${src}"`);
      }
      if (!lstatInfo.isFile()) {
        throw new Error(`inbox.import: not a regular file: "${src}"`);
      }
      // Canonical path zur deny-root-Pruefung. realpathSync auf einem
      // nicht-Symlink ist idempotent + macht relative paths absolut.
      let canonical: string;
      try {
        canonical = realpathSync(src);
      } catch (err) {
        throw new Error(
          `inbox.import: realpath failed for "${src}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const denyRoot of denyRoots) {
        if (isUnder(canonical, denyRoot)) {
          throw new Error(
            `inbox.import: refusing to copy from sensitive root "${canonical}" (under "${denyRoot}")`,
          );
        }
      }
      // Codex-Round-2 finding: per-file counter im Stamp verhindert dass
      // zwei Sources mit gleichem basename (z. B. `C:\a\note.md` + `C:\b\note.md`)
      // dasselbe dest produzieren — sonst ueberschreibt der zweite den
      // ersten silent.
      counter += 1;
      const dest = join(inboxDir, `${stamp}-${counter}-${basename(src)}`);
      await fspCopyFile(canonical, dest);
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
      const { drained } = chat.write(params.sessionId, params.input);
      // m7: surface backpressure-status to RPC consumers — sie koennen
      // auf "drained:false" ein Slow-Down einlegen (chunked-write).
      return { ok: true as const, drained };
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

  if (opts.mcpWatcher !== undefined) {
    const watcher = opts.mcpWatcher;
    dispatcher.register('mcp.clients.status', () => {
      const snapshot = watcher.snapshot();
      const entries = Array.from(snapshot.entries()).map(([key, status]) => ({
        key,
        entry: status.entry,
        result: status.result,
        probedAt: status.probedAt,
      }));
      return { count: entries.length, entries };
    });
    dispatcher.register('mcp.clients.reprobe', async (rawParams: unknown) => {
      const params = (rawParams ?? {}) as { serverKey?: string };
      if (typeof params.serverKey !== 'string' || params.serverKey.length === 0) {
        throw new Error('mcp.clients.reprobe: params.serverKey muss ein non-empty string sein');
      }
      const result = await watcher.reprobe(params.serverKey);
      if (result === null) {
        return { ok: false as const, code: 'unknown-server', serverKey: params.serverKey };
      }
      return {
        ok: true as const,
        key: params.serverKey,
        entry: result.entry,
        result: result.result,
        probedAt: result.probedAt,
      };
    });
  }

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

  // M13 (2026-05-21 code-review): AgentRunsRepository wird einmal pro
  // Sidecar-Lifetime instanziert, NICHT pro RPC-Call. Vorher wurde
  // `new AgentRunsRepository()` bei jedem agent.list aufgerufen — und
  // dessen loadOrRebuild walked alle JSONLs wenn der on-disk-Index
  // fehlt/korrupt. Mit Singleton bleibt der Index-State im Speicher.
  let agentRunsRepoCache: AgentRunsRepository | null = null;
  const getAgentRunsRepo = (): AgentRunsRepository => {
    if (agentRunsRepoCache !== null) return agentRunsRepoCache;
    const root = rootPath();
    const machine = resolveMachinePaths();
    agentRunsRepoCache = new AgentRunsRepository({
      agentRunsRoot: join(root, 'vault', 'agent-runs'),
      indexPath: agentRunsIndexPathFor(machine.dataDir),
      vaultRoot: join(root, 'vault'),
    });
    return agentRunsRepoCache;
  };

  dispatcher.register('agent.list', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { project?: string; limit?: number };
    const items = getAgentRunsRepo().list({
      ...(params.project === undefined ? {} : { project: params.project }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return { count: items.length, items };
  });
}
