/**
 * Frontmatter extractor + YAML parser.
 *
 * Mini-implementation (no gray-matter dep) — gray-matter ships with the
 * legacy js-yaml@3. We use `yaml@2` directly (zero-dep, maintained) for
 * the YAML parse and detect the `---`-block manually.
 *
 * Format:
 *
 *     ---
 *     yaml-content
 *     ---
 *     markdown body
 *
 * Opening fence must be the very first line (offset 0). Closing fence
 * is the first standalone `---` line afterwards. Missing fence → no
 * frontmatter, whole content is body.
 *
 * @module @domains/notes/parser
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { FrontmatterParseError } from './types.js';

export interface ExtractedFrontmatter {
  /** Raw YAML string between the fences. Empty when no frontmatter. */
  readonly rawFrontmatter: string;
  /** Body content after the closing fence (or full input if no fence). */
  readonly body: string;
  /** `true` when both fences were detected. */
  readonly hasFrontmatter: boolean;
}

const FENCE = '---';

/**
 * Splits raw markdown into (rawFrontmatter, body). Does not parse YAML.
 *
 * Detection is strict:
 *   - first line must equal `---` (no trailing whitespace tolerated by
 *     trim() — we accept windows line endings via the line-split)
 *   - closing fence is the next line equal to `---`
 *
 * If no opening fence is present, returns `{rawFrontmatter: '', body: input,
 * hasFrontmatter: false}` — caller treats this as "no frontmatter".
 */
export function extractFrontmatter(input: string): ExtractedFrontmatter {
  if (!input.startsWith(`${FENCE}\n`) && !input.startsWith(`${FENCE}\r\n`)) {
    return { rawFrontmatter: '', body: input, hasFrontmatter: false };
  }
  // Skip the opening fence line (handle both line-endings).
  const afterOpen = input.startsWith(`${FENCE}\r\n`)
    ? input.slice(FENCE.length + 2)
    : input.slice(FENCE.length + 1);
  const lines = afterOpen.split(/\r?\n/);
  let closingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === FENCE) {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    throw new FrontmatterParseError(
      'Frontmatter opening fence "---" found at start, but no closing "---" line. ' +
        'Fix the note or remove the opening fence.',
    );
  }
  const rawFrontmatter = lines.slice(0, closingIdx).join('\n');
  // body starts after the closing fence line. Strip exactly one
  // trailing/leading newline pair so concatenation round-trips cleanly.
  const bodyLines = lines.slice(closingIdx + 1);
  if (bodyLines.length > 0 && bodyLines[0] === '') bodyLines.shift();
  const body = bodyLines.join('\n');
  return { rawFrontmatter, body, hasFrontmatter: true };
}

/**
 * Parses the YAML segment into a plain object. Throws
 * `FrontmatterParseError` for syntax errors or for non-mapping roots
 * (e.g. a scalar or array at the top level).
 */
export function parseFrontmatter(rawFrontmatter: string): Record<string, unknown> {
  if (rawFrontmatter.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(rawFrontmatter);
  } catch (err) {
    throw new FrontmatterParseError(`Failed to parse YAML frontmatter: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterParseError(
      `Frontmatter must be a YAML mapping, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Serializes frontmatter + body back into the canonical markdown form.
 *
 *     ---
 *     yaml
 *     ---
 *     body
 *
 * yaml@2 emits 2-space indent + double-quoted strings for keys that
 * need quoting. `lineWidth: 0` disables line-folding so long strings
 * stay single-line (frontmatter readability).
 */
export function serializeNote(frontmatter: Record<string, unknown>, body: string): string {
  const yamlText = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  const bodyPart = body.length === 0 || body.endsWith('\n') ? body : `${body}\n`;
  return `${FENCE}\n${yamlText}\n${FENCE}\n${bodyPart}`;
}
