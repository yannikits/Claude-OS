/**
 * Side-by-side diff renderer for the Skill-Review GUI (Phase 5c-4).
 *
 * Wraps `diff@9` `createTwoFilesPatch()` to compute a unified-diff
 * patch over the before/after SKILL.md content, then re-folds the
 * hunks into a two-column line-by-line view. Frontmatter and body
 * are presented as separate panels so a reviewer can spot a
 * metadata-only change (e.g. classification bump) at a glance.
 *
 * For `classification === 'customer-confidential'` we surface a
 * prominent red warn-banner so Yannik can't approve without seeing
 * the sensitivity tag.
 *
 * @module gui/components/SkillDiffView
 */
import { createTwoFilesPatch } from 'diff';
import { useMemo } from 'react';

interface SkillDiffViewProps {
  readonly name: string;
  readonly classification: string;
  readonly beforeContent: string;
  readonly afterContent: string;
}

interface ParsedSkill {
  readonly frontmatter: string;
  readonly body: string;
}

interface DiffLine {
  readonly kind: 'context' | 'add' | 'del' | 'hunk';
  readonly text: string;
}

function splitFrontmatter(raw: string): ParsedSkill {
  if (raw.length === 0) return { frontmatter: '', body: '' };
  // Frontmatter contract: `---\n…\n---\n<body>` per draft-generator.
  // Tolerate missing frontmatter by returning whole content as body.
  const start = raw.indexOf('---');
  if (start !== 0) return { frontmatter: '', body: raw };
  const end = raw.indexOf('\n---\n', 3);
  if (end < 0) return { frontmatter: '', body: raw };
  return {
    frontmatter: raw.slice(0, end + 5),
    body: raw.slice(end + 5),
  };
}

function patchToLines(patch: string): DiffLine[] {
  const lines = patch.split('\n');
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true;
      out.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue; // skip ===\n--- \n+++ headers
    if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      out.push({ kind: 'context', text: line.slice(1) });
    }
  }
  return out;
}

export function SkillDiffView({
  name,
  classification,
  beforeContent,
  afterContent,
}: SkillDiffViewProps) {
  const sensitive = classification === 'customer-confidential';

  const { frontmatterDiff, bodyDiff, hasFrontmatterDiff, hasBodyDiff } = useMemo(() => {
    const before = splitFrontmatter(beforeContent);
    const after = splitFrontmatter(afterContent);
    const fm = createTwoFilesPatch(
      'before.frontmatter',
      'after.frontmatter',
      before.frontmatter,
      after.frontmatter,
      undefined,
      undefined,
      { context: 3 },
    );
    const body = createTwoFilesPatch(
      'before.body',
      'after.body',
      before.body,
      after.body,
      undefined,
      undefined,
      { context: 3 },
    );
    return {
      frontmatterDiff: patchToLines(fm),
      bodyDiff: patchToLines(body),
      hasFrontmatterDiff: fm.includes('@@'),
      hasBodyDiff: body.includes('@@'),
    };
  }, [beforeContent, afterContent]);

  return (
    <div className="skill-diff" data-skill={name}>
      {sensitive && (
        <div className="skill-diff__sensitive-banner" role="alert">
          <strong>Customer-Confidential</strong> — dieser Skill berührt Customer-Daten. Doppelt
          prüfen, bevor du signierst.
        </div>
      )}

      <section className="skill-diff__section">
        <h3>Frontmatter</h3>
        {hasFrontmatterDiff ? (
          <DiffLines lines={frontmatterDiff} />
        ) : (
          <p className="skill-diff__nochange">(Frontmatter unverändert.)</p>
        )}
      </section>

      <section className="skill-diff__section">
        <h3>Body</h3>
        {hasBodyDiff ? (
          <DiffLines lines={bodyDiff} />
        ) : (
          <p className="skill-diff__nochange">(Body unverändert.)</p>
        )}
      </section>
    </div>
  );
}

function DiffLines({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <pre className="skill-diff__hunks">
      {lines.map((l, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable order from diff hunks
        <div key={idx} className={`skill-diff__line skill-diff__line--${l.kind}`}>
          <span className="skill-diff__marker" aria-hidden="true">
            {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'hunk' ? '@' : ' '}
          </span>
          <span className="skill-diff__text">{l.text}</span>
        </div>
      ))}
    </pre>
  );
}
