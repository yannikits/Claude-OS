/**
 * EncryptedFileStore — AES-256-GCM file-backed SecretStore fallback
 * per ADR-0004. Used when the OS keyring is unavailable (headless
 * Linux without D-Bus, sandboxed CI, etc.).
 *
 * On-disk format (`<dataDir>/secrets.enc`):
 *   {
 *     "version": 1,
 *     "kdf": {"algo": "pbkdf2-sha256", "iterations": 600000, "saltHex": "..."},
 *     "ivHex": "<12 bytes>",
 *     "ciphertextHex": "<encrypted entries blob>",
 *     "tagHex": "<16 bytes>"
 *   }
 *
 * Decrypted plaintext is JSON of shape `Record<string, string>` mapping
 * secret-key to secret-value. The whole file is rewritten on every
 * mutation (acceptable volume for an interactive dev environment).
 *
 * Master key resolution:
 *   1. `masterKey` ctor opt (tests, programmatic)
 *   2. `$CLAUDE_OS_SECRETS_KEY` env var
 *   3. Throws `SecretsLockedError` — caller must surface UX prompt
 *
 * @module @domains/secrets/encrypted-file-store
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { SecretMetadata, SecretStore } from './types.js';
import { SecretsError, SecretsLockedError } from './types.js';

const FORMAT_VERSION = 1;
const KDF_ITERATIONS = 600_000;
const KDF_ALGO = 'pbkdf2-sha256' as const;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

interface FileEnvelope {
  readonly version: 1;
  readonly kdf: {
    readonly algo: typeof KDF_ALGO;
    readonly iterations: number;
    readonly saltHex: string;
  };
  readonly ivHex: string;
  readonly ciphertextHex: string;
  readonly tagHex: string;
}

interface EncryptedFileStoreOpts {
  /** Absolute path to the encrypted secrets file. */
  readonly filePath: string;
  /** Master-key override (skips env lookup). */
  readonly masterKey?: string;
  /** Env source for `$CLAUDE_OS_SECRETS_KEY`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

function resolveMasterKey(opts: EncryptedFileStoreOpts): string {
  if (opts.masterKey !== undefined && opts.masterKey.length > 0) return opts.masterKey;
  const fromEnv = (opts.env ?? process.env).CLAUDE_OS_SECRETS_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  throw new SecretsLockedError(
    'Encrypted-file backend is locked: no master key. Set $CLAUDE_OS_SECRETS_KEY or pass masterKey explicitly.',
  );
}

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return pbkdf2Sync(masterKey, salt, KDF_ITERATIONS, KEY_BYTES, 'sha256');
}

function encryptEntries(entries: Record<string, string>, masterKey: string): FileEnvelope {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(masterKey, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(entries), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: FORMAT_VERSION,
    kdf: { algo: KDF_ALGO, iterations: KDF_ITERATIONS, saltHex: salt.toString('hex') },
    ivHex: iv.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
    tagHex: tag.toString('hex'),
  };
}

function decryptEnvelope(envelope: FileEnvelope, masterKey: string): Record<string, string> {
  if (envelope.version !== FORMAT_VERSION) {
    throw new SecretsError(`Unsupported secrets-file version: ${envelope.version}`);
  }
  if (envelope.kdf.algo !== KDF_ALGO) {
    throw new SecretsError(`Unsupported KDF algorithm: ${envelope.kdf.algo}`);
  }
  const salt = Buffer.from(envelope.kdf.saltHex, 'hex');
  const iv = Buffer.from(envelope.ivHex, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertextHex, 'hex');
  const tag = Buffer.from(envelope.tagHex, 'hex');
  const key = deriveKey(masterKey, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SecretsError('Decrypted secrets blob is not a JSON object');
    }
    return parsed as Record<string, string>;
  } catch (err) {
    if (err instanceof SecretsError) throw err;
    throw new SecretsError(
      'Decryption failed — wrong master key or corrupted file. ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

export class EncryptedFileStore implements SecretStore {
  readonly backend = 'encrypted-file' as const;
  readonly filePath: string;

  private readonly opts: EncryptedFileStoreOpts;

  constructor(opts: EncryptedFileStoreOpts) {
    this.opts = opts;
    this.filePath = opts.filePath;
  }

  private readEntries(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    const raw = readFileSync(this.filePath, 'utf8');
    const envelope = JSON.parse(raw) as FileEnvelope;
    return decryptEnvelope(envelope, resolveMasterKey(this.opts));
  }

  private writeEntries(entries: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const envelope = encryptEntries(entries, resolveMasterKey(this.opts));
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  get(key: string): Promise<string | null> {
    try {
      const entries = this.readEntries();
      return Promise.resolve(entries[key] ?? null);
    } catch (err) {
      if (err instanceof SecretsError) return Promise.reject(err);
      return Promise.reject(
        new SecretsError(
          `encrypted-file get failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  set(key: string, value: string): Promise<void> {
    try {
      const entries = this.readEntries();
      entries[key] = value;
      this.writeEntries(entries);
      return Promise.resolve();
    } catch (err) {
      if (err instanceof SecretsError) return Promise.reject(err);
      return Promise.reject(
        new SecretsError(
          `encrypted-file set failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  delete(key: string): Promise<boolean> {
    try {
      const entries = this.readEntries();
      if (!(key in entries)) return Promise.resolve(false);
      delete entries[key];
      if (Object.keys(entries).length === 0) {
        if (existsSync(this.filePath)) unlinkSync(this.filePath);
      } else {
        this.writeEntries(entries);
      }
      return Promise.resolve(true);
    } catch (err) {
      if (err instanceof SecretsError) return Promise.reject(err);
      return Promise.reject(
        new SecretsError(
          `encrypted-file delete failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  list(): Promise<readonly SecretMetadata[]> {
    try {
      const entries = this.readEntries();
      return Promise.resolve(
        Object.keys(entries).map((key) => ({ key, backend: 'encrypted-file' as const })),
      );
    } catch (err) {
      if (err instanceof SecretsError) return Promise.reject(err);
      return Promise.reject(
        new SecretsError(
          `encrypted-file list failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}
