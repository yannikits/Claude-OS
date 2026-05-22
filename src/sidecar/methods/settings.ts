/**
 * Settings-Namespace RPCs: read + activateProfile (v1.x.+1).
 * Split aus `sidecar/methods.ts` (M21).
 *
 * @module @sidecar/methods/settings
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileManager } from '../../domains/auth/index.js';
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
}
