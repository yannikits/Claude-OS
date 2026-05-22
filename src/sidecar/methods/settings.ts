/**
 * Settings-Namespace RPCs: read + activateProfile (v1.x.+1) +
 * createProfile + deleteProfile (v1.x.+2).
 * Split aus `sidecar/methods.ts` (M21).
 *
 * @module @sidecar/methods/settings
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AuthProfileExistsError,
  AuthProfileMissingError,
  ProfileManager,
} from '../../domains/auth/index.js';
import { createSecretStore } from '../../domains/secrets/index.js';
import type { RpcDispatcher } from '../rpc.js';
import { type MethodsContext, requireString } from './_shared.js';

export function registerSettingsMethods(dispatcher: RpcDispatcher, ctx: MethodsContext): void {
  dispatcher.register('settings.read', () => {
    const machine = ctx.machinePaths();
    const profileMgr = new ProfileManager({ dataRoot: machine.dataDir });
    const activeProfile = profileMgr.active();
    const profiles = profileMgr.list();
    const e = ctx.env();
    const h = ctx.home();
    const envOverride = e.ANTHROPIC_CONFIG_DIR ?? null;
    const resolvedAnthropicConfigDir =
      envOverride ?? profileMgr.resolveEnvOverride() ?? join(h, '.claude');
    const credentialsFile = join(resolvedAnthropicConfigDir, '.credentials.json');
    const credentialsFileExists = existsSync(credentialsFile);
    const secretsBackend = createSecretStore({ env: e }).backend;
    const secretsBackendOverride = e.CLAUDE_OS_SECRETS_BACKEND ?? null;

    const claudeCodeRoots = [
      { label: 'global', path: join(h, '.claude') },
      { label: 'project', path: join(ctx.rootPath(), '.claude') },
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
        availableProfiles: profiles.map((p) => ({
          name: p.name,
          active: p.active,
          configDir: p.configDir,
        })),
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

  /**
   * Schaltet das aktive Anthropic-Profil um. Wirft wenn der Name kein
   * bekanntes Profil ist (statt ein neues zu erzeugen — das bleibt
   * CLI-only via `claude-os auth profile create`). Reuse: ProfileManager.
   */
  dispatcher.register('settings.activateProfile', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { name?: string };
    const name = requireString(params.name, 'name', 'settings.activateProfile');
    const machine = ctx.machinePaths();
    const profileMgr = new ProfileManager({ dataRoot: machine.dataDir });
    const known = profileMgr.list().some((p) => p.name === name);
    if (!known) {
      throw new Error(
        `settings.activateProfile: unknown profile "${name}". Use \`claude-os auth profile create <name>\` first.`,
      );
    }
    const profile = profileMgr.use(name);
    return { activeProfile: profile.name };
  });

  /**
   * Legt ein neues Anthropic-Profil an (entspricht
   * `claude-os auth profile create <name>`). Wirft `profile-exists`
   * wenn der Name schon vergeben ist; wirft auf invalid-name-pattern
   * (ProfileManager.create validiert via NAME_PATTERN intern).
   */
  dispatcher.register('settings.createProfile', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { name?: string };
    const name = requireString(params.name, 'name', 'settings.createProfile');
    const machine = ctx.machinePaths();
    const profileMgr = new ProfileManager({ dataRoot: machine.dataDir });
    try {
      const profile = profileMgr.create(name);
      return { name: profile.name, configDir: profile.configDir, active: profile.active };
    } catch (err) {
      if (err instanceof AuthProfileExistsError) {
        throw new Error(`profile-exists: ${err.message}`);
      }
      throw err;
    }
  });

  /**
   * Loescht ein Anthropic-Profil inkl. `.credentials.json` darin.
   * Refused wenn `name === active()` — User muss zuerst wechseln. Das
   * verhindert ein silent-orphaning des active-Markers.
   *
   * Returnt `{name, deleted: true, configDir}` damit die GUI den
   * gerade-geloeschten Pfad explizit im Success-Banner zeigen kann.
   */
  dispatcher.register('settings.deleteProfile', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { name?: string };
    const name = requireString(params.name, 'name', 'settings.deleteProfile');
    const machine = ctx.machinePaths();
    const profileMgr = new ProfileManager({ dataRoot: machine.dataDir });
    if (profileMgr.active() === name) {
      throw new Error(
        `settings.deleteProfile: cannot delete active profile "${name}"; switch to another profile first.`,
      );
    }
    const configDir = profileMgr.configDirFor(name);
    try {
      profileMgr.delete(name);
      return { name, deleted: true as const, configDir };
    } catch (err) {
      if (err instanceof AuthProfileMissingError) {
        throw new Error(`unknown-profile: ${err.message}`);
      }
      throw err;
    }
  });
}
