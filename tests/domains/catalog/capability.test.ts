import { describe, expect, it } from 'vitest';
import {
  CapabilityParseError,
  capabilityToString,
  compareVersions,
  parseCapability,
  satisfies,
} from '../../../src/domains/catalog/index.js';

describe('parseCapability', () => {
  it('parses kind:name without constraint', () => {
    const cap = parseCapability('mcp:filesystem');
    expect(cap.kind).toBe('mcp');
    expect(cap.name).toBe('filesystem');
    expect(cap.constraint).toBeUndefined();
  });

  it('parses skill:<name>', () => {
    const cap = parseCapability('skill:pragmatic-review');
    expect(cap.kind).toBe('skill');
    expect(cap.name).toBe('pragmatic-review');
  });

  it('parses command:<plugin>:<cmd>', () => {
    const cap = parseCapability('command:git-workflow:review');
    expect(cap.kind).toBe('command');
    expect(cap.name).toBe('git-workflow:review');
  });

  it('parses kind:name>=X.Y.Z constraint', () => {
    const cap = parseCapability('mcp:github>=2.0');
    expect(cap.constraint).toEqual({ op: '>=', version: '2.0' });
  });

  it('parses other comparison operators', () => {
    expect(parseCapability('mcp:x>1.0').constraint?.op).toBe('>');
    expect(parseCapability('mcp:x<=1.0').constraint?.op).toBe('<=');
    expect(parseCapability('mcp:x<1.0').constraint?.op).toBe('<');
    expect(parseCapability('mcp:x=1.0').constraint?.op).toBe('=');
  });

  it('rejects empty input', () => {
    expect(() => parseCapability('')).toThrow(CapabilityParseError);
    expect(() => parseCapability('   ')).toThrow(CapabilityParseError);
  });

  it('rejects missing colon', () => {
    expect(() => parseCapability('mcp')).toThrow(CapabilityParseError);
  });

  it('rejects unknown kind', () => {
    expect(() => parseCapability('npm:foo')).toThrow(CapabilityParseError);
  });

  it('rejects empty name', () => {
    expect(() => parseCapability('mcp:')).toThrow(CapabilityParseError);
  });

  it('rejects invalid version', () => {
    expect(() => parseCapability('mcp:x>=abc')).toThrow(CapabilityParseError);
  });

  it('rejects operator without version', () => {
    expect(() => parseCapability('mcp:x>=')).toThrow(CapabilityParseError);
  });
});

