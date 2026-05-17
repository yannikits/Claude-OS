/**
 * VaultWriter — emits per-run Markdown to the cloud-mounted vault for
 * human inspection. Per ADR-0002 the markdown lives next to the JSONL
 * data:
 *
 *   <vaultRoot>/agent-runs/<project>/<ISO-safe-timestamp>.md
 *
 * The CLI bridge uses `stdio: 'inherit'` (Phase 3b) so we never see
 * the AI session's stdout/stderr — the markdown captures metadata
 * + the user's prompt only. Future GUI mode (Phase 6) can capture
 * the full transcript and append it here.
 *
 * @module @domains/agent-runs/vault-writer
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitiseSegment } from './jsonl-writer.js';
import type { AgentRunRecord } from './types.js';

interface VaultWriterOpts {
  /** Vault working-tree path (e.g. `<root>/vault`). */
  readonly vaultRoot: string;
}

function refSafeIso(iso: string): string {
  return iso.replaceAll(':', '-').replace('.', '-');
}

function escapeYaml(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (/[:#{}[\],&*!|>'"%@`\n\r]/.test(s) || s.length === 0) {
    return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }
  return s;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export class VaultWriter {
  private readonly vaultRoot: string;

  constructor(opts: VaultWriterOpts) {
    this.vaultRoot = opts.vaultRoot;
  }

  /** Returns the markdown path a record would land at without writing. */
  pathFor(record: AgentRunRecord): string {
    return join(
      this.vaultRoot,
      'agent-runs',
      sanitiseSegment(record.project),
      `${refSafeIso(record.timestamp)}.md`,
    );
  }

  /** Writes the markdown file. Returns the absolute path. */
  write(record: AgentRunRecord): string {
    const path = this.pathFor(record);
    mkdirSync(dirname(path), { recursive: true });
    const body = this.renderMarkdown(record);
    writeFileSync(path, body, { mode: 0o644 });
    return path;
  }

  private renderMarkdown(record: AgentRunRecord): string {
    const lines: string[] = ['---'];
    lines.push(`runId: ${escapeYaml(record.runId)}`);
    lines.push(`project: ${escapeYaml(record.project)}`);
    lines.push(`machineId: ${escapeYaml(record.machineId)}`);
    lines.push(`timestamp: ${escapeYaml(record.timestamp)}`);
    lines.push(`exitCode: ${escapeYaml(record.exitCode)}`);
    lines.push(`signal: ${escapeYaml(record.signal)}`);
    lines.push(`durationMs: ${escapeYaml(record.durationMs)}`);
    lines.push(`binaryPath: ${escapeYaml(record.binaryPath)}`);
    lines.push(`binarySource: ${escapeYaml(record.binarySource)}`);
    lines.push('---');
    lines.push('');
    lines.push(`# Agent run ${record.timestamp}`);
    lines.push('');
    lines.push(`**Prompt:** ${firstLine(record.prompt)}`);
    lines.push('');
    if (record.prompt.includes('\n')) {
      lines.push('```');
      lines.push(record.prompt);
      lines.push('```');
      lines.push('');
    }
    lines.push(
      '> Note: claude-os spawns the binary with `stdio: inherit`; the live ' +
        'session is streamed to the terminal and not captured here.',
    );
    return `${lines.join('\n')}\n`;
  }
}
