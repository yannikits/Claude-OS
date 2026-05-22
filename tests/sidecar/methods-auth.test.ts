import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MethodsContext } from '../../src/sidecar/methods/_shared.js';
import { registerAuthMethods } from '../../src/sidecar/methods/auth.js';
import type { PtyChatSessions } from '../../src/sidecar/pty-chat-sessions.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

/**
 * Diese Suite testet die `auth.*` RPC-Methoden direkt (registerAuthMethods)
 * statt ueber den methods.ts orchestrator. Das umgeht den compulsory
 * resolveRoot()-Bootstrap in `rootPath()` und macht den Test
 * self-contained. Der CLI-pfad von checkAuthState wird durch die Tatsache
 * abgedeckt dass `binaryPath` undefined ist wenn `resolveClaudeBinary`
 * throws — wir gehen dann auf die file/no-creds-Pfade.
 */

interface FakePtySession {
  sessionId: string;
}

function makeFakePty(): PtyChatSessions & {
  spawnCalls: Array<{ args: readonly string[]; opts: Record<string, unknown> }>;
} {
  const calls: Array<{ args: readonly string[]; opts: Record<string, unknown> }> = [];
  const fake = {
    spawnCalls: calls,
    spawn(args: readonly string[], opts: Record<string, unknown>): FakePtySession {
      calls.push({ args, opts });
      return { sessionId: `fake-session-${calls.length}` };
    },
    // unused methods — satisfy the type
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    activeCount: () => calls.length,
    shutdownAll: async () => {},
  };
  return fake as unknown as PtyChatSessions & {
    spawnCalls: Array<{ args: readonly string[]; opts: Record<string, unknown> }>;
  };
}