describe('compareVersions', () => {
  it('compares numeric triples lexicographically', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('satisfies', () => {
  it('matches >= correctly', () => {
    const c = { op: '>=' as const, version: '2.0' };
    expect(satisfies('2.0', c)).toBe(true);
    expect(satisfies('2.0.1', c)).toBe(true);
    expect(satisfies('3.0', c)).toBe(true);
    expect(satisfies('1.9.9', c)).toBe(false);
  });

  it('matches > correctly', () => {
    const c = { op: '>' as const, version: '2.0' };
    expect(satisfies('2.0', c)).toBe(false);
    expect(satisfies('2.0.1', c)).toBe(true);
  });

  it('matches <= correctly', () => {
    const c = { op: '<=' as const, version: '2.0' };
    expect(satisfies('2.0', c)).toBe(true);
    expect(satisfies('1.9', c)).toBe(true);
    expect(satisfies('2.1', c)).toBe(false);
  });

  it('matches = correctly', () => {
    const c = { op: '=' as const, version: '2.0' };
    expect(satisfies('2.0', c)).toBe(true);
    expect(satisfies('2.0.0', c)).toBe(true);
    expect(satisfies('2.0.1', c)).toBe(false);
  });
});

describe('capabilityToString', () => {
  it('round-trips a constrained capability', () => {
    const cap = parseCapability('mcp:filesystem>=1.0');
    expect(capabilityToString(cap)).toBe('mcp:filesystem>=1.0');
  });

  it('round-trips a bare capability', () => {
    const cap = parseCapability('skill:pragmatic-review');
    expect(capabilityToString(cap)).toBe('skill:pragmatic-review');
  });

  it('round-trips ^ and ~ constraints', () => {
    expect(capabilityToString(parseCapability('mcp:x^1.2.3'))).toBe('mcp:x^1.2.3');
    expect(capabilityToString(parseCapability('mcp:x~1.2.3'))).toBe('mcp:x~1.2.3');
  });
});

describe('parseCapability with ^ / ~ operators', () => {
  it('parses caret', () => {
    const cap = parseCapability('mcp:filesystem^1.2.3');
    expect(cap.constraint).toEqual({ op: '^', version: '1.2.3' });
  });

  it('parses tilde', () => {
    const cap = parseCapability('skill:x~0.5.0');
    expect(cap.constraint).toEqual({ op: '~', version: '0.5.0' });
  });

  it('rejects ^ with malformed version', () => {
    expect(() => parseCapability('mcp:x^1.a.0')).toThrow(CapabilityParseError);
  });
});

describe('satisfies ^ (caret, npm semver left-most-non-zero rule)', () => {
  it('^1.2.3 matches >=1.2.3 within major 1', () => {
    const c = { op: '^' as const, version: '1.2.3' };
    expect(satisfies('1.2.3', c)).toBe(true);
    expect(satisfies('1.2.99', c)).toBe(true);
    expect(satisfies('1.99.0', c)).toBe(true);
  });

  it('^1.2.3 rejects pre-version + cross-major', () => {
    const c = { op: '^' as const, version: '1.2.3' };
    expect(satisfies('1.2.2', c)).toBe(false);
    expect(satisfies('1.0.0', c)).toBe(false);
    expect(satisfies('2.0.0', c)).toBe(false);
    expect(satisfies('0.9.9', c)).toBe(false);
  });

  it('^0.2.3 stays within minor 0.2 (major-zero rule)', () => {
    const c = { op: '^' as const, version: '0.2.3' };
    expect(satisfies('0.2.3', c)).toBe(true);
    expect(satisfies('0.2.99', c)).toBe(true);
    expect(satisfies('0.3.0', c)).toBe(false);
    expect(satisfies('1.0.0', c)).toBe(false);
    expect(satisfies('0.2.2', c)).toBe(false);
  });

  it('^0.0.3 pins exactly to the patch (major+minor both zero)', () => {
    const c = { op: '^' as const, version: '0.0.3' };
    expect(satisfies('0.0.3', c)).toBe(true);
    expect(satisfies('0.0.4', c)).toBe(false);
    expect(satisfies('0.0.2', c)).toBe(false);
    expect(satisfies('0.1.0', c)).toBe(false);
  });

  it('^ rejects non-version candidate strings', () => {
    const c = { op: '^' as const, version: '1.2.3' };
    expect(satisfies('not-a-version', c)).toBe(false);
    expect(satisfies('1.2.3-beta', c)).toBe(false);
  });
});

describe('satisfies ~ (tilde, major+minor pin)', () => {
  it('~1.2.3 matches patch bumps inside 1.2.x', () => {
    const c = { op: '~' as const, version: '1.2.3' };
    expect(satisfies('1.2.3', c)).toBe(true);
    expect(satisfies('1.2.99', c)).toBe(true);
  });

  it('~1.2.3 rejects minor bumps and pre-version', () => {
    const c = { op: '~' as const, version: '1.2.3' };
    expect(satisfies('1.3.0', c)).toBe(false);
    expect(satisfies('1.2.2', c)).toBe(false);
    expect(satisfies('2.2.3', c)).toBe(false);
  });

  it('~1.2 (no patch) accepts any 1.2.x', () => {
    const c = { op: '~' as const, version: '1.2' };
    expect(satisfies('1.2.0', c)).toBe(true);
    expect(satisfies('1.2.99', c)).toBe(true);
    expect(satisfies('1.3.0', c)).toBe(false);
  });

  it('~1 (just major) pins to 1.0.x per v1 simplification', () => {
    const c = { op: '~' as const, version: '1' };
    expect(satisfies('1.0.0', c)).toBe(true);
    expect(satisfies('1.0.99', c)).toBe(true);
    expect(satisfies('1.1.0', c)).toBe(false);
    expect(satisfies('2.0.0', c)).toBe(false);
  });
});
