import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAuthState } from '../../../src/domains/auth/index.js';

describe('checkAuthState', () => {
  let tmpBase: string;
  let configDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-state-'));
    configDir = join(tmpBase, '.claude');
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeCreds(payload: unknown): void {
    writeFileSync(join(configDir, '.credentials.json'), JSON.stringify(payload));
  }

  it('returns env source when CLAUDE_CODE_OAUTH_TOKEN is set', async () => {
    const state = await checkAuthState({
      home: tmpBase,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'present' },
    });
    expect(state.source).toBe('env');
    expect(state.loggedIn).toBe(true);
    expect(state.warning).toMatch(/CI/);
  });

  it('returns cli source when the executor returns valid JSON', async () => {
    const state = await checkAuthState({
      home: tmpBase,
      env: {},
      binaryPath: '/x/claude',
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth', apiProvider: 'anthropic' }),
          stderr: '',
        }),
    });
    expect(state.source).toBe('cli');
    expect(state.loggedIn).toBe(true);
  });

  it('falls back to file when CLI executor returns non-zero exit', async () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user'],
      },
    });
    const state = await checkAuthState({
      home: tmpBase,
      env: {},
      binaryPath: '/x/claude',
      exec: () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'err' }),
    });
    expect(state.source).toBe('file');
    expect(state.loggedIn).toBe(true);
  });

  it('falls back to file when CLI executor throws', async () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user'],
      },
    });
    const state = await checkAuthState({
      home: tmpBase,
      env: {},
      binaryPath: '/x/claude',
      exec: () => Promise.reject(new Error('ENOENT')),
    });
    expect(state.source).toBe('file');
    expect(state.loggedIn).toBe(true);
  });

  it('file source flags expired tokens as not-loggedIn', async () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() - 10_000,
        scopes: [],
      },
    });
    const state = await checkAuthState({ home: tmpBase, env: {} });
    expect(state.source).toBe('file');
    expect(state.loggedIn).toBe(false);
  });

  it('file source warns when tokens expire within the configured skew', async () => {
    const expiresAtMs = Date.parse('2026-05-17T09:00:00.000Z');
    writeCreds({
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: expiresAtMs,
        scopes: [],
      },
    });
    const state = await checkAuthState({
      home: tmpBase,
      env: {},
      now: () => new Date('2026-05-17T08:30:00.000Z'),
      expiresSoonMs: 60 * 60 * 1000,
    });
    expect(state.loggedIn).toBe(true);
    expect(state.warning).toMatch(/token expires at/);
  });

  it('returns no-creds when nothing is found', async () => {
    const state = await checkAuthState({ home: tmpBase, env: {} });
    expect(state.source).toBe('no-creds');
    expect(state.loggedIn).toBe(false);
  });

  it('surfaces the active profile name', async () => {
    const state = await checkAuthState({
      home: tmpBase,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' },
      profile: 'work',
    });
    expect(state.profile).toBe('work');
  });
});
