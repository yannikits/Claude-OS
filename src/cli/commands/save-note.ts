/**
 * `claude-os save-note <filename>` — write a markdown note to a
 * workspace with valid frontmatter.
 *
 * Body source (one of, in priority order):
 *   --body "<text>"       inline arg
 *   --from-file <path>    read from a file
 *   --from-stdin          read from stdin (suitable for piping)
 *
 * Frontmatter required:
 *   workspace           — derived from --workspace or active workspace
 *   classification      — --classification, defaults to "personal"
 *   schema_version      — pinned to 1
 *   tenant              — --tenant, required for msp-customers/<id>
 *
 * Frontmatter optional:
 *   type                — --type (session|skill-memory|person|project)
 *   tags                — --tags "a,b,c"
 *
 * @module @cli/commands/save-note
 */
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import {
  NOTE_CLASSIFICATIONS,
  NOTE_TYPES,
  type NoteClassification,
  type NoteFrontmatter,
  NotesError,
  type NoteType,
  writeNote,
} from '../../domains/notes/index.js';
import {
  readActiveWorkspace,
  resolveVaultRoot,
  WorkspaceError,
} from '../../domains/workspace/index.js';
import type { GlobalOpts } from '../output.js';

interface SaveNoteCmdOpts {
  readonly workspace?: string;
  readonly body?: string;
  readonly fromFile?: string;
  readonly fromStdin?: boolean;
  readonly type?: string;
  readonly tags?: string;
  readonly classification?: string;
  readonly tenant?: string;
  readonly overwrite?: boolean;
}

function printAndExit(output: string, code: number): never {
  // biome-ignore lint/suspicious/noConsole: CLI presenter output by design
  console.log(output);
  process.exit(code);
}

function printErr(line: string): void {
  console.error(line);
}

function isClassification(s: string): s is NoteClassification {
  return (NOTE_CLASSIFICATIONS as readonly string[]).includes(s);
}

function isNoteType(s: string): s is NoteType {
  return (NOTE_TYPES as readonly string[]).includes(s);
}

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveBody(opts: SaveNoteCmdOpts): Promise<string> {
  if (opts.body !== undefined) return opts.body;
  if (opts.fromFile !== undefined) {
    return readFileSync(opts.fromFile, 'utf8');
  }
  if (opts.fromStdin === true) {
    return readStdinAll();
  }
  throw new Error('save-note: pass one of --body "<text>", --from-file <path>, or --from-stdin');
}

function parseTags(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const tags = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

export function registerSaveNoteCommand(program: Command): void {
  program
    .command('save-note <filename>')
    .description('Write a markdown note with frontmatter into the active workspace')
    .option('--workspace <id>', 'Override the active workspace')
    .option('--body <text>', 'Inline note body')
    .option('--from-file <path>', 'Read body from a file')
    .option('--from-stdin', 'Read body from stdin (useful with pipes)')
    .option('--type <type>', `Frontmatter type (one of: ${NOTE_TYPES.join(' | ')})`)
    .option('--tags <csv>', 'Comma-separated tag list')
    .option(
      '--classification <c>',
      `Frontmatter classification (default: personal). Allowed: ${NOTE_CLASSIFICATIONS.join(' | ')}`,
      'personal',
    )
    .option('--tenant <id>', 'Required for msp-customers/<id> workspaces')
    .option('--overwrite', 'Allow overwriting an existing note', false)
    .action(async function (this: Command, filename: string, cmdOpts: SaveNoteCmdOpts) {
      const globalOpts = program.opts<GlobalOpts>();
      const json = globalOpts.json === true;
      try {
        const vault = resolveVaultRoot(
          globalOpts.vault === undefined ? {} : { explicit: globalOpts.vault },
        );
        const workspaceId = cmdOpts.workspace ?? readActiveWorkspace().active;

        const classification = cmdOpts.classification ?? 'personal';
        if (!isClassification(classification)) {
          throw new Error(
            `--classification "${classification}" not allowed. Use one of: ${NOTE_CLASSIFICATIONS.join(', ')}`,
          );
        }

        if (cmdOpts.type !== undefined && !isNoteType(cmdOpts.type)) {
          throw new Error(
            `--type "${cmdOpts.type}" not allowed. Use one of: ${NOTE_TYPES.join(', ')}`,
          );
        }

        const body = await resolveBody(cmdOpts);
        const fm: NoteFrontmatter = {
          workspace: workspaceId,
          classification,
          schema_version: 1,
          ...(cmdOpts.type !== undefined ? { type: cmdOpts.type as NoteType } : {}),
          ...(parseTags(cmdOpts.tags) !== undefined ? { tags: parseTags(cmdOpts.tags) } : {}),
          ...(cmdOpts.tenant !== undefined ? { tenant: cmdOpts.tenant } : {}),
        };

        const res = writeNote(vault, workspaceId, filename, fm, body, {
          overwrite: cmdOpts.overwrite === true,
        });

        const out = json
          ? JSON.stringify(
              {
                ok: true,
                path: res.path,
                created: res.created,
                workspace: workspaceId,
                classification,
              },
              null,
              2,
            )
          : `[OK] ${res.created ? 'created' : 'updated'}: ${res.path}`;
        printAndExit(out, 0);
      } catch (err) {
        if (err instanceof WorkspaceError || err instanceof NotesError) {
          printErr(`save-note: ${err.message}`);
          process.exit(1);
        }
        if (err instanceof Error) {
          printErr(`save-note: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    });
}
