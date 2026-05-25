/**
 * Composes the final prompt that gets handed to `claude.exe -p "..."`.
 *
 * Layout:
 *
 *     # Context (from workspace: <id>)
 *
 *     Below are notes from your Obsidian vault that scored highest
 *     against the user's question. Use them as background when
 *     answering. They are not authoritative — if they contradict the
 *     question, ask for clarification rather than guessing.
 *
 *     ## Note: <relative-path>
 *     <body, truncated to perNoteCharLimit>
 *
 *     ...
 *
 *     # User question
 *
 *     <query>
 *
 * Drops hits from the tail until the total stays under `totalCharLimit`.
 * Per-note body is hard-truncated with a `[... truncated]` marker.
 *
 * Defaults:
 *   - perNoteCharLimit:  4_000  (~1k tokens of body per note)
 *   - totalCharLimit:    24_000 (~6k tokens; CLI arg-limit is the cap)
 *
 * @module @domains/ask/prompt-composer
 */
import type { RetrievalHit } from '../retrieval/index.js';
import type { ComposedPrompt, ComposeOpts } from './types.js';

const DEFAULT_PER_NOTE_CHAR_LIMIT = 4_000;
const DEFAULT_TOTAL_CHAR_LIMIT = 24_000;
const TRUNCATION_MARKER = '\n\n[... note truncated]';

const HEADER_PREAMBLE =
  'Below are notes from your Obsidian vault that scored highest against ' +
  "the user's question. Use them as background when answering. They are " +
  'not authoritative — if they contradict the question, ask for ' +
  'clarification rather than guessing.';

/**
 * Composes a single prompt-string from a query + retrieval hits.
 *
 * If `hits` is empty, the output skips the entire context block and
 * just contains the user question.
 */
export function composePrompt(
  query: string,
  hits: readonly RetrievalHit[],
  opts: ComposeOpts,
): ComposedPrompt {
  const perNote = opts.perNoteCharLimit ?? DEFAULT_PER_NOTE_CHAR_LIMIT;
  const total = opts.totalCharLimit ?? DEFAULT_TOTAL_CHAR_LIMIT;

  if (hits.length === 0) {
    const text = renderUserQuestion(query);
    return { text, contextHits: [], chars: text.length };
  }

  const blocks: string[] = [];
  const accepted: RetrievalHit[] = [];
  let runningChars = renderHeader(opts.workspaceId).length + renderUserQuestion(query).length;

  for (const hit of hits) {
    const block = renderNoteBlock(hit, perNote);
    if (runningChars + block.length > total) break;
    blocks.push(block);
    accepted.push(hit);
    runningChars += block.length;
  }

  if (accepted.length === 0) {
    // All hits exceeded the budget even truncated — fall back to
    // question-only so the caller still gets a usable prompt.
    const text = renderUserQuestion(query);
    return { text, contextHits: [], chars: text.length };
  }

  const text = `${renderHeader(opts.workspaceId)}\n${blocks.join('\n')}\n${renderUserQuestion(query)}`;
  return { text, contextHits: accepted, chars: text.length };
}

function renderHeader(workspaceId: string): string {
  return `# Context (from workspace: ${workspaceId})\n\n${HEADER_PREAMBLE}\n`;
}

function renderNoteBlock(hit: RetrievalHit, perNoteLimit: number): string {
  const body = truncate(hit.note.body.trim(), perNoteLimit);
  // Path is rendered with forward-slashes for readability across
  // Windows + POSIX without leaking the OS separator into the prompt.
  const path = hit.note.path.replace(/\\/g, '/');
  return `## Note: ${path}\n${body}\n`;
}

function renderUserQuestion(query: string): string {
  return `# User question\n\n${query.trim()}\n`;
}

function truncate(body: string, limit: number): string {
  if (body.length <= limit) return body;
  return body.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
