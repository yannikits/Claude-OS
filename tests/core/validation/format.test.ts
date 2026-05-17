import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import {
  assertValid,
  formatErrors,
  formatPath,
  ValidationError,
} from '../../../src/core/validation/index.js';

describe('formatPath', () => {
  it('returns <root> for empty path', () => {
    expect(formatPath('')).toBe('<root>');
  });

  it('handles single top-level segment', () => {
    expect(formatPath('/name')).toBe('name');
  });

  it('handles nested object path', () => {
    expect(formatPath('/user/email')).toBe('user.email');
  });

  it('handles array index as bracket notation', () => {
    expect(formatPath('/entries/2')).toBe('entries[2]');
  });

  it('handles deep nested with arrays', () => {
    expect(formatPath('/entries/2/source')).toBe('entries[2].source');
    expect(formatPath('/a/0/b/1/c')).toBe('a[0].b[1].c');
  });

  it('preserves hyphenated names', () => {
    expect(formatPath('/agent-runs/foo-bar')).toBe('agent-runs.foo-bar');
  });
});

const UserSchema = Type.Object({
  id: Type.String(),
  age: Type.Integer({ minimum: 0, maximum: 150 }),
  email: Type.String({ minLength: 3 }),
});

describe('formatErrors', () => {
  it('returns [] for valid input', () => {
    expect(formatErrors(UserSchema, { id: 'u1', age: 30, email: 'a@b.com' })).toEqual([]);
  });

  it('reports missing required field', () => {
    const result = formatErrors(UserSchema, { id: 'u1', age: 30 });
    expect(result.length).toBeGreaterThan(0);
    expect(result.join('\n')).toContain('email');
  });

  it('reports wrong type', () => {
    const result = formatErrors(UserSchema, {
      id: 'u1',
      age: 'thirty',
      email: 'a@b.com',
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.join('\n')).toContain('age');
  });

  it('reports constraint violation (minimum)', () => {
    const result = formatErrors(UserSchema, {
      id: 'u1',
      age: -5,
      email: 'a@b.com',
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.join('\n')).toContain('age');
  });

  it('reports top-level errors with <root> path', () => {
    const result = formatErrors(UserSchema, 'not an object');
    expect(result.length).toBe(1);
    expect(result[0]).toMatch(/^<root>:/);
  });

  it('reports array index errors with bracket notation', () => {
    const Schema = Type.Object({
      tags: Type.Array(Type.String()),
    });
    const result = formatErrors(Schema, { tags: ['ok', 42, 'also-ok'] });
    expect(result.length).toBeGreaterThan(0);
    expect(result.join('\n')).toMatch(/tags\[1\]/);
  });
});

describe('assertValid', () => {
  it('does not throw for valid input', () => {
    expect(() => {
      assertValid(UserSchema, { id: 'u1', age: 30, email: 'a@b.com' });
    }).not.toThrow();
  });

  it('throws ValidationError for invalid input', () => {
    expect(() => {
      assertValid(UserSchema, { id: 'u1', age: -5 }, 'user payload');
    }).toThrow(ValidationError);
  });

  it('error message includes context and all error lines', () => {
    try {
      assertValid(UserSchema, { age: 'thirty' }, 'user payload');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.message).toContain('user payload');
      expect(ve.errors.length).toBeGreaterThan(0);
    }
  });

  it('exposes errors[] on the thrown ValidationError', () => {
    try {
      assertValid(UserSchema, { id: 'u1' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).errors.length).toBeGreaterThan(0);
    }
  });
});
