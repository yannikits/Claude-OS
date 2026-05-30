/**
 * Pure mappers for NinjaOne probe responses.
 *
 * @module @domains/msp-bridges/ninja/mapper
 */
import type { NinjaDeviceRaw } from './types.js';

export function mapNinjaDevices(devices: readonly NinjaDeviceRaw[]): {
  deviceCount: number;
  offlineCount: number;
} {
  let offlineCount = 0;
  for (const device of devices) {
    if (device.offline === true) offlineCount += 1;
  }
  return { deviceCount: devices.length, offlineCount };
}

/**
 * NinjaOne v2 list endpoints usually return a bare array; some wrap as
 * `{ results: [...] }`. Defensive (ADR-0038 forward-compat).
 */
export function extractArray<T>(raw: unknown): T[] | null {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results)) {
    return (raw as { results: T[] }).results;
  }
  return null;
}
