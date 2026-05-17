/**
 * SecretStore factory — selects keyring or encrypted-file based on
 * runtime capability detection.
 *
 * Resolution order:
 *   1. `$CLAUDE_OS_SECRETS_BACKEND` env var ("keyring" or "encrypted-file")
 *   2. Capability probe — if the OS keyring round-trips a sentinel key,
 *      use it; otherwise fall back to encrypted-file
 *
 * @module @domains/secrets/factory
 */
import { join } from 'node:path';
import { resolveMachinePaths } from '../../core/paths/index.js';
import { EncryptedFileStore } from './encrypted-file-store.js';
import { KeyringStore, probeKeyring } from './keyring-store.js';
import type { SecretBackend, SecretStore } from './types.js';
import { SecretsError } from './types.js';

interface FactoryOpts {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** Override the encrypted-file path (tests). */
  readonly encryptedFilePathOverride?: string;
  /** Override the keyring probe (tests). */
  readonly probeFn?: () => boolean;
}

function readBackendOverride(env: NodeJS.ProcessEnv): SecretBackend | null {
  const v = env.CLAUDE_OS_SECRETS_BACKEND;
  if (v === undefined || v.trim().length === 0) return null;
  const normalised = v.trim().toLowerCase();
  if (normalised === 'keyring' || normalised === 'encrypted-file') return normalised;
  throw new SecretsError(
    `Invalid $CLAUDE_OS_SECRETS_BACKEND: "${v}" (expected "keyring" or "encrypted-file")`,
  );
}

function encryptedFilePath(opts: FactoryOpts): string {
  if (opts.encryptedFilePathOverride !== undefined) return opts.encryptedFilePathOverride;
  const paths = resolveMachinePaths({
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
  });
  return join(paths.dataRoot, 'secrets.enc');
}

/**
 * Returns a configured SecretStore. Synchronous because both backends'
 * construction is sync (the keyring probe runs sync native code; the
 * encrypted-file store defers I/O to its operations).
 */
export function createSecretStore(opts: FactoryOpts = {}): SecretStore {
  const env = opts.env ?? process.env;
  const override = readBackendOverride(env);

  if (override === 'keyring') return new KeyringStore();
  if (override === 'encrypted-file') {
    return new EncryptedFileStore({ filePath: encryptedFilePath(opts), env });
  }

  const probe = opts.probeFn ?? probeKeyring;
  if (probe()) return new KeyringStore();
  return new EncryptedFileStore({ filePath: encryptedFilePath(opts), env });
}
