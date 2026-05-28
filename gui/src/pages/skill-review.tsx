/**
 * Skill-Review-Page (Phase 5c-4) — surfaces all quarantined skills,
 * lets the reviewer pick one, renders the diff + sandbox-run summary,
 * and exposes a "Sign + Activate" call-to-action.
 *
 * The actual native-password approval flow ships in Phase 5c-5
 * (Tauri-only). For now the CTA is gated behind a stub modal that
 * tells the user to run the CLI:
 *
 *   $ claude-os skill propose-review <name>      # capture proposal
 *   $ # sign externally (offline ed25519)
 *   $ claude-os skill promote <name> --to-active --signed-envelope sig.json
 *
 * @module @pages/skill-review
 */
import { useCallback, useEffect, useState } from 'react';
import { SkillDiffView } from '../components/SkillDiffView';
import {
  listSkillQuarantined,
  proposeSkillReview,
  type SkillProposeReviewResult,
  type SkillQuarantinedSummary,
  type SkillReviewProposal,
} from '../lib/rpc';

interface ListState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly entries: readonly SkillQuarantinedSummary[];
}

interface ProposalState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly proposal: SkillReviewProposal | null;
}

const INITIAL_LIST: ListState = { loading: true, error: null, entries: [] };
const INITIAL_PROPOSAL: ProposalState = { loading: false, error: null, proposal: null };

function isProposalOk(r: SkillProposeReviewResult): r is SkillReviewProposal {
  return r.ok === true;
}

