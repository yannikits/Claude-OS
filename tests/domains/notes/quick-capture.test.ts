import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppendInput, AuditLogger } from '../../../src/core/audit/index.js';
import {
  buildFilename,
  defaultClassification,
  NotesError,
  quickCapture,
  slugifyTitle,
} from '../../../src/domains/notes/index.js';
import { WorkspaceError } from '../../../src/domains/workspace/index.js';

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
        hostname: 'test-host',
      };
    }),
  };
  return { sink, entries };
};

describe('slugifyTitle', () => {
  it('lowercase + asciifies umlauts', () => {
    expect(slugifyTitle('Übergabe Müller')).toBe('uebergabe-mueller');
  });

  it('replaces non-ascii-non-alnum with dashes', () => {
    expect(slugifyTitle('VPN/MTU @ Kunde XY!')).toBe('vpn-mtu-kunde-xy');
  });

  it('collapses runs of dashes', () => {
    expect(slugifyTitle('a   b   c')).toBe('a-b-c');
  });

  it('caps at 60 chars', () => {
    const long = 'a'.repeat(120);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(60);
  });

  it('returns "note" for empty-after-slug input', () => {
    expect(slugifyTitle('!!!')).toBe('note');
  });

  it('handles ß correctly', () => {
    expect(slugifyTitle('Straße')).toBe('strasse');
  });
});

describe('buildFilename', () => {
  it('builds ISO-prefixed slug filename', () => {
    const now = new Date('2026-05-27T01:35:22.123Z');
    expect(buildFilename(now, 'VPN MTU Fix')).toBe('2026-05-27T01-35-22Z-vpn-mtu-fix.md');
  });

  it('avoids path-illegal `:` chars in the timestamp', () => {
    const now = new Date('2026-05-27T01:35:22.000Z');
    const fn = buildFilename(now, 'x');
    expect(fn).not.toContain(':');
  });
});

describe('defaultClassification', () => {
  it('customer-confidential for msp-customers/*', () => {
    expect(defaultClassification('msp-customers/acme')).toBe('customer-confidential');
  });

  it('operational for msp-internal', () => {
    expect(defaultClassification('msp-internal')).toBe('operational');
  });

  it('personal for everything else', () => {
    expect(defaultClassification('personal')).toBe('personal');
    expect(defaultClassification('some-random-id')).toBe('personal');
  });
});

