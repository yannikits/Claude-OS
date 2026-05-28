/**
 * Sessions-Domain barrel (Phase Web-7-2).
 *
 * @module @domains/sessions
 */

export { looksLikeSessionId, newSessionId } from './id.js';
export { LruStore, type LruStoreOpts } from './lru-store.js';
export { type IssueSessionInput, type SessionRepoOpts, SessionRepository } from './repo.js';
export {
  DEFAULT_LRU_CAPACITY,
  DEFAULT_SESSION_TTL_MS,
  type Session,
  SessionError,
  SessionNotFoundError,
} from './types.js';
