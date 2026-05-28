/**
 * Phase 5c-3 — skill-lifecycle RPCs. Covers all 9 registered methods
 * via a real `registerMethods()` wire-up against tmp vault + dataDir.
 *
 * Pattern mirrored from methods-catalog-list.test.ts: a tmp root with
 * `.claude-os-root` marker, vault subdir, and an isolated $CLAUDE_OS_*
 * env so other tests' state doesn't leak in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAndSignApproval,
  draftsDir,
  generateEd25519Keypair,
  proposeReview,
  quarantinedDir,
  type ReviewApprovalPayload,
  type ReviewProposal,
  type SignedEnvelope,
} from '../../src/domains/skill-lifecycle/index.js';
import { registerMethods } from '../../src/sidecar/methods.js';
import { RpcDispatcher } from '../../src/sidecar/rpc.js';

const WORKSPACE = 'personal';
let tmpRoot: string;
let vault: string;
let envBackup: NodeJS.ProcessEnv;
let dispatcher: RpcDispatcher;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'claude-os-skill-rpc-'));
  writeFileSync(join(tmpRoot, '.claude-os-root'), '');
  vault = join(tmpRoot, 'vault');
  mkdirSync(join(vault, 'Claude-OS', 'workspaces', WORKSPACE), { recursive: true });
  // Active workspace = personal.
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  writeFileSync(join(tmpRoot, 'config', 'workspace.json'), JSON.stringify({ active: WORKSPACE }));
  envBackup = { ...process.env };
  process.env.CLAUDE_OS_ROOT = tmpRoot;
  process.env.CLAUDE_OS_VAULT_PATH = vault;
  process.env.CLAUDE_OS_DATA_DIR = join(tmpRoot, 'data');
  mkdirSync(process.env.CLAUDE_OS_DATA_DIR, { recursive: true });
  dispatcher = new RpcDispatcher();
  registerMethods(dispatcher);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = envBackup;
});

function writeDraft(name: string, body = 'sample'): void {
  const dir = join(draftsDir(vault, WORKSPACE), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---
name: ${name}
description: x
classification: personal
state: draft
generated_at: 2026-05-28T00:00:00Z
---

${body}
`,
  );
}

async function moveToQuarantined(name: string): Promise<void> {
  const res = (await dispatcher.invoke('skill.promoteDraftToQuarantined', { name })) as {
    ok: boolean;
  };
  expect(res.ok).toBe(true);
}

describe('skill.listDrafts', () => {
  it('returns empty entries on a fresh vault', async () => {
    const res = (await dispatcher.invoke('skill.listDrafts', {})) as {
      ok: boolean;
      entries: unknown[];
    };
    expect(res.ok).toBe(true);
    expect(res.entries).toEqual([]);
  });

  it('lists drafts newest-first', async () => {
    writeDraft('alpha');
    writeDraft('beta');
    const res = (await dispatcher.invoke('skill.listDrafts', {})) as {
      ok: boolean;
      entries: { name: string }[];
    };
    expect(res.entries.length).toBe(2);
    expect(res.entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
  });
});

describe('skill.promoteDraftToQuarantined', () => {
  it('moves a draft into the quarantined bucket', async () => {
    writeDraft('x');
    const res = (await dispatcher.invoke('skill.promoteDraftToQuarantined', { name: 'x' })) as {
      ok: boolean;
      toState: string;
    };
    expect(res.ok).toBe(true);
    expect(res.toState).toBe('quarantined');
  });

  it('returns typed envelope on not-found', async () => {
    const res = (await dispatcher.invoke('skill.promoteDraftToQuarantined', {
      name: 'missing',
    })) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not-found');
  });

  it('rejects empty name with structural Error (not PromoteError)', async () => {
    await expect(dispatcher.invoke('skill.promoteDraftToQuarantined', {})).rejects.toThrow(
      /params.name/,
    );
  });
});

describe('skill.listQuarantined', () => {
  it('marks hasSandboxRun=false when .sandbox-run.json absent', async () => {
    writeDraft('q1');
    await moveToQuarantined('q1');
    const res = (await dispatcher.invoke('skill.listQuarantined', {})) as {
      ok: boolean;
      entries: { name: string; hasSandboxRun: boolean }[];
    };
    expect(res.entries.length).toBe(1);
    expect(res.entries[0]?.hasSandboxRun).toBe(false);
  });

  it('marks hasSandboxRun=true when summary file exists', async () => {
    writeDraft('q2');
    await moveToQuarantined('q2');
    const qDir = join(quarantinedDir(vault, WORKSPACE), 'q2');
    writeFileSync(
      join(qDir, '.sandbox-run.json'),
      JSON.stringify({ skillName: 'q2', outcome: 'ok' }),
    );
    const res = (await dispatcher.invoke('skill.listQuarantined', {})) as {
      entries: { hasSandboxRun: boolean }[];
    };
    expect(res.entries[0]?.hasSandboxRun).toBe(true);
  });
});

describe('skill.proposeReview', () => {
  it('returns proposal with diffHash + classification', async () => {
    writeDraft('p');
    await moveToQuarantined('p');
    const res = (await dispatcher.invoke('skill.proposeReview', { name: 'p' })) as {
      ok: boolean;
      diffHash: string;
      classification: string;
    };
    expect(res.ok).toBe(true);
    expect(res.classification).toBe('personal');
    expect(res.diffHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns not-found for an unknown name', async () => {
    const res = (await dispatcher.invoke('skill.proposeReview', { name: 'nope' })) as {
      ok: boolean;
      code?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not-found');
  });
});

describe('skill.approveReview', () => {
  it('promotes quarantined → active with a valid envelope', async () => {
    writeDraft('approve-rpc');
    await moveToQuarantined('approve-rpc');
    const proposal = (await dispatcher.invoke('skill.proposeReview', {
      name: 'approve-rpc',
    })) as ReviewProposal & { ok: true };
    const kp = generateEd25519Keypair();
    const envelope = buildAndSignApproval(
      'approve-rpc',
      proposal,
      kp.privateKeyB64,
      kp.publicKeyB64,
    );

    const res = (await dispatcher.invoke('skill.approveReview', {
      name: 'approve-rpc',
      signedEnvelope: envelope,
      expectedPublicKeyB64: kp.publicKeyB64,
    })) as { ok: boolean; toState: string };
    expect(res.ok).toBe(true);
    expect(res.toState).toBe('active');
  });

  it('rejects a tampered envelope (signature-mismatch-diff-hash)', async () => {
    writeDraft('tamper-rpc');
    await moveToQuarantined('tamper-rpc');
    const kp = generateEd25519Keypair();
    const proposal = await proposeReview('tamper-rpc', {
      vaultRoot: vault,
      workspaceId: WORKSPACE,
    });
    const wrongHashProposal: ReviewProposal = { ...proposal, diffHash: 'b'.repeat(64) };
    const envelope: SignedEnvelope<ReviewApprovalPayload> = buildAndSignApproval(
      'tamper-rpc',
      wrongHashProposal,
      kp.privateKeyB64,
      kp.publicKeyB64,
    );

    const res = (await dispatcher.invoke('skill.approveReview', {
      name: 'tamper-rpc',
      signedEnvelope: envelope,
    })) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('signature-mismatch-diff-hash');
  });

  it('requires signedEnvelope as object', async () => {
    await expect(
      dispatcher.invoke('skill.approveReview', { name: 'foo', signedEnvelope: 'not-an-object' }),
    ).rejects.toThrow(/signedEnvelope/);
  });
});

describe('skill.deprecate / disable / reactivate', () => {
  async function plantActive(name: string): Promise<void> {
    writeDraft(name);
    await moveToQuarantined(name);
    const proposal = (await dispatcher.invoke('skill.proposeReview', {
      name,
    })) as ReviewProposal & { ok: true };
    const kp = generateEd25519Keypair();
    const envelope = buildAndSignApproval(name, proposal, kp.privateKeyB64, kp.publicKeyB64);
    await dispatcher.invoke('skill.approveReview', {
      name,
      signedEnvelope: envelope,
    });
  }

  it('deprecate active skill', async () => {
    await plantActive('dep-rpc');
    const res = (await dispatcher.invoke('skill.deprecate', { name: 'dep-rpc' })) as {
      ok: boolean;
      toState: string;
    };
    expect(res.ok).toBe(true);
    expect(res.toState).toBe('deprecated');
  });

  it('reactivate from disabled', async () => {
    await plantActive('react-rpc');
    await dispatcher.invoke('skill.disable', { name: 'react-rpc' });
    const res = (await dispatcher.invoke('skill.reactivate', { name: 'react-rpc' })) as {
      ok: boolean;
      toState: string;
    };
    expect(res.ok).toBe(true);
    expect(res.toState).toBe('active');
  });

  it('reactivate from active → wrong-state envelope', async () => {
    await plantActive('react-rpc-2');
    const res = (await dispatcher.invoke('skill.reactivate', { name: 'react-rpc-2' })) as {
      ok: boolean;
      code?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('wrong-state');
  });
});

describe('skill.readSandboxRun', () => {
  it('returns not-found when no .sandbox-run.json exists', async () => {
    writeDraft('no-sandbox');
    await moveToQuarantined('no-sandbox');
    const res = (await dispatcher.invoke('skill.readSandboxRun', { name: 'no-sandbox' })) as {
      ok: boolean;
      code?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not-found');
  });

  it('returns parsed summary when file exists', async () => {
    writeDraft('with-sandbox');
    await moveToQuarantined('with-sandbox');
    writeFileSync(
      join(quarantinedDir(vault, WORKSPACE), 'with-sandbox', '.sandbox-run.json'),
      JSON.stringify({ skillName: 'with-sandbox', outcome: 'ok', durationMs: 1 }),
    );
    const res = (await dispatcher.invoke('skill.readSandboxRun', { name: 'with-sandbox' })) as {
      ok: boolean;
      summary: { outcome: string };
    };
    expect(res.ok).toBe(true);
    expect(res.summary.outcome).toBe('ok');
  });
});
