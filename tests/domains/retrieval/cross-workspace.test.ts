import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppendInput, AuditLogger } from '../../../src/core/audit/index.js';
import {
  buildScope,
  crossWorkspaceSearch,
  RetrievalError,
} from '../../../src/domains/retrieval/index.js';
import type { Workspace } from '../../../src/domains/workspace/index.js';

const fakeAudit = () => {
  const entries: AppendInput[] = [];
  const sink: Pick<AuditLogger, 'append'> = {
    append: vi.fn((input: AppendInput) => {
      entries.push(input);
      return {
        at: new Date().toISOString(),
        kind: input.kind,
        action: input.action,
        workspace: input.workspace,
        ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
        outcome: input.outcome,
        ...(input.details === undefined ? {} : { details: input.details }),
        pid: 1234,
        hostname: 'test',
      };
    }),
  };
  return { sink, entries };
};

const ws = (id: string): Workspace => ({
  id,
  kind: id.startsWith('msp-customers/')
    ? 'msp-customers'
    : id === 'msp-internal'
      ? 'msp-internal'
      : 'personal',
  path: `/vault/Claude-OS/workspaces/${id}`,
});

describe('buildScope', () => {
  it('default scope is [active, msp-internal] when crossCustomer=false', () => {
    expect(buildScope('msp-customers/acme', false, [])).toEqual([
      'msp-customers/acme',
      'msp-internal',
    ]);
  });

  it('dedups when active === msp-internal', () => {
    expect(buildScope('msp-internal', false, [])).toEqual(['msp-internal']);
  });

  it('dedups when active === personal (no msp-internal collision)', () => {
    expect(buildScope('personal', false, [])).toEqual(['personal', 'msp-internal']);
  });

  it('includes all msp-customers/* when crossCustomer=true', () => {
    const list = [
      ws('personal'),
      ws('msp-internal'),
      ws('msp-customers/acme'),
      ws('msp-customers/bravo'),
    ];
    const scope = buildScope('msp-customers/acme', true, list);
    expect(scope).toEqual([
      'msp-customers/acme', // active first
      'msp-internal',
      'msp-customers/bravo', // alphabetically after acme (which is already in)
    ]);
  });

  it('filters _unsorted from cross-customer iteration', () => {
    const list = [
      ws('msp-customers/acme'),
      { id: '_unsorted', kind: 'unsorted' as const, path: null },
    ];
    const scope = buildScope('msp-customers/acme', true, list);
    expect(scope).not.toContain('_unsorted');
  });

  it('throws when active workspace is _unsorted', () => {
    expect(() => buildScope('_unsorted', false, [])).toThrow(RetrievalError);
  });
});

