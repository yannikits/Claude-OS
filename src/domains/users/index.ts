/**
 * Users-Domain barrel (Phase Web-7-1).
 *
 * @module @domains/users
 */

export { hashPassword, MIN_PASSWORD_LEN, verifyPassword } from './password-hash.js';
export { ensureUsersDir, resolveUsersDbPath } from './paths.js';
export type { CreateUserOpts, ListUsersOpts, OpenUsersOpts } from './repo.js';
export { UserRepository } from './repo.js';
export type { User } from './types.js';
export {
  DuplicateEmailError,
  InvalidEmailError,
  MalformedHashError,
  USERS_SCHEMA_VERSION,
  UserError,
  UserNotFoundError,
  WeakPasswordError,
} from './types.js';
