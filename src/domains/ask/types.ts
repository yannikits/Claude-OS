/**
 * Ask-domain types — prompt composition for the `claude-os ask`
 * workflow.
 *
 * Per ADR-0003 + ROADMAP MVP-DoD §4: claude-os composes the prompt
 * with context-injection, then delegates execution to `bin/claude.exe`
 * (no own provider interface, no model selection).
 *
 * @module @domains/ask/types
 */
import type { RetrievalHit } from '../retrieval/index.js';

export interface ComposedPrompt {
  /** Final text to send to `claude.exe -p "..."`. */
  readonly text: string;
  /** Hits actually injected (after any truncation). */
  readonly contextHits: readonly RetrievalHit[];
  /** Approx total character count (for sanity-check vs. CLI arg limits). */
  readonly chars: number;
}

export interface ComposeOpts {
  /** Workspace id the context originates from — surfaced in the header. */
  readonly workspaceId: string;
  /** Per-note body cap to avoid blowing through CLI arg-length limits. */
  readonly perNoteCharLimit?: number;
  /** Total composed-prompt cap. Dropping hits from the tail when exceeded. */
  readonly totalCharLimit?: number;
}

export class AskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskError';
  }
}
