import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkCredentialsSchema,
  hasCiEnvCredentials,
  isExpiringSoon,
  readCredentialsFile,
  resolveCredentialsPath,
} from '../../../src/domains/auth/index.js';

describe('resolveCredentialsPath', () => {
  it('uses ~/.claude/.credentials.json by default', () => {
    const path = resolveCredentialsPath({ home: '/home/me', env: {} });
    expect(path).toBe(join('/home/me', '.claude', '.credentials.json'));
  });

  it('honours $ANTHROPIC_CONFIG_DIR', () => {
    const path = resolveCredentialsPath({
      home: '/home/me',
      env: { ANTHROPIC_CONFIG_DIR: '/custom/dir' },
    });
    expect(path).toBe(join('/custom/dir', '.credentials.json'));
  });

  it('ignores whitespace-only override', () => {
    const path = resolveCredentialsPath({
      home: '/home/me',
      env: { ANTHROPIC_CONFIG_DIR: '   ' },
    });
    expect(path).toBe(join('/home/me', '.claude', '.credentials.json'));
  });
});

describe('hasCiEnvCredentials', () => {
  it('returns true when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    expect(hasCiEnvCredentials({ CLAUDE_CODE_OAUTH_TOKEN: 'token' })).toBe(true);
  });
  it('returns false when env-var is missing or empty', () => {
    expect(hasCiEnvCredentials({})).toBe(false);
    expect(hasCiEnvCredentials({ CLAUDE_CODE_OAUTH_TOKEN: '' })).toBe(false);
    expect(hasCiEnvCredentials({ CLAUDE_CODE_OAUTH_TOKEN: '   ' })).toBe(false);
  });
});

describe('readCredentialsFile + checkCredentialsSchema', () => {
  let tmpBase: string;
  let configDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'claude-os-creds-'));
    configDir = join(tmpBase, '.claude');
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeCreds(payload: unknown): void {
    writeFileSync(join(configDir, '.credentials.json'), JSON.stringify(payload));
  }

  it('returns null when file missing', () => {
    expect(readCredentialsFile({ home: tmpBase, env: {} })).toBeNull();
  });

  it('parses a well-formed envelope', () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 1_700_000_000_000,
        scopes: ['user'],
      },
    });
    const env = readCredentialsFile({ home: tmpBase, env: {} });
    expect(env).not.toBeNull();
    expect(env?.claudeAiOauth.accessToken).toBe('at');
  });

  it('rejects malformed JSON', () => {
    writeFileSync(join(configDir, '.credentials.json'), '{not json');
    expect(readCredentialsFile({ home: tmpBase, env: {} })).toBeNull();
  });

  it('rejects envelopes with wrong field types', () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 'soon',
        scopes: ['x'],
      },
    });
    expect(readCredentialsFile({ home: tmpBase, env: {} })).toBeNull();
  });

  it('schema check reports ok when file absent', () => {
    expect(checkCredentialsSchema({ home: tmpBase, env: {} }).ok).toBe(true);
  });

  it('schema check reports missing fields', () => {
    writeCreds({ claudeAiOauth: { accessToken: 'at' } });
    const result = checkCredentialsSchema({ home: tmpBase, env: {} });
    expect(result.ok).toBe(false);
    expect(result.missingFields).toContain('refreshToken');
    expect(result.missingFields).toContain('expiresAt');
    expect(result.missingFields).toContain('scopes');
  });

  it('schema check warns on missing claudeAiOauth root', () => {
    writeCreds({ otherField: 1 });
    const result = checkCredentialsSchema({ home: tmpBase, env: {} });
    expect(result.ok).toBe(false);
    expect(result.missingFields).toEqual(['claudeAiOauth']);
  });

  it('schema check warns on malformed JSON', () => {
    writeFileSync(join(configDir, '.credentials.json'), '{not json');
    const result = checkCredentialsSchema({ home: tmpBase, env: {} });
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/not valid JSON/);
  });

  it('isExpiringSoon — true when expiresAt is within the skew', () => {
    const envelope = {
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 1_700_000_030_000,
        scopes: [],
      },
    };
    const now = (): Date => new Date(1_700_000_000_000);
    expect(isExpiringSoon(envelope, 60_000, now)).toBe(true);
  });

  it('isExpiringSoon — false when expiresAt is comfortably ahead', () => {
    const envelope = {
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 1_700_000_500_000,
        scopes: [],
      },
    };
    const now = (): Date => new Date(1_700_000_000_000);
    expect(isExpiringSoon(envelope, 60_000, now)).toBe(false);
  });
});
