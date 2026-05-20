import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSchedules } from '../../src/domains/scheduler/index.js';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

describe('schedule.list RPC', () => {
  let tmpRoot: string;
  let tmpData: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-sched-rpc-root-'));
    tmpData = mkdtempSync(join(tmpdir(), 'claude-os-sched-rpc-data-'));
    mkdirSync(join(tmpData, 'data'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    envBackup = { ...process.env };
    process.env.CLAUDE_OS_ROOT = tmpRoot;
    process.env.CLAUDE_OS_DATA_DIR = tmpData;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
    process.env = envBackup;
  });

  it('liefert empty count wenn schedules.json fehlt', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('schedule.list', {})) as {
      count: number;
      entries: unknown[];
    };
    expect(result.count).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('liefert Entries + computed next-Field', async () => {
    const machineDataDir = join(tmpData, 'data');
    writeSchedules(machineDataDir, {
      version: 1,
      entries: [
        {
          id: 'morning-sync',
          cron: '0 8 * * *',
          command: 'echo morning',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('schedule.list', {})) as {
      count: number;
      entries: { id: string; next: string | null }[];
    };
    expect(result.count).toBe(1);
    expect(result.entries[0]?.id).toBe('morning-sync');
    // next sollte ein valider ISO-String sein (oder null)
    expect(result.entries[0]?.next).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('toleriert ungueltige cron-Expressions (next: null statt throw)', async () => {
    const machineDataDir = join(tmpData, 'data');
    writeSchedules(machineDataDir, {
      version: 1,
      entries: [
        {
          id: 'broken',
          cron: 'not a cron',
          command: 'echo x',
          createdAt: '2026-05-20T00:00:00.000Z',
          enabled: true,
        },
      ],
    });
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('schedule.list', {})) as {
      entries: { id: string; next: string | null }[];
    };
    expect(result.entries[0]?.id).toBe('broken');
    expect(result.entries[0]?.next).toBeNull();
  });
});

describe('schedule.add / remove / setEnabled RPCs', () => {
  let tmpRoot: string;
  let tmpData: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-sched-mut-root-'));
    tmpData = mkdtempSync(join(tmpdir(), 'claude-os-sched-mut-data-'));
    mkdirSync(join(tmpData, 'data'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude-os-root'), '');
    envBackup = { ...process.env };
    process.env.CLAUDE_OS_ROOT = tmpRoot;
    process.env.CLAUDE_OS_DATA_DIR = tmpData;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
    process.env = envBackup;
  });

  it('schedule.add legt einen Entry an', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    const result = (await d.invoke('schedule.add', {
      id: 'morning',
      cron: '0 8 * * *',
      command: 'echo hi',
    })) as { entry: { id: string; cron: string; enabled: boolean } };
    expect(result.entry.id).toBe('morning');
    expect(result.entry.cron).toBe('0 8 * * *');
    expect(result.entry.enabled).toBe(true);
  });

  it('schedule.add wirft bei ungueltigem cron', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    await expect(
      d.invoke('schedule.add', { id: 'x', cron: 'nope', command: 'echo' }),
    ).rejects.toThrow(/cron invalid/);
  });

  it('schedule.add wirft bei dupliziertem id', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    await d.invoke('schedule.add', { id: 'dup', cron: '* * * * *', command: 'echo' });
    await expect(
      d.invoke('schedule.add', { id: 'dup', cron: '* * * * *', command: 'echo' }),
    ).rejects.toThrow(/existiert bereits/);
  });

  it('schedule.remove entfernt einen Entry', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    await d.invoke('schedule.add', { id: 'r', cron: '* * * * *', command: 'echo' });
    const result = (await d.invoke('schedule.remove', { id: 'r' })) as {
      id: string;
      removed: boolean;
    };
    expect(result.removed).toBe(true);
    const list = (await d.invoke('schedule.list', {})) as { count: number };
    expect(list.count).toBe(0);
  });

  it('schedule.setEnabled togglet enabled-state', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    await d.invoke('schedule.add', { id: 't', cron: '* * * * *', command: 'echo' });
    await d.invoke('schedule.setEnabled', { id: 't', enabled: false });
    const list = (await d.invoke('schedule.list', {})) as {
      entries: { id: string; enabled: boolean }[];
    };
    expect(list.entries[0]?.enabled).toBe(false);
  });

  it('schedule.setEnabled wirft bei unbekanntem id', async () => {
    const d = new RpcDispatcher();
    registerMethods(d);
    await expect(d.invoke('schedule.setEnabled', { id: 'nope', enabled: true })).rejects.toThrow(
      /existiert nicht/,
    );
  });
});
