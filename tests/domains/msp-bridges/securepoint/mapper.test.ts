import { describe, expect, it } from 'vitest';
import {
  isDeviceMissing,
  mapSecurepoint,
} from '../../../../src/domains/msp-bridges/securepoint/mapper.js';
import { parsePrometheus } from '../../../../src/domains/msp-bridges/securepoint/prom-parser.js';

const FULL = parsePrometheus(
  [
    'utm_usc_online_status{utm="A"} 1',
    'utm_usc_online_status{utm="B"} 0',
    'utm_license_days_valid{utm="A"} 200',
    'utm_license_days_valid{utm="B"} 5',
    'utm_license_days_valid{utm="C"} -3',
    'utm_other_metric{utm="A"} 42',
    'utm_yet_another{utm="A"} 7',
  ].join('\n'),
);

describe('mapSecurepoint — license buckets', () => {
  it('valid when daysRemaining > 30', () => {
    expect(mapSecurepoint(FULL, 'A').licenseStatus).toBe('valid');
  });
  it('expiring-soon when 0 < daysRemaining ≤ 30', () => {
    expect(mapSecurepoint(FULL, 'B').licenseStatus).toBe('expiring-soon');
  });
  it('expired when daysRemaining ≤ 0', () => {
    expect(mapSecurepoint(FULL, 'C').licenseStatus).toBe('expired');
  });
  it('unknown when license metric missing entirely', () => {
    const m = parsePrometheus('utm_usc_online_status{utm="A"} 1');
    expect(mapSecurepoint(m, 'A').licenseStatus).toBe('unknown');
  });
});

describe('mapSecurepoint — online flag', () => {
  it('online=true when utm_usc_online_status==1', () => {
    expect(mapSecurepoint(FULL, 'A').online).toBe(true);
  });
  it('online=false when ==0', () => {
    expect(mapSecurepoint(FULL, 'B').online).toBe(false);
  });
  it('online=false when metric missing', () => {
    const m = parsePrometheus('utm_license_days_valid{utm="C"} 100');
    expect(mapSecurepoint(m, 'C').online).toBe(false);
  });
});

describe('mapSecurepoint — additionalMetrics', () => {
  it('collects other utm_* metrics matching the device', () => {
    const s = mapSecurepoint(FULL, 'A');
    const names = s.additionalMetrics.map((m) => m.name).sort();
    expect(names).toEqual(['utm_other_metric', 'utm_yet_another']);
  });
  it('does NOT include online_status or license metrics in additionalMetrics', () => {
    const s = mapSecurepoint(FULL, 'A');
    const names = s.additionalMetrics.map((m) => m.name);
    expect(names).not.toContain('utm_usc_online_status');
    expect(names).not.toContain('utm_license_days_valid');
  });
  it('clips to 20 entries', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i += 1) lines.push(`utm_x_${i}{utm="A"} ${i}`);
    const s = mapSecurepoint(parsePrometheus(lines.join('\n')), 'A');
    expect(s.additionalMetrics.length).toBeLessThanOrEqual(20);
  });
  it('skips non-utm metrics (cardinality safety)', () => {
    const m = parsePrometheus('foo_bar{utm="A"} 1\nutm_real{utm="A"} 2');
    const s = mapSecurepoint(m, 'A');
    expect(s.additionalMetrics.map((x) => x.name)).toEqual(['utm_real']);
  });
});

describe('isDeviceMissing', () => {
  it('false when device appears in any utm_* metric', () => {
    expect(isDeviceMissing(FULL, 'A')).toBe(false);
  });
  it('true when device not present anywhere', () => {
    expect(isDeviceMissing(FULL, 'NOPE')).toBe(true);
  });
});