describe('auth.* RPCs', () => {
  let tmpRoot: string;
  let tmpData: string;
  let tmpHome: string;
  let machineDataDir: string;

  function makeCtx(env: NodeJS.ProcessEnv = {}): MethodsContext {
    return {
      env: () => env,
      home: () => tmpHome,
      rootPath: () => tmpRoot,
      machinePaths: () => ({
        dataDir: machineDataDir,
        logsDir: join(machineDataDir, 'logs'),
        gitMetadataDir: join(machineDataDir, 'git-metadata'),
        externalGitDirFor: (name: string) => join(machineDataDir, 'git-metadata', `${name}.git`),
      }),
      // Unused for auth — minimal stubs
      catalogCache: { get: () => null, set: () => {} } as never,
      catalogLockCache: { get: () => null, set: () => {} } as never,
      vaultConfigCache: { get: () => null, set: () => {} } as never,
      schedulesCache: { get: () => null, set: () => {} } as never,
      getAgentRunsRepo: () => {
        throw new Error('not needed in auth tests');
      },
    };
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-auth-root-'));
    tmpData = mkdtempSync(join(tmpdir(), 'claude-os-auth-data-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'claude-os-auth-home-'));
    machineDataDir = join(tmpData, 'data');
    mkdirSync(machineDataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('auth.status', () => {
    it('returns no-creds when nothing is configured', async () => {
      const d = new RpcDispatcher();
      const ctx = makeCtx();
      registerAuthMethods(d, ctx, {
        ptyChatSessions: makeFakePty(),
        binaryResolver: () => null,
      });

      const raw = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.status' }));
      const response = raw as { result: { loggedIn: boolean; source: string } };
      expect(response.result.loggedIn).toBe(false);
      expect(response.result.source).toBe('no-creds');
    });

    it('detects loggedIn=true via .credentials.json file-fallback', async () => {
      // create a credentials file in tmpHome/.claude (default location)
      const claudeDir = join(tmpHome, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      const future = Date.now() + 24 * 60 * 60 * 1000; // 24h from now
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-test-access',
            refreshToken: 'sk-test-refresh',
            expiresAt: future,
            scopes: ['user:*'],
          },
        }),
      );

      const d = new RpcDispatcher();
      const ctx = makeCtx();
      registerAuthMethods(d, ctx, {
        ptyChatSessions: makeFakePty(),
        binaryResolver: () => null,
      });

      const raw = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.status' }));
      const response = raw as {
        result: { loggedIn: boolean; source: string; scopes?: string[] };
      };
      expect(response.result.loggedIn).toBe(true);
      expect(response.result.source).toBe('file');
      expect(response.result.scopes).toEqual(['user:*']);
    });

    it('surfaces active profile name when one is set', async () => {
      // create profile + active-marker
      const profilesDir = join(machineDataDir, 'auth-profiles');
      mkdirSync(join(profilesDir, 'work'), { recursive: true });
      writeFileSync(
        join(machineDataDir, 'auth-active-profile.json'),
        JSON.stringify({ active: 'work' }),
      );

      const d = new RpcDispatcher();
      const ctx = makeCtx();
      registerAuthMethods(d, ctx, {
        ptyChatSessions: makeFakePty(),
        binaryResolver: () => null,
      });

      const raw = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.status' }));
      const response = raw as { result: { profile?: string } };
      expect(response.result.profile).toBe('work');
    });
  });

  describe('auth.login', () => {
    it('spawns claude with auth login args and default 80x24 size', async () => {
      const d = new RpcDispatcher();
      const ctx = makeCtx();
      const fakePty = makeFakePty();
      registerAuthMethods(d, ctx, { ptyChatSessions: fakePty, binaryResolver: () => null });

      const raw = await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.login' }));
      const response = raw as { result: { sessionId: string } };
      expect(response.result.sessionId).toMatch(/^fake-session-/);
      expect(fakePty.spawnCalls).toHaveLength(1);
      const call = fakePty.spawnCalls[0];
      expect(call?.args).toEqual(['auth', 'login']);
      expect(call?.opts.cols).toBe(80);
      expect(call?.opts.rows).toBe(24);
    });

    it('passes through custom cols/rows from params', async () => {
      const d = new RpcDispatcher();
      const ctx = makeCtx();
      const fakePty = makeFakePty();
      registerAuthMethods(d, ctx, { ptyChatSessions: fakePty, binaryResolver: () => null });

      await d.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'auth.login',
          params: { cols: 120, rows: 40 },
        }),
      );
      const call = fakePty.spawnCalls[0];
      expect(call?.opts.cols).toBe(120);
      expect(call?.opts.rows).toBe(40);
    });

    it('injects ANTHROPIC_CONFIG_DIR when a profile is active', async () => {
      const profilesDir = join(machineDataDir, 'auth-profiles');
      const workDir = join(profilesDir, 'work');
      mkdirSync(workDir, { recursive: true });
      writeFileSync(
        join(machineDataDir, 'auth-active-profile.json'),
        JSON.stringify({ active: 'work' }),
      );

      const d = new RpcDispatcher();
      const ctx = makeCtx();
      const fakePty = makeFakePty();
      registerAuthMethods(d, ctx, { ptyChatSessions: fakePty, binaryResolver: () => null });

      await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.login' }));
      const call = fakePty.spawnCalls[0];
      const envOverrides = call?.opts.envOverrides as Record<string, string>;
      expect(envOverrides.ANTHROPIC_CONFIG_DIR).toBe(workDir);
    });

    it('omits ANTHROPIC_CONFIG_DIR when no profile is active', async () => {
      const d = new RpcDispatcher();
      const ctx = makeCtx();
      const fakePty = makeFakePty();
      registerAuthMethods(d, ctx, { ptyChatSessions: fakePty, binaryResolver: () => null });

      await d.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.login' }));
      const call = fakePty.spawnCalls[0];
      const envOverrides = call?.opts.envOverrides as Record<string, string>;
      expect(envOverrides).toEqual({});
    });

    it('rejects non-positive cols/rows by falling back to defaults', async () => {
      const d = new RpcDispatcher();
      const ctx = makeCtx();
      const fakePty = makeFakePty();
      registerAuthMethods(d, ctx, { ptyChatSessions: fakePty, binaryResolver: () => null });

      await d.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'auth.login',
          params: { cols: -5, rows: 0 },
        }),
      );
      const call = fakePty.spawnCalls[0];
      expect(call?.opts.cols).toBe(80);
      expect(call?.opts.rows).toBe(24);
    });
  });
});
