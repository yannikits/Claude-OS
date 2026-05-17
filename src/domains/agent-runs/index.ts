/**
 * Agent-runs domain — Phase 5 (ADR-0002 §27).
 *
 * @module @domains/agent-runs
 */

export {
  AgentRunsIndex,
  agentRunsIndexPathFor,
  type IndexFileEnvelope,
  type QueryOpts,
  type RebuildResult,
} from './index-builder.js';
export { JsonlWriter, sanitiseSegment } from './jsonl-writer.js';
export {
  AgentRunsRepository,
  type RecordOpts,
  type RecordResult,
} from './repository.js';
export {
  AGENT_RUN_SCHEMA_VERSION,
  type AgentRunRecord,
  AgentRunsError,
} from './types.js';
export { VaultWriter } from './vault-writer.js';
