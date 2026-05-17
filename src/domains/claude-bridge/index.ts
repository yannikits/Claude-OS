/**
 * claude-bridge domain — streaming wrapper around the Anthropic claude
 * binary (Phase 3b, ADR-0003).
 *
 * @module @domains/claude-bridge
 */

export { type Heartbeat, startHeartbeat } from './heartbeat.js';
export { resolveClaudeBinary } from './resolve-binary.js';
export { spawnClaudeBridge } from './spawn.js';
export type {
  BinarySource,
  BridgeOpts,
  BridgeResult,
  ResolvedBinary,
} from './types.js';
export { BinaryNotFoundError } from './types.js';