function relativeTime(mtimeMs: number): string {
  const diff = Date.now() - mtimeMs;
  if (diff < 60_000) return 'gerade';
  if (diff < 3600_000) return `vor ${Math.floor(diff / 60_000)} min`;
  if (diff < 86400_000) return `vor ${Math.floor(diff / 3600_000)} h`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

export function SkillReviewPage() {
  const [list, setList] = useState<ListState>(INITIAL_LIST);
  const [selected, setSelected] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposalState>(INITIAL_PROPOSAL);
  const [signInfoOpen, setSignInfoOpen] = useState(false);

  const refresh = useCallback(async () => {
    setList((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const r = await listSkillQuarantined();
      setList({ loading: false, error: null, entries: r.entries });
      // Drop selection if it no longer exists.
      setSelected((prev) =>
        prev !== null && r.entries.some((e) => e.name === prev)
          ? prev
          : (r.entries[0]?.name ?? null),
      );
    } catch (err) {
      setList({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        entries: [],
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load proposal whenever selection changes.
  useEffect(() => {
    if (selected === null) {
      setProposal(INITIAL_PROPOSAL);
      return;
    }
    let cancelled = false;
    setProposal({ loading: true, error: null, proposal: null });
    proposeSkillReview(selected)
      .then((r) => {
        if (cancelled) return;
        if (isProposalOk(r)) {
          setProposal({ loading: false, error: null, proposal: r });
        } else {
          setProposal({
            loading: false,
            error: `${r.code}: ${r.message}`,
            proposal: null,
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setProposal({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          proposal: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (list.loading && list.entries.length === 0) {
    return (
      <div className="skill-review-page">
        <h1>Skill-Review</h1>
        <p>Lade …</p>
      </div>
    );
  }

  if (list.error !== null) {
    return (
      <div className="skill-review-page">
        <h1>Skill-Review</h1>
        <div className="banner banner-error" role="alert">
          {list.error}
        </div>
        <button type="button" onClick={() => void refresh()}>
          Erneut versuchen
        </button>
      </div>
    );
  }

  if (list.entries.length === 0) {
    return (
      <div className="skill-review-page">
        <h1>Skill-Review</h1>
        <p className="skill-review-page__empty">
          Keine Pending-Reviews. Erzeuge Drafts via <code>claude-os skill list-drafts</code> und
          befördere sie via <code>claude-os skill promote &lt;name&gt; --to-quarantined</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="skill-review-page">
      <header className="skill-review-page__header">
        <h1>Skill-Review</h1>
        <button type="button" onClick={() => void refresh()} aria-label="Liste neu laden">
          Aktualisieren
        </button>
      </header>

      <div className="skill-review-page__layout">
        <nav className="skill-review-page__list" aria-label="Pending Skills">
          {list.entries.map((e) => (
            <button
              key={e.name}
              type="button"
              className={
                selected === e.name
                  ? 'skill-review-page__list-item skill-review-page__list-item--active'
                  : 'skill-review-page__list-item'
              }
              onClick={() => setSelected(e.name)}
            >
              <span className="skill-review-page__list-name">{e.name}</span>
              <span className="skill-review-page__list-meta">
                {relativeTime(e.mtimeMs)}{' '}
                {e.hasSandboxRun ? '• Sandbox-Run vorhanden' : '• kein Sandbox-Run'}
              </span>
            </button>
          ))}
        </nav>

        <section className="skill-review-page__detail">
          {selected === null ? (
            <p>Bitte einen Skill links auswählen.</p>
          ) : proposal.loading ? (
            <p>Lade Proposal …</p>
          ) : proposal.error !== null ? (
            <div className="banner banner-error" role="alert">
              {proposal.error}
            </div>
          ) : proposal.proposal !== null ? (
            <ProposalPanel proposal={proposal.proposal} onSign={() => setSignInfoOpen(true)} />
          ) : null}
        </section>
      </div>

      {signInfoOpen && (
        <SignInfoModal
          onClose={() => setSignInfoOpen(false)}
          skillName={selected ?? ''}
          diffHash={proposal.proposal?.diffHash ?? ''}
        />
      )}
    </div>
  );
}

interface ProposalPanelProps {
  readonly proposal: SkillReviewProposal;
  readonly onSign: () => void;
}

function ProposalPanel({ proposal, onSign }: ProposalPanelProps) {
  const isNew = proposal.beforeContent === '';

  return (
    <div className="skill-review-page__proposal">
      <div className="skill-review-page__proposal-meta">
        <span>
          <strong>Skill:</strong> {proposal.name}
        </span>
        <span>
          <strong>Classification:</strong> {proposal.classification}
        </span>
        <span>
          <strong>diffHash:</strong>{' '}
          <code className="skill-review-page__hash">{proposal.diffHash.slice(0, 16)}…</code>
        </span>
        {isNew && <span className="skill-review-page__pill">Neu (kein aktiver Vorgänger)</span>}
      </div>

      {proposal.sandboxRunSummary !== null && (
        <div className="skill-review-page__sandbox-card">
          <h3>Sandbox-Run</h3>
          <dl>
            <dt>Status</dt>
            <dd>
              <span
                className={`skill-review-page__pill skill-review-page__pill--${proposal.sandboxRunSummary.outcome}`}
              >
                {proposal.sandboxRunSummary.outcome}
              </span>
            </dd>
            <dt>Dauer</dt>
            <dd>{proposal.sandboxRunSummary.durationMs} ms</dd>
            <dt>Lauf-Zeitpunkt</dt>
            <dd>{proposal.sandboxRunSummary.runAtIso}</dd>
            {proposal.sandboxRunSummary.killedBy !== null && (
              <>
                <dt>Abbruch</dt>
                <dd>{proposal.sandboxRunSummary.killedBy}</dd>
              </>
            )}
            {proposal.sandboxRunSummary.errorMessage !== null && (
              <>
                <dt>Fehler</dt>
                <dd>{proposal.sandboxRunSummary.errorMessage}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      <SkillDiffView
        name={proposal.name}
        classification={proposal.classification}
        beforeContent={proposal.beforeContent}
        afterContent={proposal.afterContent}
      />

      <div className="skill-review-page__actions">
        <button type="button" onClick={onSign}>
          Signieren + aktivieren …
        </button>
      </div>
    </div>
  );
}

interface SignInfoModalProps {
  readonly onClose: () => void;
  readonly skillName: string;
  readonly diffHash: string;
}

function SignInfoModal({ onClose, skillName, diffHash }: SignInfoModalProps) {
  return (
    <div className="modal-backdrop">
      <button
        type="button"
        className="modal-backdrop-button"
        aria-label="Modal schließen"
        onClick={onClose}
      />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Skill signieren">
        <h2>Signieren + aktivieren</h2>
        <p>Native-Password-Approval folgt in Phase 5c-5. Bis dahin nutze den CLI-Flow:</p>
        <pre className="modal-code">
          {`# 1) Proposal generieren (capture diffHash):
$ claude-os skill propose-review ${skillName} --json > proposal.json

# 2) Envelope extern signieren (Ed25519 offline tool):
$ # erwartete diffHash: ${diffHash.slice(0, 16)}…
$ # signiere {skillId, diffHash, classification, reviewedAtIso}

# 3) Activate via signed envelope:
$ claude-os skill promote ${skillName} --to-active --signed-envelope sig.json`}
        </pre>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>
            Verstanden
          </button>
        </div>
      </div>
    </div>
  );
}
