/**
 * `UserRepository` — sql.js-backed persistent user store (Phase Web-7-1,
 * ADR-0036 draft).
 *
 * Schema (v1):
 *
 *   meta(key TEXT PK, value TEXT)
 *   users(
 *     id TEXT PK,
 *     email TEXT UNIQUE,
 *     password_hash TEXT,
 *     created_at INTEGER,
 *     last_login_at INTEGER NULL,
 *     disabled INTEGER NOT NULL DEFAULT 0,
 *     tenant_id_override TEXT NULL
 *   )
 *
 * Atomic save on every mutation via tempfile+rename — the table is
 * small (one row per human user, < 1KB each) so the cost is negligible
 * compared to the safety of "no half-written file on crash". The mode
 * is set to `0o600` (POSIX); on Windows the chmod is a best-effort
 * no-op and the file's ACL inherits from the parent dir.
 *
 * `verifyPassword` is constant-time across the existence check: even
 * when the email doesn't exist, a fake hash is verified so the response
 * latency doesn't leak user-enumeration. The fake hash is lazily
 * computed once per repository instance.
 *
 * @module @domains/users/repo
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { hashPassword, verifyPassword as verifyHash } from './password-hash.js';
import { ensureUsersDir, resolveUsersDbPath } from './paths.js';
import {
  DuplicateEmailError,
  InvalidEmailError,
  USERS_SCHEMA_VERSION,
  type User,
  UserError,
  UserNotFoundError,
} from './types.js';

// Email validation is intentionally permissive — defensive against the
// most common typos (missing @, missing TLD) without trying to be RFC
// 5322 compliant. Per Lesson 2026-05-25, no literal spaces in the
// character class (we use none; only `\.` and class-bracket bounds).
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const FILE_MODE = 0o600;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  tenant_id_override TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_disabled ON users(disabled);
`;

const STAMP_VERSION_SQL = `INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '${USERS_SCHEMA_VERSION}');`;
const READ_SCHEMA_VERSION_SQL = `SELECT value FROM meta WHERE key='schema_version';`;

const FAKE_PASSWORD_PLACEHOLDER = 'enumeration-defense-placeholder';

let cachedSqlJs: SqlJsStatic | null = null;
async function getSqlJs(): Promise<SqlJsStatic> {
  if (cachedSqlJs !== null) return cachedSqlJs;
  cachedSqlJs = await initSqlJs();
  return cachedSqlJs;
}

export interface OpenUsersOpts {
  readonly dataDir: string;
  /** When true and the on-disk schema-version differs, drop + recreate. Default true. */
  readonly autoRebuildOnSchemaDrift?: boolean;
}

export interface CreateUserOpts {
  readonly tenantIdOverride?: string;
}

export interface ListUsersOpts {
  readonly includeDisabled?: boolean;
}

export class UserRepository {
  private fakeHash: string | null = null;
  private closed = false;

  private constructor(
    private readonly db: Database,
    private readonly dbPath: string,
  ) {}

  static async open(opts: OpenUsersOpts): Promise<UserRepository> {
    ensureUsersDir(opts.dataDir);
    const dbPath = resolveUsersDbPath(opts.dataDir);
    const SQL = await getSqlJs();

    const db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
    db.exec(SCHEMA_SQL);

    const onDisk = readSchemaVersion(db);
    if (onDisk !== null && onDisk !== USERS_SCHEMA_VERSION) {
      if (opts.autoRebuildOnSchemaDrift === false) {
        db.close();
        throw new UserError(
          `Schema-version mismatch: on-disk=${onDisk}, expected=${USERS_SCHEMA_VERSION}. ` +
            'Re-open with autoRebuildOnSchemaDrift=true to migrate (drops all users).',
        );
      }
      db.exec('DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS meta;');
      db.exec(SCHEMA_SQL);
    }
    db.exec(STAMP_VERSION_SQL);

    const repo = new UserRepository(db, dbPath);
    repo.save();
    return repo;
  }

  async createUser(email: string, password: string, opts: CreateUserOpts = {}): Promise<User> {
    this.assertOpen();
    const normalized = normalizeEmail(email);
    if (this.findByEmailRaw(normalized) !== null) {
      throw new DuplicateEmailError(normalized);
    }
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    const now = Date.now();
    const tenantOverride = opts.tenantIdOverride ?? null;
    this.db.run(
      `INSERT INTO users(id, email, password_hash, created_at, last_login_at, disabled, tenant_id_override)
       VALUES (?, ?, ?, ?, NULL, 0, ?)`,
      [id, normalized, passwordHash, now, tenantOverride],
    );
    this.save();
    return {
      id,
      email: normalized,
      passwordHash,
      createdAt: now,
      lastLoginAt: null,
      disabled: false,
      tenantIdOverride: tenantOverride,
    };
  }

  findByEmail(email: string): User | null {
    this.assertOpen();
    let normalized: string;
    try {
      normalized = normalizeEmail(email);
    } catch (err) {
      if (err instanceof InvalidEmailError) return null;
      throw err;
    }
    return this.findByEmailRaw(normalized);
  }

  findById(id: string): User | null {
    this.assertOpen();
    return this.queryOne('SELECT * FROM users WHERE id=?', [id]);
  }

