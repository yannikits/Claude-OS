import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  classifyThrown,
} from '../../../../src/domains/msp-bridges/securepoint/classify-error.js';

describe('classifyHttpStatus', () => {
  it('401/403 → auth-failed with API-key-invalid message', () => {
    const r = classifyHttpStatus(401, null);
    expect(r.kind).toBe('auth-failed');
    if (r.kind === 'auth-failed') expect(r.message).toContain('API-Key');
  });
  it('429 with Retry-After → rate-limited', () => {
    const r = classifyHttpStatus(429, '120');
    if (r.kind === 'rate-limited') expect(r.retryAfterSec).toBe(120);
  });
  it('404 → misconfigured with api-version hint', () => {
    const r = classifyHttpStatus(404, null);
    expect(r.kind).toBe('misconfigured');
    if (r.kind === 'misconfigured')
      expect(r.message).toContain('CLAUDE_OS_SECUREPOINT_API_VERSION');
  });
  it('5xx → unreachable', () => {
    expect(classifyHttpStatus(503, null).kind).toBe('unreachable');
  });
  it('400 → error (catch-all)', () => {
    expect(classifyHttpStatus(400, null).kind).toBe('error');
  });
});

describe('classifyThrown', () => {
  it('AbortError → unreachable (timeout)', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(classifyThrown(e).kind).toBe('unreachable');
  });
  it('ECONNREFUSED → unreachable', () => {
    expect(classifyThrown(Object.assign(new Error(''), { code: 'ECONNREFUSED' })).kind).toBe(
      'unreachable',
    );
  });
  it('TypeError("fetch failed") with .cause.code → unreachable', () => {
    const e = Object.assign(new Error('fetch failed'), {
      name: 'TypeError',
      cause: { code: 'ECONNREFUSED' },
    });
    expect(classifyThrown(e).kind).toBe('unreachable');
  });
  it('arbitrary Error → error', () => {
    expect(classifyThrown(new Error('weird')).kind).toBe('error');
  });
});
