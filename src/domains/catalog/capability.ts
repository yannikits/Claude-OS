/**
 * Capability parser + version comparator for the catalog resolver
 * (Phase 5g, ADR-0010 §47).
 *
 * Format: `<kind>:<name>[<op><version>]`
 *   kind:    mcp | skill | command | agent | hook
 *   name:    [A-Za-z0-9._:-]+ (colon allowed for `command:<plugin>:<cmd>`)
 *   op:      `>=` | `>` | `<=` | `<` | `=` | `^` | `~` or omitted
 *            (any version matches)
 *   version: X.Y[.Z] dotted integer triple.
 *
 *   `^X.Y.Z` (caret) matches the left-most-non-zero npm semver rule:
 *     ^1.2.3 -> >=1.2.3 <2.0.0
 *     ^0.2.3 -> >=0.2.3 <0.3.0
 *     ^0.0.3 -> ==0.0.3
 *   `~X.Y.Z` (tilde) pins major+minor and allows patch bumps:
 *     ~1.2.3 -> >=1.2.3 <1.3.0
 *     ~1.2   -> >=1.2.0 <1.3.0
 *     ~1     -> ==1.0.0  (v1 simplification — for "any 1.x.x" use ^1)
 *
 * @module @domains/catalog/capability
 */

export type CapabilityKind = 'mcp' | 'skill' | 'command' | 'agent' | 'hook';

export type ComparisonOp = '>=' | '>' | '<=' | '<' | '=' | '^' | '~';

export interface VersionConstraint {
  readonly op: ComparisonOp;
  readonly version: string;
}

export interface Capability {
  readonly raw: string;
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly constraint?: VersionConstraint;
}

export class CapabilityParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityParseError';
  }
}

const KINDS: ReadonlyArray<CapabilityKind> = ['mcp', 'skill', 'command', 'agent', 'hook'];
const NAME_PATTERN = /^[A-Za-z0-9._:-]+$/;
const OPS: ReadonlyArray<ComparisonOp> = ['>=', '<=', '=', '>', '<', '^', '~'];
const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/;

function splitOnFirstOp(body: string): { name: string; constraint?: VersionConstraint } {
  for (const op of OPS) {
    const idx = body.indexOf(op);
    if (idx >= 0) {
      const name = body.slice(0, idx);
      const version = body.slice(idx + op.length);
      if (version.length === 0) {
        throw new CapabilityParseError(`capability "${body}" has operator "${op}" but no version`);
      }
      if (!VERSION_PATTERN.test(version)) {
        throw new CapabilityParseError(
          `capability "${body}" version "${version}" must match \\d+(.\\d+){0,2}`,
        );
      }
      return { name, constraint: { op, version } };
    }
  }
  return { name: body };
}

export function parseCapability(input: string): Capability {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new CapabilityParseError('capability is empty');
  const colon = trimmed.indexOf(':');
  if (colon <= 0) {
    throw new CapabilityParseError(
      `capability "${trimmed}" must start with "<kind>:" where kind is one of ${KINDS.join('|')}`,
    );
  }
  const kindToken = trimmed.slice(0, colon);
  if (!(KINDS as readonly string[]).includes(kindToken)) {
    throw new CapabilityParseError(
      `capability "${trimmed}" unknown kind "${kindToken}"; expected ${KINDS.join('|')}`,
    );
  }
  const body = trimmed.slice(colon + 1);
  const { name, constraint } = splitOnFirstOp(body);
  if (name.length === 0) {
    throw new CapabilityParseError(`capability "${trimmed}" has empty name`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new CapabilityParseError(
      `capability "${trimmed}" name "${name}" must match [A-Za-z0-9._:-]+`,
    );
  }
  return {
    raw: trimmed,
    kind: kindToken as CapabilityKind,
    name,
    ...(constraint === undefined ? {} : { constraint }),
  };
}

function parseVersionTriple(v: string): [number, number, number] {
  const parts = v.split('.').map((p) => Number.parseInt(p, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Returns -1 / 0 / 1 like `Array.sort` callbacks. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [a0, a1, a2] = parseVersionTriple(a);
  const [b0, b1, b2] = parseVersionTriple(b);
  if (a0 !== b0) return a0 < b0 ? -1 : 1;
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  return 0;
}

/** True when `candidate` satisfies `constraint`. */
export function satisfies(candidate: string, constraint: VersionConstraint): boolean {
  if (!VERSION_PATTERN.test(candidate)) return false;
  const cmp = compareVersions(candidate, constraint.version);
  switch (constraint.op) {
    case '=':
      return cmp === 0;
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '<':
      return cmp < 0;
    case '^': {
      if (cmp < 0) return false;
      const [cMaj, cMin, cPat] = parseVersionTriple(candidate);
      const [bMaj, bMin, bPat] = parseVersionTriple(constraint.version);
      // Left-most-non-zero rule per npm semver.
      if (bMaj > 0) return cMaj === bMaj;
      if (bMin > 0) return cMaj === 0 && cMin === bMin;
      return cMaj === 0 && cMin === 0 && cPat === bPat;
    }
    case '~': {
      if (cmp < 0) return false;
      const [cMaj, cMin] = parseVersionTriple(candidate);
      const [bMaj, bMin] = parseVersionTriple(constraint.version);
      return cMaj === bMaj && cMin === bMin;
    }
  }
}

/** Renders a capability back to its canonical string form. */
export function capabilityToString(cap: Capability): string {
  if (cap.constraint === undefined) return `${cap.kind}:${cap.name}`;
  return `${cap.kind}:${cap.name}${cap.constraint.op}${cap.constraint.version}`;
}