describe('crossWorkspaceSearch', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'xws-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  const seedNote = (
    workspaceId: string,
    filename: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ) => {
    const wsDir = join(vault, 'Claude-OS', 'workspaces', workspaceId);
    mkdirSync(wsDir, { recursive: true });
    const fmLines = Object.entries({
      workspace: workspaceId,
      classification: 'operational',
      schema_version: 1,
      ...frontmatter,
    })
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n');
    writeFileSync(join(wsDir, filename), `---\n${fmLines}\n---\n\n${body}`, 'utf8');
  };

  it('searches only active + msp-internal by default', () => {
    seedNote('msp-customers/acme', 'a.md', {}, 'VPN MTU fragmentation fix');
    seedNote('msp-internal', 'b.md', {}, 'VPN troubleshooting playbook');
    seedNote('msp-customers/bravo', 'c.md', {}, 'VPN MTU something');

    const res = crossWorkspaceSearch(
      vault,
      {
        query: { text: 'VPN MTU' },
        activeWorkspace: 'msp-customers/acme',
        // crossCustomer omitted → default false
      },
      {
        workspaceLister: () => [
          ws('msp-customers/acme'),
          ws('msp-internal'),
          ws('msp-customers/bravo'),
        ],
      },
    );

    expect(res.crossCustomer).toBe(false);
    expect(res.scope).toEqual(['msp-customers/acme', 'msp-internal']);
    // Bravo MUST NOT appear in default-scope hits.
    const hitWorkspaces = new Set(res.hits.map((h) => h.note.workspace));
    expect(hitWorkspaces.has('msp-customers/bravo')).toBe(false);
  });

  it('includes other customer workspaces when crossCustomer=true', () => {
    seedNote('msp-customers/acme', 'a.md', {}, 'VPN MTU fragmentation');
    seedNote('msp-customers/bravo', 'b.md', {}, 'VPN MTU different fix');

    const res = crossWorkspaceSearch(
      vault,
      {
        query: { text: 'VPN MTU' },
        activeWorkspace: 'msp-customers/acme',
        crossCustomer: true,
      },
      {
        workspaceLister: () => [ws('msp-customers/acme'), ws('msp-customers/bravo')],
      },
    );

    expect(res.crossCustomer).toBe(true);
    expect(res.scope).toContain('msp-customers/bravo');
    const hitWorkspaces = res.hits.map((h) => h.note.workspace);
    expect(hitWorkspaces).toContain('msp-customers/bravo');
  });

  it('emits audit-log entry on cross-customer search', () => {
    seedNote('msp-customers/acme', 'a.md', {}, 'VPN');
    seedNote('msp-customers/bravo', 'b.md', {}, 'VPN');

    const audit = fakeAudit();
    crossWorkspaceSearch(
      vault,
      {
        query: { text: 'VPN' },
        activeWorkspace: 'msp-customers/acme',
        crossCustomer: true,
      },
      {
        workspaceLister: () => [ws('msp-customers/acme'), ws('msp-customers/bravo')],
        auditLogger: audit.sink,
        subjectTenant: 'tok-deadbeef',
      },
    );

    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0];
    if (entry === undefined) throw new Error('expected entry');
    expect(entry.kind).toBe('bridge.read');
    expect(entry.action).toBe('cross-workspace-search');
    expect(entry.workspace).toBe('msp-customers/acme');
    expect(entry.tenant).toBe('tok-deadbeef');
    expect(entry.outcome).toBe('ok');
    expect(entry.details?.scope).toContain('msp-customers/bravo');
    expect(entry.details?.queryLen).toBe('VPN'.length);
    // Query text MUST NOT appear in audit details — privacy.
    expect(JSON.stringify(entry.details)).not.toContain('"VPN"');
  });

  it('does NOT emit audit-log entry for default-scope search', () => {
    seedNote('msp-customers/acme', 'a.md', {}, 'VPN');
    const audit = fakeAudit();
    crossWorkspaceSearch(
      vault,
      { query: { text: 'VPN' }, activeWorkspace: 'msp-customers/acme' },
      {
        workspaceLister: () => [ws('msp-customers/acme'), ws('msp-internal')],
        auditLogger: audit.sink,
      },
    );
    expect(audit.entries).toHaveLength(0);
  });

  it('respects redactInCrossSearch=true for non-active workspaces', () => {
    seedNote('msp-customers/acme', 'visible.md', {}, 'VPN MTU active visible');
    seedNote(
      'msp-customers/bravo',
      'redacted.md',
      { redactInCrossSearch: true },
      'VPN MTU redacted bravo',
    );
    seedNote('msp-customers/bravo', 'public.md', {}, 'VPN MTU public bravo');

    const res = crossWorkspaceSearch(
      vault,
      {
        query: { text: 'VPN MTU' },
        activeWorkspace: 'msp-customers/acme',
        crossCustomer: true,
      },
      {
        workspaceLister: () => [ws('msp-customers/acme'), ws('msp-customers/bravo')],
      },
    );

    const paths = res.hits.map((h) => h.note.path);
    expect(paths.some((p) => p.includes('redacted.md'))).toBe(false);
    expect(paths.some((p) => p.includes('public.md'))).toBe(true);
    expect(paths.some((p) => p.includes('visible.md'))).toBe(true);
  });

  it('shows local notes even if their own redactInCrossSearch is true (local always visible)', () => {
    seedNote(
      'msp-customers/acme',
      'local-redact.md',
      { redactInCrossSearch: true },
      'VPN MTU local always shown',
    );

    const res = crossWorkspaceSearch(
      vault,
      {
        query: { text: 'VPN MTU' },
        activeWorkspace: 'msp-customers/acme',
        crossCustomer: true,
      },
      {
        workspaceLister: () => [ws('msp-customers/acme')],
      },
    );

    expect(res.hits.length).toBe(1);
    expect(res.hits[0]?.note.path).toContain('local-redact.md');
  });

  it('caps results at topK', () => {
    for (let i = 0; i < 25; i++) {
      seedNote('msp-customers/acme', `note-${i}.md`, {}, 'VPN MTU note number ' + i);
    }
    const res = crossWorkspaceSearch(
      vault,
      {
        query: { text: 'VPN MTU', topK: 5 },
        activeWorkspace: 'msp-customers/acme',
      },
      {
        workspaceLister: () => [ws('msp-customers/acme'), ws('msp-internal')],
      },
    );
    expect(res.hits.length).toBeLessThanOrEqual(5);
  });

  it('tolerates missing workspace directories (returns partial result)', () => {
    seedNote('msp-customers/acme', 'a.md', {}, 'VPN MTU acme');
    // msp-customers/ghost is in the lister but has no on-disk dir.
    const res = crossWorkspaceSearch(
      vault,
      {
        query: { text: 'VPN MTU' },
        activeWorkspace: 'msp-customers/acme',
        crossCustomer: true,
      },
      {
        workspaceLister: () => [ws('msp-customers/acme'), ws('msp-customers/ghost')],
      },
    );
    // ghost was attempted but yielded 0 hits; acme yielded 1.
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]?.note.workspace).toBe('msp-customers/acme');
  });

  it('throws when active workspace is _unsorted', () => {
    expect(() =>
      crossWorkspaceSearch(
        vault,
        { query: { text: 'x' }, activeWorkspace: '_unsorted' },
        { workspaceLister: () => [] },
      ),
    ).toThrow(RetrievalError);
  });
});
