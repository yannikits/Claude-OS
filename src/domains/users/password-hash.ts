/**
 * Password hashing via `node:crypto.scrypt` (Phase Web-7-1, ADR-0036
 * draft §Hashing-Strategy).
 *
 * scrypt is the OWASP-2023 recommended memory-hard KDF that ships in
 * Node's standard library — no native-build dependency, matching the
 * no-native-deps property of sql.js (ADR-0025 §Konsequenzen). Parameters
 * follow OWASP's 2023 baseline: `N=16384`, `r=8`, `p=1`, `dkLen=64`. At
 * `N=16384` / `r=8` the memory cost is `128 * N * r = 16 MB` per hash
 * — fast enough for homelab-scale login (~50ms on commodity CPU) and
 * slow enough to make offline brute-force costly.
 *
 * Encoded format (algorithm-tagged so we can swap KDFs forward):
 *
 * ```
 * scrypt$N=16384$r=8$p=1$<salt-b64>$<hash-b64>
 * ```
 *
 * `verifyPassword` uses `timingSafeEqual` against the derived bytes —
 * never against the encoded string — so timing leaks neither the
 * salt-prefix nor the stored hash. `hashPassword` throws
 * `WeakPasswordError` for inputs below `MIN_PASSWORD_LEN`;
 * `verifyPassword` returns `false` for any mismatch (including
 * malformed-input mismatches that aren't a programmer error) to keep
 * the user-enumeration defense intact.
 *
 * @module @domains/users/password-hash
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { MalformedHashError, WeakPasswordError } from './types.js';

type ScryptOpts = { N?: number; r?: number; p?: number; maxmem?: number };
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOpts,
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 32;
// Node's default maxmem is 32MB; our parameters need 16MB peak. 64MB is
// defensive headroom against future r-bumps without recompile.
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LEN = 12;
const HASH_FORMAT_PREFIX = 'scrypt';

/**
 * Hash a password for storage. Generates a fresh 32-byte salt per call,
 * so two hashes of the same password are guaranteed to differ.
 *
 * Throws `WeakPasswordError` when the password is shorter than
 * `MIN_PASSWORD_LEN` (12). The caller is responsible for any
 * higher-level validation (zxcvbn-style entropy checks etc.).
 */
export async function hashPassword(password: string): Promise<string> {
  assertStrongPassword(password);
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEM,
  });
  return [
    HASH_FORMAT_PREFIX,
    `N=${SCRYPT_N}`,
    `r=${SCRYPT_R}`,
    `p=${SCRYPT_P}`,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a candidate password against a previously-stored hash. Uses
 * `timingSafeEqual` over the derived buffers — both length-mismatch and
 * content-mismatch return `false` rather than throwing, so callers
 * don't need separate handling for malformed-hash-on-disk vs.
 * wrong-password (both are treated as "this login fails").
 *
 * The intentional exception: when `encoded` is structurally unparseable
 * (e.g. wrong prefix, wrong segment count), this throws
 * `MalformedHashError` — that condition only arises from a programmer
 * error feeding the wrong string in, not from user input.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0) return false;
  const parsed = parseEncoded(encoded);
  const derived = await scrypt(password, parsed.salt, parsed.keylen, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAX_MEM,
  });
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

function assertStrongPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string') {
    throw new WeakPasswordError('password must be a string');
  }
  if (password.length < MIN_PASSWORD_LEN) {
    throw new WeakPasswordError(
      `password must be at least ${MIN_PASSWORD_LEN} characters (got ${password.length})`,
    );
  }
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
  readonly keylen: number;
}

function parseEncoded(encoded: string): ParsedHash {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new MalformedHashError('encoded hash must be a non-empty string');
  }
  if (!encoded.startsWith(`${HASH_FORMAT_PREFIX}$`)) {
    throw new MalformedHashError(`expected "${HASH_FORMAT_PREFIX}$..." prefix`);
  }
  const parts = encoded.split('$');
  if (parts.length !== 6) {
    throw new MalformedHashError(`expected 6 segments separated by "$", got ${parts.length}`);
  }
  const nPart = parts[1] ?? '';
  const rPart = parts[2] ?? '';
  const pPart = parts[3] ?? '';
  const saltB64 = parts[4] ?? '';
  const hashB64 = parts[5] ?? '';
  const N = parseEqInt(nPart, 'N');
  const r = parseEqInt(rPart, 'r');
  const p = parseEqInt(pPart, 'p');
  const salt = Buffer.from(saltB64, 'base64');
  const hash = Buffer.from(hashB64, 'base64');
  if (salt.length === 0) throw new MalformedHashError('empty salt');
  if (hash.length === 0) throw new MalformedHashError('empty hash');
  return { N, r, p, salt, hash, keylen: hash.length };
}

function parseEqInt(segment: string, expectedKey: string): number {
  const eq = segment.indexOf('=');
  if (eq < 0) {
    throw new MalformedHashError(`expected "${expectedKey}=...", got "${segment}"`);
  }
  const key = segment.slice(0, eq);
  const val = segment.slice(eq + 1);
  if (key !== expectedKey) {
    throw new MalformedHashError(`expected "${expectedKey}=...", got "${key}=..."`);
  }
  const n = Number.parseInt(val, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== val) {
    throw new MalformedHashError(`invalid integer for "${expectedKey}": "${val}"`);
  }
  return n;
}
