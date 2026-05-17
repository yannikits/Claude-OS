import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  AuthProfileExistsError,
  AuthProfileMissingError,
  ProfileManager,
} from '../../../src/domains/auth/index.js';

describe('ProfileManager', () => {
  let dataRoot: string;
  let mgr: ProfileManager;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'claude-os-prof-'));
    mgr = new ProfileManager({ dataRoot });
  });

  afterEach(() => {
    if (existsSync(dataRoot)) rmSync(dataRoot, { recursive: true, force: true });
  });

  it('starts with empty list and no active profile', () => {
    expect(mgr.list()).toEqual([]);
    expect(mgr.active()).toBeNull();
    expect(mgr.resolveEnvOverride()).toBeNull();
  });

  it('create makes a new dir and returns the profile', () => {
    const profile = mgr.create('work');
    expect(profile.name).toBe('work');
    expect(existsSync(profile.configDir)).toBe(true);
    expect(profile.active).toBe(false);
  });

  it('create twice throws AuthProfileExistsError', () => {
    mgr.create('work');
    expect(() => mgr.create('work')).toThrow(AuthProfileExistsError);
  });

  it('rejects invalid profile names', () => {
    expect(() => mgr.create('with space')).toThrow(AuthError);
    expect(() => mgr.create('weird/path')).toThrow(AuthError);
    expect(() => mgr.create('')).toThrow(AuthError);
  });

  it('use marks a profile active and resolveEnvOverride returns its dir', () => {
    const p = mgr.create('work');
    mgr.use('work');
    expect(mgr.active()).toBe('work');
    expect(mgr.resolveEnvOverride()).toBe(p.configDir);
  });

  it('use throws when profile does not exist', () => {
    expect(() => mgr.use('ghost')).toThrow(AuthProfileMissingError);
  });

  it('list reflects active status', () => {
    mgr.create('A');
    mgr.create('B');
    mgr.use('B');
    const list = mgr.list();
    expect(list.map((p) => p.name)).toEqual(['A', 'B']);
    expect(list.find((p) => p.name === 'A')?.active).toBe(false);
    expect(list.find((p) => p.name === 'B')?.active).toBe(true);
  });

  it('delete removes profile dir and clears active marker if it was active', () => {
    mgr.create('A');
    mgr.use('A');
    mgr.delete('A');
    expect(mgr.list()).toEqual([]);
    expect(mgr.active()).toBeNull();
  });

  it('delete throws when profile does not exist', () => {
    expect(() => mgr.delete('ghost')).toThrow(AuthProfileMissingError);
  });

  it('survives malformed active-marker JSON gracefully', () => {
    mgr.create('A');
    writeFileSync(mgr.activeMarkerPath(), '{not json');
    expect(mgr.active()).toBeNull();
  });

  it('survives active-marker with invalid name', () => {
    writeFileSync(mgr.activeMarkerPath(), JSON.stringify({ active: 'weird/path' }));
    expect(mgr.active()).toBeNull();
  });

  it('resolveEnvOverride returns null when the active profile dir is gone', () => {
    mgr.create('A');
    mgr.use('A');
    rmSync(join(mgr.profilesDir(), 'A'), { recursive: true, force: true });
    expect(mgr.resolveEnvOverride()).toBeNull();
  });
});