describe('quickCapture', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'qc-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('writes a note in the active workspace with Quick-Capture frontmatter', () => {
    const audit = fakeAudit();
    const res = quickCapture(
      vault,
      {
        title: 'VPN MTU bei Kunde Acme',
        body: '## Symptom\n\nVPN bricht ab nach 30s\n',
        source: 'anruf',
        category: 'incident',
      },
      {
        activeWorkspaceProvider: () => 'msp-customers/acme',
        nowFactory: () => new Date('2026-05-27T10:00:00Z'),
        auditLogger: audit.sink,
      },
    );

    expect(res.workspace).toBe('msp-customers/acme');
    expect(res.tenant).toBe('acme');
    expect(res.created).toBe(true);
    expect(res.path.endsWith('.md')).toBe(true);
    expect(existsSync(res.path)).toBe(true);

    const written = readFileSync(res.path, 'utf8');
    expect(written).toContain('classification: customer-confidential');
    expect(written).toContain('source: anruf');
    expect(written).toContain('category: incident');
    expect(written).toContain('status: offen');
    expect(written).toContain('tenant: acme');
    expect(written).toContain('tanss_status: null');
    expect(written).toContain('VPN bricht ab');
  });

  it('uses defaultClassification per workspace family', () => {
    quickCapture(
      vault,
      {
        title: 'Note',
        body: 'body',
        source: 'eigeninitiative',
        category: 'doku',
      },
      {
        activeWorkspaceProvider: () => 'msp-internal',
        nowFactory: () => new Date('2026-05-27T10:00:00Z'),
      },
    );
    // No throw → operational classification accepted by writer.
  });

  it('rejects empty title', () => {
    expect(() =>
      quickCapture(
        vault,
        { title: '  ', body: 'x', source: 'anruf', category: 'incident' },
        { activeWorkspaceProvider: () => 'personal' },
      ),
    ).toThrow(NotesError);
  });

  it('rejects empty body', () => {
    expect(() =>
      quickCapture(
        vault,
        { title: 'x', body: '', source: 'anruf', category: 'incident' },
        { activeWorkspaceProvider: () => 'personal' },
      ),
    ).toThrow(NotesError);
  });

  it('rejects synthetic _unsorted workspace', () => {
    expect(() =>
      quickCapture(
        vault,
        { title: 'x', body: 'y', source: 'anruf', category: 'incident' },
        { activeWorkspaceProvider: () => '_unsorted' },
      ),
    ).toThrow(WorkspaceError);
  });

  it('rejects workspace-drift when caller-supplied workspace mismatches active', () => {
    expect(() =>
      quickCapture(
        vault,
        {
          title: 'x',
          body: 'y',
          source: 'anruf',
          category: 'incident',
          workspace: 'msp-customers/other',
        },
        { activeWorkspaceProvider: () => 'msp-customers/acme' },
      ),
    ).toThrow(WorkspaceError);
  });

  it('accepts workspace-pass-through when it matches active (drift detection)', () => {
    expect(() =>
      quickCapture(
        vault,
        {
          title: 'x',
          body: 'y',
          source: 'anruf',
          category: 'incident',
          workspace: 'msp-customers/acme',
        },
        {
          activeWorkspaceProvider: () => 'msp-customers/acme',
          nowFactory: () => new Date('2026-05-27T10:00:00Z'),
        },
      ),
    ).not.toThrow();
  });

  it('emits audit-log entry on success with kind=note.write action=quick-capture', () => {
    const audit = fakeAudit();
    quickCapture(
      vault,
      { title: 'x', body: 'y', source: 'anruf', category: 'incident' },
      {
        activeWorkspaceProvider: () => 'msp-customers/acme',
        nowFactory: () => new Date('2026-05-27T10:00:00Z'),
        auditLogger: audit.sink,
      },
    );

    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0];
    if (entry === undefined) throw new Error('expected entry');
    expect(entry.kind).toBe('note.write');
    expect(entry.action).toBe('quick-capture');
    expect(entry.workspace).toBe('msp-customers/acme');
    expect(entry.tenant).toBe('acme');
    expect(entry.outcome).toBe('ok');
    expect(entry.details?.source).toBe('anruf');
    expect(entry.details?.category).toBe('incident');
  });

  it('skips audit-log when no logger is injected', () => {
    quickCapture(
      vault,
      { title: 'x', body: 'y', source: 'anruf', category: 'incident' },
      {
        activeWorkspaceProvider: () => 'personal',
        nowFactory: () => new Date('2026-05-27T10:00:00Z'),
      },
    );
    // Smoke — no throw, no logger.
  });

  it('omits tags from frontmatter when empty array supplied', () => {
    const res = quickCapture(
      vault,
      {
        title: 'x',
        body: 'y',
        source: 'anruf',
        category: 'incident',
        tags: [],
      },
      {
        activeWorkspaceProvider: () => 'personal',
        nowFactory: () => new Date('2026-05-27T10:00:00Z'),
      },
    );
    const written = readFileSync(res.path, 'utf8');
    expect(written).not.toMatch(/^tags:/m);
  });

  it('records tanss_ticket_id when supplied (TANSS-bridge prep)', () => {
    const res = quickCapture(
      vault,
      {
        title: 'x',
        body: 'y',
        source: 'mail',
        category: 'incident',
        tanssTicketId: 'T-12345',
      },
      {
        activeWorkspaceProvider: () => 'msp-customers/acme',
        nowFactory: () => new Date('2026-05-27T10:00:00Z'),
      },
    );
    const written = readFileSync(res.path, 'utf8');
    expect(written).toContain('tanss_ticket_id: T-12345');
    expect(written).toContain('tanss_status: null');
  });
});
