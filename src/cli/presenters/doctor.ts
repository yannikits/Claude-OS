/**
 * Doctor-report presenters: text for humans, JSON for tooling.
 *
 * Uses ASCII markers (`[OK]` / `[WARN]` / `[FAIL]`) rather than Unicode
 * symbols, to avoid render issues in Windows cmd.exe and similar
 * terminals that don't reliably handle non-ASCII output.
 *
 * @module @cli/presenters/doctor
 */
import type { DoctorReport, CheckSeverity } from '../../core/doctor/index.js';

const MARKER: Record<CheckSeverity, string> = {
  ok: '[OK]  ',
  warn: '[WARN]',
  fail: '[FAIL]',
};

export function formatDoctorReportText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('claude-os doctor');
  lines.push('================');
  lines.push('');
  for (const check of report.checks) {
    lines.push(`${MARKER[check.severity]} ${check.name}: ${check.message}`);
    if (check.detail !== undefined) lines.push(`        ${check.detail}`);
    if (check.hint !== undefined) lines.push(`        Hint: ${check.hint}`);
    lines.push(`        (${check.durationMs}ms)`);
  }
  lines.push('');
  const { ok, warn, fail, totalDurationMs } = report.summary;
  lines.push(`Summary: ${ok} ok, ${warn} warn, ${fail} fail (${totalDurationMs}ms total)`);
  lines.push(`Overall: ${MARKER[report.overall]} ${report.overall.toUpperCase()}`);
  return lines.join('\n');
}

export function formatDoctorReportJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
