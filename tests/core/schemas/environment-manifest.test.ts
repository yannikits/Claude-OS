import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  type EnvironmentManifest,
  EnvironmentManifestJsonSchema,
  EnvironmentManifestSchema,
} from '../../../src/core/schemas/index.js';
import { assertValid, formatErrors, ValidationError } from '../../../src/core/validation/index.js';

const validMinimal: EnvironmentManifest = {
  version: 1,
  createdAt: '2026-05-17T07:55:00Z',
};

const validFull: EnvironmentManifest = {
  version: 1,
  createdAt: '2026-05-17T09:55:00.123+02:00',
  name: 'yannik-laptop',
  cloudProvider: 'onedrive',
  notes: 'Primary dev machine; Surface Pro 9.',
};

describe('EnvironmentManifestSchema (valid inputs)', () => {
  it('accepts the minimal payload (version + createdAt only)', () => {
    expect(Value.Check(EnvironmentManifestSchema, validMinimal)).toBe(true);
    expect(formatErrors(EnvironmentManifestSchema, validMinimal)).toEqual([]);
  });

  it('accepts the full payload with all optional fields', () => {
    expect(Value.Check(EnvironmentManifestSchema, validFull)).toBe(true);
  });

  it('accepts ISO-8601 timestamps with millisecond precision and timezone offset', () => {
    const withMs = { ...validMinimal, createdAt: '2026-05-17T09:55:00.999-05:00' };
    expect(Value.Check(EnvironmentManifestSchema, withMs)).toBe(true);
  });

  it('accepts all enumerated cloudProvider values', () => {
    for (const provider of [
      'onedrive',
      'gdrive',
      'dropbox',
      'rclone',
      'icloud',
      'local',
      'unknown',
    ] as const) {
      expect(
        Value.Check(EnvironmentManifestSchema, { ...validMinimal, cloudProvider: provider }),
      ).toBe(true);
    }
  });
});

describe('EnvironmentManifestSchema (invalid inputs)', () => {
  it('rejects missing version', () => {
    const { version: _v, ...rest } = validMinimal;
    expect(Value.Check(EnvironmentManifestSchema, rest)).toBe(false);
  });

  it('rejects version literal other than 1', () => {
    expect(Value.Check(EnvironmentManifestSchema, { ...validMinimal, version: 2 })).toBe(false);
  });

  it('rejects missing createdAt', () => {
    const { createdAt: _c, ...rest } = validMinimal;
    expect(Value.Check(EnvironmentManifestSchema, { version: 1, ...rest })).toBe(false);
  });

  it('rejects malformed createdAt (no T separator)', () => {
    expect(
      Value.Check(EnvironmentManifestSchema, {
        ...validMinimal,
        createdAt: '2026-05-17 07:55:00Z',
      }),
    ).toBe(false);
  });

  it('rejects createdAt without timezone designator', () => {
    expect(
      Value.Check(EnvironmentManifestSchema, { ...validMinimal, createdAt: '2026-05-17T07:55:00' }),
    ).toBe(false);
  });

  it('rejects unknown cloudProvider', () => {
    expect(
      Value.Check(EnvironmentManifestSchema, { ...validMinimal, cloudProvider: 'azure-blob' }),
    ).toBe(false);
  });

  it('rejects additional properties (strict mode)', () => {
    expect(Value.Check(EnvironmentManifestSchema, { ...validMinimal, machineId: 'abc-123' })).toBe(
      false,
    );
  });

  it('rejects empty name (minLength 1)', () => {
    expect(Value.Check(EnvironmentManifestSchema, { ...validMinimal, name: '' })).toBe(false);
  });

  it('rejects name exceeding 256 chars', () => {
    expect(Value.Check(EnvironmentManifestSchema, { ...validMinimal, name: 'x'.repeat(257) })).toBe(
      false,
    );
  });

  it('rejects notes exceeding 4096 chars', () => {
    expect(
      Value.Check(EnvironmentManifestSchema, { ...validMinimal, notes: 'x'.repeat(4097) }),
    ).toBe(false);
  });
});

describe('assertValid integration', () => {
  it('does not throw on valid payload', () => {
    expect(() =>
      assertValid(EnvironmentManifestSchema, validFull, '.claude-os-root'),
    ).not.toThrow();
  });

  it('throws ValidationError with human-readable path on invalid payload', () => {
    try {
      assertValid(EnvironmentManifestSchema, { version: 2, createdAt: 'nope' }, '.claude-os-root');
      throw new Error('expected ValidationError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.message).toContain('.claude-os-root');
      expect(ve.errors.some((m) => m.startsWith('version:'))).toBe(true);
      expect(ve.errors.some((m) => m.startsWith('createdAt:'))).toBe(true);
    }
  });
});

describe('EnvironmentManifestJsonSchema (Type.Strict export)', () => {
  it('strips TypeBox Symbol-keyed metadata for spec-compliant output', () => {
    const symbols = Object.getOwnPropertySymbols(EnvironmentManifestJsonSchema);
    expect(symbols).toEqual([]);
  });

  it('preserves JSON-Schema required + properties + additionalProperties shape', () => {
    const schema = EnvironmentManifestJsonSchema as {
      type: string;
      required: readonly string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(expect.arrayContaining(['version', 'createdAt']));
    expect(schema.required).not.toContain('name');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['version', 'createdAt', 'name', 'cloudProvider', 'notes']),
    );
  });

  it('round-trips through JSON.stringify cleanly', () => {
    const serialised = JSON.stringify(EnvironmentManifestJsonSchema);
    const parsed = JSON.parse(serialised);
    expect(parsed.type).toBe('object');
    expect(parsed.properties.version.const).toBe(1);
  });
});
