import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexDir, resolveIndexDbPath } from '../../../src/domains/memory-index/index.js';

describe('resolveIndexDbPath', () => {
  it('produces <vault>/.claude-os/index.db', () => {
    const p = resolveIndexDbPath('/tmp/v').replace(/\\/g, '/');
    expect(p).toBe('/tmp/v/.claude-os/index.db');
  });
});

describe('ensureIndexDir', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'mi-paths-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('creates <vault>/.claude-os/ if missing', () => {
    const dir = ensureIndexDir(vault);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent', () => {
    const a = ensureIndexDir(vault);
    const b = ensureIndexDir(vault);
    expect(a).toBe(b);
    expect(statSync(a).isDirectory()).toBe(true);
  });
});
