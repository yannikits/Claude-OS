/**
 * ZoneClassifier — categorises each file in a skills/plugins update
 * candidate as System | Personal | Locked per ADR-0005 §38.
 *
 *   System    File exists in upstream AND not locked.
 *             → Eligible for diff-review patching.
 *   Personal  File exists only locally (no upstream counterpart).
 *             → Never touched by an update.
 *   Locked    File exists in upstream AND is opted-out via
 *             `.skill-lock.json` OR YAML frontmatter `claudeos: locked`.
 *             → Never touched, even if upstream advanced.
 *
 * `.skill-lock.json` lives at the local root and uses the shape:
 *     {"locked": ["thinking-partner", "daily-review"]}
 * Lock entries match the first path segment of the file's relative
 * path (the "skill name"). ADR-0005 specified YAML; we choose JSON to
 * avoid pulling in a YAML parser dependency — documented deviation.
 *
 * Frontmatter detection is regex-based against the leading `---`
 * block. We only need the single `claudeos:` key, so a full YAML
 * parse is overkill.
 *
 * @module @domains/update-orchestrator/zone-classifier
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Zone = 'system' | 'personal' | 'locked';

export interface Classification {
  readonly zone: Zone;
  readonly reason: string;
}

interface ClassifierOpts {
  /** Upstream / canonical source dir (e.g. cloned skills repo). */
  readonly upstreamRoot: string;
  /** Locally-mounted skills dir (the merge target). */
  readonly localRoot: string;
  /** Optional override of the skill-lock path (default: `<localRoot>/.skill-lock.json`). */
  readonly skillLockPath?: string;
}

const FRONTMATTER_BLOCK = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/u;
const FRONTMATTER_LOCKED = /^\s*claudeos\s*:\s*("?)locked\1\s*$/im;

function readSkillLock(filePath: string): readonly string[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const locked = (parsed as { locked?: unknown }).locked;
    if (!Array.isArray(locked)) return [];
    return locked.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

function pathExistsAsFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isLockedByFrontmatter(filePath: string): boolean {
  if (!pathExistsAsFile(filePath)) return false;
  let head: string;
  try {
    const raw = readFileSync(filePath, 'utf8');
    head = raw.slice(0, 4096);
  } catch {
    return false;
  }
  const block = FRONTMATTER_BLOCK.exec(head);
  if (block === null) return false;
  const body = block[1] ?? '';
  return FRONTMATTER_LOCKED.test(body);
}

function firstPathSegment(relPath: string): string {
  const normalised = relPath.replaceAll('\\', '/');
  const idx = normalised.indexOf('/');
  return idx === -1 ? normalised : normalised.slice(0, idx);
}

export class ZoneClassifier {
  private readonly upstreamRoot: string;
  private readonly localRoot: string;
  private readonly lockedSkills: Set<string>;

  constructor(opts: ClassifierOpts) {
    this.upstreamRoot = opts.upstreamRoot;
    this.localRoot = opts.localRoot;
    const lockPath = opts.skillLockPath ?? join(opts.localRoot, '.skill-lock.json');
    this.lockedSkills = new Set(readSkillLock(lockPath));
  }

  /** Returns the list of skill names declared in `.skill-lock.json`. */
  get locked(): readonly string[] {
    return [...this.lockedSkills];
  }

  /**
   * Classifies a single file by its path relative to either root.
   * Locked detection runs first (so a locally-modified locked file
   * still classifies as `locked`, not `system`).
   */
  classify(relPath: string): Classification {
    const skill = firstPathSegment(relPath);
    const upstreamPath = join(this.upstreamRoot, relPath);
    const localPath = join(this.localRoot, relPath);
    const inUpstream = pathExistsAsFile(upstreamPath);
    const inLocal = pathExistsAsFile(localPath);

    if (this.lockedSkills.has(skill)) {
      return { zone: 'locked', reason: `skill "${skill}" listed in .skill-lock.json` };
    }
    if (inLocal && isLockedByFrontmatter(localPath)) {
      return { zone: 'locked', reason: 'frontmatter claudeos: locked' };
    }

    if (inUpstream && inLocal) {
      return { zone: 'system', reason: 'present in both upstream and local' };
    }
    if (inUpstream && !inLocal) {
      return { zone: 'system', reason: 'present in upstream, missing locally (new file)' };
    }
    if (!inUpstream && inLocal) {
      return { zone: 'personal', reason: 'present only locally (no upstream counterpart)' };
    }
    return { zone: 'personal', reason: 'absent in both upstream and local' };
  }
}
