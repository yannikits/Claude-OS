/**
 * Agent-runs domain — Phase 5 (ADR-0002 §27).
 *
 * @module @domains/agent-runs
 */
export {
  AGENT_RUN_SCHEMA_VERSION,
  AgentRunsError,
  type AgentRunRecord,
} from './types.js';
export { JsonlWriter, sanitiseSegment } from './jsonl-writer.js';
export {
  AgentRunsIndex,
  agentRunsIndexPathFor,
  type IndexFileEnvelope,
  type QueryOpts,
  type RebuildResult,
} from './index-builder.js';
