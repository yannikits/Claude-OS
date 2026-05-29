/**
 * Minimal Prometheus text-format parser.
 *
 * Covers what Securepoint actually emits — full spec compliance is NOT
 * a goal (we don't need histograms, summary buckets, exemplars). What
 * we DO support:
 *   - lines `metric_name{label="value",other="x"} 42`
 *   - lines `metric_name 42` (no labels)
 *   - comments `# HELP …`, `# TYPE …`
 *   - quoted labels with `\\`, `\"`, `\n` escapes
 *   - integer + float values (NaN, +Inf, -Inf accepted but mapped to null upstream)
 *
 * We are TOLERANT of malformed lines — we skip them rather than throw.
 * That keeps the parser robust against Securepoint version drift.
 *
 * @module @domains/msp-bridges/securepoint/prom-parser
 */
import type { MetricsSample, PrometheusMap } from './types.js';

const LINE_REGEX =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([-+]?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|Inf|NaN))(?:\s|$)/;

/** Parse a single labels payload — content between `{` and `}`. */
function parseLabels(raw: string): Readonly<Record<string, string>> | null {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && (raw[i] === ',' || raw[i] === ' ')) i += 1;
    if (i >= raw.length) break;
    // key — `[a-zA-Z_][a-zA-Z0-9_]*`
    let keyEnd = i;
    while (
      keyEnd < raw.length &&
      raw[keyEnd] !== '=' &&
      raw[keyEnd] !== ',' &&
      raw[keyEnd] !== ' '
    ) {
      keyEnd += 1;
    }
    const key = raw.slice(i, keyEnd);
    if (key.length === 0) return null;
    i = keyEnd;
    if (raw[i] !== '=') return null;
    i += 1;
    if (raw[i] !== '"') return null;
    i += 1;
    let value = '';
    while (i < raw.length && raw[i] !== '"') {
      if (raw[i] === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        value += next === 'n' ? '\n' : next === '\\' ? '\\' : next === '"' ? '"' : (next ?? '');
        i += 2;
      } else {
        value += raw[i];
        i += 1;
      }
    }
    if (raw[i] !== '"') return null;
    i += 1;
    out[key] = value;
  }
  return out;
}

function toNumber(s: string): number | null {
  if (s === 'NaN') return null;
  if (s === '+Inf' || s === 'Inf') return Number.POSITIVE_INFINITY;
  if (s === '-Inf') return Number.NEGATIVE_INFINITY;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parsePrometheus(text: string): PrometheusMap {
  const out = new Map<string, MetricsSample[]>();
  for (const lineRaw of text.split('\n')) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    const m = LINE_REGEX.exec(line);
    if (m === null) continue;
    const name = m[1];
    const labelsRaw = m[3] ?? '';
    const valueRaw = m[4];
    if (name === undefined || valueRaw === undefined) continue;
    const labels = labelsRaw.length > 0 ? parseLabels(labelsRaw) : {};
    if (labels === null) continue;
    const value = toNumber(valueRaw);
    if (value === null) continue;
    const arr = out.get(name);
    if (arr === undefined) out.set(name, [{ labels, value }]);
    else arr.push({ labels, value });
  }
  return out;
}

/**
 * Find ALL samples of a metric whose labels match a given device-id.
 * The label-name is forgiving — we accept several common keys:
 * `utm`, `device`, `name`, `serial`, `mandant`.
 */
const DEVICE_LABEL_KEYS = ['utm', 'device', 'name', 'serial'];

export function findSamplesForDevice(
  metrics: PrometheusMap,
  metricName: string,
  deviceId: string,
): readonly MetricsSample[] {
  const samples = metrics.get(metricName);
  if (samples === undefined) return [];
  return samples.filter((s) => {
    for (const k of DEVICE_LABEL_KEYS) {
      const v = s.labels[k];
      if (v !== undefined && v === deviceId) return true;
    }
    return false;
  });
}

/** Returns true iff ANY metric in the map references the given deviceId. */
export function deviceAppearsInMetrics(metrics: PrometheusMap, deviceId: string): boolean {
  for (const samples of metrics.values()) {
    for (const s of samples) {
      for (const k of DEVICE_LABEL_KEYS) {
        if (s.labels[k] === deviceId) return true;
      }
    }
  }
  return false;
}