  /**
   * Constant-time across "user does not exist" and "wrong password" —
   * both branches do one scrypt-verify worth of work.
   */
  async verifyPassword(email: string, password: string): Promise<User | null> {
    this.assertOpen();
    if (typeof password !== 'string' || password.length === 0) return null;
    let normalized: string | null;
    try {
      normalized = normalizeEmail(email);
    } catch {
      normalized = null;
    }
    const user = normalized === null ? null : this.findByEmailRaw(normalized);
    if (user === null) {
      // Burn time equivalent to a real verify so we don't leak existence
      // via timing.
      await this.exerciseFakeHash(password);
      return null;
    }
    if (user.disabled) {
      await this.exerciseFakeHash(password);
      return null;
    }
    let ok = false;
    try {
      ok = await verifyHash(password, user.passwordHash);
    } catch {
      // Malformed-hash-on-disk: treat as login-failed rather than crashing
      // the auth pipeline. Should never happen for hashes we wrote; if
      // it does, the user's password needs admin reset.
      return null;
    }
    return ok ? user : null;
  }

  disable(idOrEmail: string): boolean {
    this.assertOpen();
    const user = this.resolveUser(idOrEmail);
    if (user === null || user.disabled) return false;
    this.db.run('UPDATE users SET disabled=1 WHERE id=?', [user.id]);
    this.save();
    return true;
  }

  enable(idOrEmail: string): boolean {
    this.assertOpen();
    const user = this.resolveUser(idOrEmail);
    if (user === null || !user.disabled) return false;
    this.db.run('UPDATE users SET disabled=0 WHERE id=?', [user.id]);
    this.save();
    return true;
  }

  async setPassword(idOrEmail: string, newPassword: string): Promise<void> {
    this.assertOpen();
    const user = this.resolveUser(idOrEmail);
    if (user === null) throw new UserNotFoundError(idOrEmail);
    const passwordHash = await hashPassword(newPassword);
    this.db.run('UPDATE users SET password_hash=? WHERE id=?', [passwordHash, user.id]);
    this.save();
  }

  list(opts: ListUsersOpts = {}): User[] {
    this.assertOpen();
    const sql =
      opts.includeDisabled === true
        ? 'SELECT * FROM users ORDER BY created_at ASC, id ASC'
        : 'SELECT * FROM users WHERE disabled=0 ORDER BY created_at ASC, id ASC';
    const stmt = this.db.prepare(sql);
    const out: User[] = [];
    try {
      while (stmt.step()) {
        out.push(rowToUser(stmt.getAsObject()));
      }
    } finally {
      stmt.free();
    }
    return out;
  }

  recordLogin(id: string, ts: number = Date.now()): boolean {
    this.assertOpen();
    if (this.findById(id) === null) return false;
    this.db.run('UPDATE users SET last_login_at=? WHERE id=?', [ts, id]);
    this.save();
    return true;
  }

  /**
   * Persist the in-memory DB to disk via tempfile+rename. Best-effort
   * `chmod 0o600` on POSIX — silently no-ops on Windows where the
   * filesystem doesn't honour POSIX mode bits.
   */
  save(): void {
    this.assertOpen();
    const bytes = this.db.export();
    const tmp = `${this.dbPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, this.dbPath);
    try {
      chmodSync(this.dbPath, FILE_MODE);
    } catch {
      // Windows: ignored — ACLs inherit from parent dir. POSIX: would
      // be a real failure but we don't want save() to throw for a mode
      // bit that may already be set correctly by a previous run.
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  /** Diagnostic helper for tests + `doctor`. */
  countAll(): number {
    this.assertOpen();
    const stmt = this.db.prepare('SELECT COUNT(*) AS n FROM users');
    try {
      stmt.step();
      const v = stmt.get()[0];
      return typeof v === 'number' ? v : Number(v ?? 0);
    } finally {
      stmt.free();
    }
  }

  private findByEmailRaw(normalizedEmail: string): User | null {
    return this.queryOne('SELECT * FROM users WHERE email=?', [normalizedEmail]);
  }

  private resolveUser(idOrEmail: string): User | null {
    if (idOrEmail.includes('@')) {
      return this.findByEmail(idOrEmail);
    }
    return this.findById(idOrEmail);
  }

  private queryOne(sql: string, params: ReadonlyArray<string | number | null>): User | null {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as Array<string | number | null>);
    try {
      if (!stmt.step()) return null;
      return rowToUser(stmt.getAsObject());
    } finally {
      stmt.free();
    }
  }

  private async exerciseFakeHash(password: string): Promise<void> {
    if (this.fakeHash === null) {
      this.fakeHash = await hashPassword(FAKE_PASSWORD_PLACEHOLDER);
    }
    try {
      await verifyHash(password, this.fakeHash);
    } catch {
      // ignore — only here to burn time
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new UserError('UserRepository is closed');
    }
  }
}

function readSchemaVersion(db: Database): number | null {
  const stmt = db.prepare(READ_SCHEMA_VERSION_SQL);
  try {
    if (!stmt.step()) return null;
    const raw = stmt.get()[0];
    if (typeof raw !== 'string') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? n : null;
  } finally {
    stmt.free();
  }
}

function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') throw new InvalidEmailError(String(email));
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) throw new InvalidEmailError(email);
  return trimmed;
}

type SqlRow = Record<string, unknown>;

function rowToUser(row: SqlRow): User {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    createdAt: Number(row.created_at),
    lastLoginAt:
      row.last_login_at === null || row.last_login_at === undefined
        ? null
        : Number(row.last_login_at),
    disabled: Number(row.disabled) === 1,
    tenantIdOverride:
      row.tenant_id_override === null || row.tenant_id_override === undefined
        ? null
        : String(row.tenant_id_override),
  };
}
