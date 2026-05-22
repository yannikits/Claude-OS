import {
  existsSync as existsSyncTest,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

describe('settings.read RPC', () => {
  let tmpRoot: string;
  let tmpData: string;
  let tmpHome: string;
  let machineDataDir: string;
  let testEnv: NodeJS.ProcessEnv;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-settings-root-'));
    tmpData = mkdtempSync(join(tmpdir(), 'claude-os-settings-data-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'claude-os-settings-home-'));
    machineDataDir = join(tmpData, 'data');
    mkdirSync(machineDataDir, { recursive: true });
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    envBackup = { ...process.env };
    // resolveRoot() reads process.env directly — must set on the real env.
    process.env.CLAUDE_OS_ROOT = tmpRoot;
    process.env.CLAUDE_OS_DATA_DIR = tmpData;
    // testEnv is the opts.env passed to registerMethods — controls method behaviour.
    testEnv = {
      CLAUDE_OS_SECRETS_BACKEND: 'encrypted-file',
      CLAUDE_OS_DATA_DIR: tmpData,
    };
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
    process.env = envBackup;
  });

  async function callSettings() {
    const d = new RpcDispatcher();
    registerMethods(d, { env: testEnv, home: tmpHome });
    const result = await d.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'settings.read' }),
    );
    return (result as { result: Record<string, unknown> }).result;
  }

  it('returns defaults when nothing is configured', async () => {
    const result = (await callSettings()) as {
      anthropic: {
        envOverride: string | null;
        activeProfile: string | null;
        availableProfiles: unknown[];
        credentialsFileExists: boolean;
      };
      secrets: { backend: string; envOverride: string | null };
      claudeCodeSettings: { exists: boolean }[];
    };
    expect(result.anthropic.envOverride).toBeNull();
    expect(result.anthropic.activeProfile).toBeNull();
    expect(result.anthropic.availableProfiles).toEqual([]);
    expect(result.anthropic.credentialsFileExists).toBe(false);
    expect(result.secrets.backend).toBe('encrypted-file');
    expect(result.secrets.envOverride).toBe('encrypted-file');
    expect(result.claudeCodeSettings).toHaveLength(4);
    for (const f of result.claudeCodeSettings) expect(f.exists).toBe(false);
  });

  it('surfaces ANTHROPIC_CONFIG_DIR override and detects credentials.json', async () => {
    const configDir = join(tmpHome, 'custom-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.credentials.json'), '{}');
    testEnv.ANTHROPIC_CONFIG_DIR = configDir;

    const result = (await callSettings()) as {
      anthropic: { envOverride: string; resolvedConfigDir: string; credentialsFileExists: boolean };
    };
    expect(result.anthropic.envOverride).toBe(configDir);
    expect(result.anthropic.resolvedConfigDir).toBe(configDir);
    expect(result.anthropic.credentialsFileExists).toBe(true);
  });

  it('lists profiles created by ProfileManager and flags the active one', async () => {
    const profilesDir = join(machineDataDir, 'auth-profiles');
    mkdirSync(join(profilesDir, 'work'), { recursive: true });
    mkdirSync(join(profilesDir, 'personal'), { recursive: true });
    writeFileSync(
      join(machineDataDir, 'auth-active-profile.json'),
      JSON.stringify({ active: 'work' }),
    );

    const result = (await callSettings()) as {
      anthropic: {
        activeProfile: string | null;
        availableProfiles: { name: string; active: boolean }[];
      };
    };
    expect(result.anthropic.activeProfile).toBe('work');
    expect(result.anthropic.availableProfiles).toEqual([
      { name: 'personal', active: false, configDir: join(profilesDir, 'personal') },
      { name: 'work', active: true, configDir: join(profilesDir, 'work') },
    ]);
  });

  describe('settings.activateProfile', () => {
    async function callActivate(name: string) {
      const d = new RpcDispatcher();
      registerMethods(d, { env: testEnv, home: tmpHome });
      const result = await d.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'settings.activateProfile',
          params: { name },
        }),
      );
      return result;
    }

    it('switches active profile when name is known', async () => {
      const profilesDir = join(machineDataDir, 'auth-profiles');
      mkdirSync(join(profilesDir, 'work'), { recursive: true });
      mkdirSync(join(profilesDir, 'personal'), { recursive: true });
      writeFileSync(
        join(machineDataDir, 'auth-active-profile.json'),
        JSON.stringify({ active: 'work' }),
      );

      const raw = (await callActivate('personal')) as { result: { activeProfile: string } };
      expect(raw.result.activeProfile).toBe('personal');

      // verify the marker was actually rewritten on disk
      const settingsAfter = await (async () => {
        const d = new RpcDispatcher();
        registerMethods(d, { env: testEnv, home: tmpHome });
        const r = await d.handle(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'settings.read' }),
        );
        return (r as { result: { anthropic: { activeProfile: string | null } } }).result;
      })();
      expect(settingsAfter.anthropic.activeProfile).toBe('personal');
    });

    it('rejects unknown profile with a helpful error message', async () => {
      const profilesDir = join(machineDataDir, 'auth-profiles');
      mkdirSync(join(profilesDir, 'work'), { recursive: true });

      const raw = (await callActivate('nonexistent')) as {
        error: { code: number; message: string };
      };
      expect(raw.error).toBeDefined();
      expect(raw.error.message).toMatch(/unknown profile/);
      expect(raw.error.message).toMatch(/claude-os auth profile create/);
    });

    it('rejects empty name', async () => {
      const raw = (await callActivate('')) as { error: { message: string } };
      expect(raw.error).toBeDefined();
      expect(raw.error.message).toMatch(/non-empty string/);
    });
  });

  describe('settings.createProfile (v1.x.+2)', () => {
    async function callCreate(name: string) {
      const d = new RpcDispatcher();
      registerMethods(d, { env: testEnv, home: tmpHome });
      return (await d.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'settings.createProfile',
          params: { name },
        }),
      )) as {
        result?: { name: string; configDir: string; active: boolean };
        error?: { message: string };
      };
    }

    it('creates a new profile and surfaces its configDir', async () => {
      const raw = await callCreate('work');
      expect(raw.result?.name).toBe('work');
      expect(raw.result?.configDir).toBe(join(machineDataDir, 'auth-profiles', 'work'));
      expect(raw.result?.active).toBe(false);
      // verify on disk
      expect(existsSyncTest(join(machineDataDir, 'auth-profiles', 'work'))).toBe(true);
    });

    it('rejects duplicate-name with profile-exists', async () => {
      mkdirSync(join(machineDataDir, 'auth-profiles', 'existing'), { recursive: true });
      const raw = await callCreate('existing');
      expect(raw.error?.message).toMatch(/profile-exists/);
    });

    it('rejects invalid-name-pattern (e.g. slashes, spaces)', async () => {
      const r1 = await callCreate('has space');
      expect(r1.error?.message).toMatch(/Invalid profile name|profile-exists/i);
      const r2 = await callCreate('has/slash');
      expect(r2.error?.message).toMatch(/Invalid profile name/i);
    });

    it('rejects empty name', async () => {
      const raw = await callCreate('');
      expect(raw.error?.message).toMatch(/non-empty string/);
    });
  });

  describe('settings.deleteProfile (v1.x.+2)', () => {
    async function callDelete(name: string) {
      const d = new RpcDispatcher();
      registerMethods(d, { env: testEnv, home: tmpHome });
      return (await d.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'settings.deleteProfile',
          params: { name },
        }),
      )) as {
        result?: { name: string; deleted: boolean; configDir: string };
        error?: { message: string };
      };
    }

    it('deletes a non-active profile and surfaces configDir', async () => {
      const profilesDir = join(machineDataDir, 'auth-profiles');
      mkdirSync(join(profilesDir, 'doomed'), { recursive: true });
      writeFileSync(join(profilesDir, 'doomed', '.credentials.json'), '{}');

      const raw = await callDelete('doomed');
      expect(raw.result?.deleted).toBe(true);
      expect(raw.result?.configDir).toBe(join(profilesDir, 'doomed'));
      expect(existsSyncTest(join(profilesDir, 'doomed'))).toBe(false);
    });

    it('refuses to delete the active profile with helpful error', async () => {
      const profilesDir = join(machineDataDir, 'auth-profiles');
      mkdirSync(join(profilesDir, 'work'), { recursive: true });
      writeFileSync(
        join(machineDataDir, 'auth-active-profile.json'),
        JSON.stringify({ active: 'work' }),
      );
      const raw = await callDelete('work');
      expect(raw.error?.message).toMatch(/cannot delete active profile/);
      expect(raw.error?.message).toMatch(/switch to another/);
      // verify profile still there
      expect(existsSyncTest(join(profilesDir, 'work'))).toBe(true);
    });

    it('rejects unknown-profile with unknown-profile error', async () => {
      const raw = await callDelete('never-existed');
      expect(raw.error?.message).toMatch(/unknown-profile/);
    });
  });

  it('reports existence + size + mtime for ~/.claude/settings.local.json when present', async () => {
    const claudeDir = join(tmpHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), '{"x":1}');

    const result = (await callSettings()) as {
      claudeCodeSettings: {
        scope: string;
        name: string;
        exists: boolean;
        size: number | null;
        mtime: string | null;
      }[];
    };
    const hit = result.claudeCodeSettings.find(
      (f) => f.scope === 'global' && f.name === 'settings.local.json',
    );
    expect(hit?.exists).toBe(true);
    expect(hit?.size).toBeGreaterThan(0);
    expect(typeof hit?.mtime).toBe('string');
  });
});
