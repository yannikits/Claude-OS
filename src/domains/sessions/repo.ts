/**
 * `SessionRepository` — opaque-token session store (Phase Web-7-2).
 *
 * In-memory LRU by default. Sliding-window TTL: every `get()` that
 * hits a non-expired session refreshes `lastUsedAt` and reschedules
 * `expiresAt = lastUsedAt + ttlMs`. Expired entries are removed on
 * read (lazy) and on `prune()` (eager).
 *
 * The repo is intentionally NOT persistent in this phase — container
 * restarts force re-login. Opt-in persistence is wired in a follow-up
 * via the same `users.sqlite` store (`$CLAUDE_OS_SESSION_PERSIST=1`).
 *
 * Time source is injectable via `now: () => number` so tests can
 * fast-forward without touching real timers.
 *
 * @module @domains/sessions/repo
 */

import { looksLikeSessionId, newSessionId } from './id.js';
import { LruStore } from './lru-store.js';
import { DEFAULT_LRU_CAPACITY, DEFAULT_SESSION_TTL_MS, type Session } from './types.js';

export interface SessionRepoOpts {
  readonly ttlMs?: number;
  readonly capacity?: number;
  readonly now?: () => number;
}

export interface IssueSessionInput {
  readonly userId: string;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

export class SessionRepository {
  private readonly store: LruStore<string, Session>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: SessionRepoOpts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.store = new LruStore({ capacity: opts.capacity ?? DEFAULT_LRU_CAPACITY });
  }

  /** Mint a fresh session for `userId`. */
  issue(input: IssueSessionInput): Session {
    const id = newSessionId();
    const ts = this.now();
    const session: Session = {
      id,
      userId: input.userId,
      createdAt: ts,
      lastUsedAt: ts,
      expiresAt: ts + this.ttlMs,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    };
    this.store.set(id, session);
    return session;
  }

  /**
   * Resolve a session-id. Returns `null` when the id is unknown,
   * malformed, or expired (expired sessions are evicted as a
   * side-effect). On hit, refreshes `lastUsedAt` and `expiresAt`
   * (sliding-window behaviour).
   */
  resolve(id: string): Session | null {
    if (!looksLikeSessionId(id)) return null;
    const existing = this.store.get(id);
    if (existing === null) return null;
    const ts = this.now();
    if (existing.expiresAt <= ts) {
      this.store.delete(id);
      return null;
    }
    const refreshed: Session = {
      ...existing,
      lastUsedAt: ts,
      expiresAt: ts + this.ttlMs,
    };
    this.store.set(id, refreshed);
    return refreshed;
  }

  /**
   * Look up a session-id without sliding the TTL. Used by GET /me
   * style endpoints that should not refresh the cookie.
   */
  peek(id: string): Session | null {
    if (!looksLikeSessionId(id)) return null;
    const existing = this.store.peek(id);
    if (existing === null) return null;
    if (existing.expiresAt <= this.now()) {
      this.store.delete(id);
      return null;
    }
    return existing;
  }

  revoke(id: string): boolean {
    return this.store.delete(id);
  }

  /** Revoke every session belonging to a user. Used by user-disable / admin-revoke. */
  revokeAllForUser(userId: string): number {
    let removed = 0;
    for (const s of this.store.values()) {
      if (s.userId === userId) {
        if (this.store.delete(s.id)) removed++;
      }
    }
    return removed;
  }

  listForUser(userId: string): Session[] {
    const ts = this.now();
    return this.store.values().filter((s) => s.userId === userId && s.expiresAt > ts);
  }

  /** Eager TTL-sweep. Returns the count of entries removed. */
  prune(): number {
    const ts = this.now();
    let removed = 0;
    for (const s of this.store.values()) {
      if (s.expiresAt <= ts) {
        if (this.store.delete(s.id)) removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.store.size();
  }

  clear(): void {
    this.store.clear();
  }
}
