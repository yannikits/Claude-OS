/**
 * claude-bridge domain — streaming wrapper around the Anthropic claude
 * binary (Phase 3b, ADR-0003).
 *
 * @module @domains/claude-bridge
 */
export type {
  BridgeOpts,
  BridgeResult,
  BinarySource,
  ResolvedBinary,
} from './types.js';
export { BinaryNotFoundError } from './types.js';
export { resolveClaudeBinary } from './resolve-binary.js';
export { startHeartbeat, type Heartbeat } from './heartbeat.js';
export { spawnClaudeBridge } from './spawn.js';
