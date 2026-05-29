import { describe, expect, it } from 'vitest';
import {
  deviceAppearsInMetrics,
  findSamplesForDevice,
  parsePrometheus,
} from '../../../../src/domains/msp-bridges/securepoint/prom-parser.js';

describe('parsePrometheus', () => {
  it('parses a labeled metric', () => {
    const m = parsePrometheus('utm_usc_online_status{utm="UTM-A",mandant="m1"} 1');
    const samples = m.get('utm_usc_online_status');
    expect(samples).toHaveLength(1);
    expect(samples?.[0]?.labels).toEqual({ utm: 'UTM-A', mandant: 'm1' });
    expect(samples?.[0]?.value).toBe(1);
  });

  it('parses an unlabeled metric', () => {
    const m = parsePrometheus('utm_usc_online_total 7');
    expect(m.get('utm_usc_online_total')?.[0]?.value).toBe(7);
    expect(m.get('utm_usc_online_total')?.[0]?.labels).toEqual({});
  });

  it('parses multiple lines into the same metric (group by name)', () => {
    const txt = [
      'utm_usc_online_status{utm="A"} 1',
      'utm_usc_online_status{utm="B"} 0',
      'utm_usc_online_status{utm="C"} 1',
    ].join('\n');
    expect(parsePrometheus(txt).get('utm_usc_online_status')).toHaveLength(3);
  });

  it('parses float values + scientific notation', () => {
    const m = parsePrometheus('m1 3.14\nm2 1.5e3\nm3 -7.5');
    expect(m.get('m1')?.[0]?.value).toBeCloseTo(3.14);
    expect(m.get('m2')?.[0]?.value).toBe(1500);
    expect(m.get('m3')?.[0]?.value).toBe(-7.5);
  });

  it('ignores comments (# HELP / # TYPE) and blank lines', () => {
    const txt = [
      '# HELP utm_usc_online_status help-text',
      '# TYPE utm_usc_online_status gauge',
      '',
      'utm_usc_online_status{utm="A"} 1',
    ].join('\n');
    expect(parsePrometheus(txt).get('utm_usc_online_status')).toHaveLength(1);
  });

  it('handles escaped quotes and backslashes inside label values', () => {
    const m = parsePrometheus('m{k="a\\"b\\\\c"} 1');
    expect(m.get('m')?.[0]?.labels).toEqual({ k: 'a"b\\c' });
  });

  it('drops malformed lines silently (defensive)', () => {
    const m = parsePrometheus('not a valid metric\nm 5');
    expect(m.get('m')?.[0]?.value).toBe(5);
    expect(m.size).toBe(1);
  });

  it('rejects NaN values (returns null sample)', () => {
    const m = parsePrometheus('m NaN');
    expect(m.has('m')).toBe(false);
  });

  it('accepts +Inf / -Inf (Number.isFinite will discard upstream)', () => {
    const m = parsePrometheus('m1 +Inf\nm2 -Inf');
    expect(m.get('m1')?.[0]?.value).toBe(Number.POSITIVE_INFINITY);
    expect(m.get('m2')?.[0]?.value).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('findSamplesForDevice', () => {
  const m = parsePrometheus(
    [
      'utm_usc_online_status{utm="A",mandant="m1"} 1',
      'utm_usc_online_status{utm="B",mandant="m2"} 0',
      'utm_usc_online_status{device="C"} 1',
    ].join('\n'),
  );

  it('matches by `utm` label', () => {
    expect(findSamplesForDevice(m, 'utm_usc_online_status', 'A')[0]?.value).toBe(1);
  });
  it('matches by `device` label (alt label key)', () => {
    expect(findSamplesForDevice(m, 'utm_usc_online_status', 'C')[0]?.value).toBe(1);
  });
  it('returns [] when no match', () => {
    expect(findSamplesForDevice(m, 'utm_usc_online_status', 'Z')).toEqual([]);
  });
  it('returns [] when the metric is absent entirely', () => {
    expect(findSamplesForDevice(m, 'missing_metric', 'A')).toEqual([]);
  });
});

describe('deviceAppearsInMetrics', () => {
  const m = parsePrometheus(
    [
      'utm_usc_online_status{utm="A"} 1',
      'utm_license_days_valid{utm="A"} 200',
      'utm_other{device="B"} 1',
    ].join('\n'),
  );
  it('true when device is in any metric', () => {
    expect(deviceAppearsInMetrics(m, 'A')).toBe(true);
    expect(deviceAppearsInMetrics(m, 'B')).toBe(true);
  });
  it('false when device not anywhere', () => {
    expect(deviceAppearsInMetrics(m, 'Z')).toBe(false);
  });
});
