/**
 * Doctor domain types.
 *
 * @module @core/doctor/types
 */

export type CheckSeverity = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  readonly name: string;
  readonly severity: CheckSeverity;
  readonly message: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly durationMs: number;
}

export interface DoctorReport {
  readonly checks: readonly CheckResult[];
  readonly summary: {
    readonly ok: number;
    readonly warn: number;
    readonly fail: number;
    readonly totalDurationMs: number;
  };
  readonly overall: CheckSeverity;
}

export type CheckFn = () => Promise<Omit<CheckResult, 'durationMs'>>;
