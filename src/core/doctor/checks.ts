/**
 * Individual doctor checks. Each check is independent and returns
 * a structured CheckResult; failures are reported as 'fail' severity
 * rather than thrown exceptions so the runner can present them
 * uniformly.
 *
 * @module @core/doctor/checks
 */

import { exec } from 'node:child_process';
import { accessSync, existsSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ResolvedRoot } from '../environment/index.js';
import type { CheckFn, CheckResult } from './types.js';

const execAsync = promisify(exec);

const MIN_NODE_MAJOR = 20;

async function timed(name: string, fn: CheckFn): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      severity: 'fail',
      message: `Check threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

export async function checkNodeVersion(): Promise<CheckResult> {
  return timed('node-version', () => {
    const versionStr = process.versions.node;
    const majorStr = versionStr.split('.')[0] ?? '0';
    const major = Number.parseInt(majorStr, 10);
    if (major >= MIN_NODE_MAJOR) {
      return Promise.resolve({
        name: 'node-version',
        severity: 'ok',
        message: `Node v${versionStr}`,
      });
    }
    return Promise.resolve({
      name: 'node-version',
      severity: 'fail',
      message: `Node v${versionStr} below required v${MIN_NODE_MAJOR}`,
      hint: `Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org`,
    });
  });
}

export async function checkGitAvailable(): Promise<CheckResult> {
  return timed('git-available', async () => {
    try {
      const { stdout } = await execAsync('git --version');
      return {
        name: 'git-available',
        severity: 'ok',
        message: stdout.trim(),
      };
    } catch {
      return {
        name: 'git-available',
        severity: 'fail',
        message: 'System `git` not found in PATH',
        hint: 'Install Git: `winget install Git.Git` (Win) | `brew install git` (mac) | `apt install git` (Linux)',
      };
    }
  });
}

export async function checkClaudeBinary(rootPath: string): Promise<CheckResult> {
  return timed('claude-binary', () => {
    const win = join(rootPath, 'bin', 'claude.exe');
    const posix = join(rootPath, 'bin', 'claude');
    if (existsSync(win)) {
      return Promise.resolve({
        name: 'claude-binary',
        severity: 'ok',
        message: `Anthropic claude binary present at bin/claude.exe`,
      });
    }
    if (existsSync(posix)) {
      return Promise.resolve({
        name: 'claude-binary',
        severity: 'ok',
        message: `Anthropic claude binary present at bin/claude`,
      });
    }
    return Promise.resolve({
      name: 'claude-binary',
      severity: 'warn',
      message: 'Anthropic claude binary not found in bin/',
      detail: `Checked ${win} and ${posix}`,
      hint: '`claude-os ai` will fail until the Anthropic CLI is installed in bin/',
    });
  });
}

export async function checkMountReachable(root: ResolvedRoot): Promise<CheckResult> {
  return timed('mount-reachable', () => {
    if (!existsSync(root.path)) {
      return Promise.resolve({
        name: 'mount-reachable',
        severity: 'fail',
        message: `Root path "${root.path}" does not exist`,
        hint: 'Check $CLAUDE_OS_ROOT, your cloud-sync client (OneDrive/rclone/Drive), or run from within a claude-os repo',
      });
    }
    return Promise.resolve({
      name: 'mount-reachable',
      severity: 'ok',
      message: `${root.path} (source=${root.source}, cloud=${root.cloudProvider})`,
    });
  });
}

export async function checkWindowsLongPaths(): Promise<CheckResult> {
  return timed('windows-long-paths', async () => {
    if (process.platform !== 'win32') {
      return {
        name: 'windows-long-paths',
        severity: 'ok',
        message: 'not applicable (non-Windows)',
      };
    }
    try {
      const { stdout } = await execAsync('git config --global --get core.longpaths');
      const value = stdout.trim().toLowerCase();
      if (value === 'true') {
        return {
          name: 'windows-long-paths',
          severity: 'ok',
          message: 'git core.longpaths=true (vault deep-tree paths supported)',
        };
      }
      return {
        name: 'windows-long-paths',
        severity: 'warn',
        message: `git core.longpaths="${value}" — paths >260 chars may fail`,
        hint: 'Run: git config --global core.longpaths true',
      };
    } catch {
      // Non-zero exit usually means the key is unset.
      return {
        name: 'windows-long-paths',
        severity: 'warn',
        message: 'git core.longpaths is unset — paths >260 chars may fail',
        hint: 'Run: git config --global core.longpaths true',
      };
    }
  });
}

/**
 * Server-mode pre-flight (Phase Web-5 per ADR-0032 §"Akzeptanzkriterien" #1).
 *
 * Runs from `docker/entrypoint.sh` before `claude-os serve` boots —
 * fails loud so the container exits with a usable error message
 * instead of starting in a half-configured state.
 *
 * Three boundaries this check protects:
 *  1. `CLAUDE_OS_AUTH_TOKEN` set → otherwise the server's
 *     `makeAuthHook` would refuse-boot anyway, but later in startup
 *     and with a less-greppable message.
 *  2. `CLAUDE_OS_SECRETS_BACKEND` must not be `keyring` in headless
 *     containers (no DBus/Secret-Service). The valid headless choice is
 *     `encrypted-file` (per `SecretBackend` union in
 *     `src/domains/secrets/types.ts`); empty/unset is also fine since
 *     `factory.ts` then falls back via capability-probe. Catching a
 *     mis-set `=keyring` here saves a confusing runtime crash on the
 *     first `secrets.set` call.
 *  3. `CLAUDE_OS_VAULT_PATH` directory exists and is writable →
 *     otherwise vault-sync, note-write, and FTS-indexer fail later
 *     with cryptic ENOENT/EACCES errors deep in `methods.ts`.
 *
 * Skips with `ok` outside server-mode (no `CLAUDE_OS_AUTH_TOKEN`
 * present), so Tauri-desktop `claude-os doctor` runs are unaffected.
 */
export async function checkServerEnv(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  return timed('server-env', () => {
    const token = env.CLAUDE_OS_AUTH_TOKEN;
    if (token === undefined || token.length === 0) {
      return Promise.resolve({
        name: 'server-env',
        severity: 'ok',
        message: 'not in server mode (skipped — $CLAUDE_OS_AUTH_TOKEN unset)',
      });
    }

    const problems: string[] = [];

    // Headless containers can only use `encrypted-file` (the
    // SecretBackend union has exactly two members; `keyring` needs a
    // desktop session). Empty/unset is acceptable — the factory then
    // capability-probes and ends up at encrypted-file anyway.
    const backend = (env.CLAUDE_OS_SECRETS_BACKEND ?? '').trim().toLowerCase();
    if (backend === 'keyring') {
      problems.push(
        'CLAUDE_OS_SECRETS_BACKEND="keyring" — keyring backends need a desktop session; use "encrypted-file" in headless containers',
      );
    } else if (backend.length > 0 && backend !== 'encrypted-file') {
      problems.push(
        `CLAUDE_OS_SECRETS_BACKEND="${env.CLAUDE_OS_SECRETS_BACKEND}" — unknown backend (expected "encrypted-file" or unset)`,
      );
    }

    const vaultPath = env.CLAUDE_OS_VAULT_PATH ?? '';
    if (vaultPath.length === 0) {
      problems.push('CLAUDE_OS_VAULT_PATH is unset — pre-flight expects a mounted vault directory');
    } else if (!existsSync(vaultPath)) {
      problems.push(`CLAUDE_OS_VAULT_PATH="${vaultPath}" does not exist (volume not mounted?)`);
    } else {
      try {
        accessSync(vaultPath, fsConstants.W_OK);
      } catch {
        problems.push(`CLAUDE_OS_VAULT_PATH="${vaultPath}" is not writable`);
      }
    }

    if (problems.length === 0) {
      return Promise.resolve({
        name: 'server-env',
        severity: 'ok',
        message: 'server-mode env complete (token + encrypted-file backend + writable vault)',
      });
    }

    return Promise.resolve({
      name: 'server-env',
      severity: 'fail',
      message: 'server-mode env incomplete',
      detail: problems.join(' | '),
      hint: 'See docs/server-deployment.md §"Schritt 2 — Claude-OS deployen" for the expected .env layout',
    });
  });
}

/**
 * TANSS-Bridge config pre-flight (ADR-0038, Phase 7-B).
 *
 * Three states:
 *  - both `CLAUDE_OS_TANSS_SERVER_URL` and the secret `tanss/apiToken`
 *    set         → `ok`
 *  - neither set → `ok` (TANSS-Bridge intentionally not configured)
 *  - one of two  → `warn` (likely a half-finished setup; user wants to know)
 *
 * Never `fail` — TANSS is optional. Secret-store lookup uses the same
 * factory the bridge uses at runtime, so the check sees the same state.
 *
 * @param env - injected for tests
 * @param secretsProbe - injected for tests; defaults to a real createSecretStore().get()
 */
export async function checkTanssConfig(
  env: NodeJS.ProcessEnv = process.env,
  secretsProbe?: (key: string) => Promise<string | null>,
): Promise<CheckResult> {
  return timed('tanss-config', async () => {
    const url = (env.CLAUDE_OS_TANSS_SERVER_URL ?? '').trim();
    let token: string | null = null;
    try {
      const probe =
        secretsProbe ??
        (async (k: string) => {
          const { createSecretStore } = await import('../../domains/secrets/index.js');
          return createSecretStore({ env }).get(k);
        });
      token = await probe('tanss/apiToken');
    } catch (err) {
      return {
        name: 'tanss-config',
        severity: 'warn',
        message: 'secrets-store probe failed — cannot verify tanss/apiToken',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const hasUrl = url.length > 0;
    const hasToken = token !== null && token.length > 0;

    if (!hasUrl && !hasToken) {
      return {
        name: 'tanss-config',
        severity: 'ok',
        message: 'TANSS bridge not configured (skipped — both URL and apiToken unset)',
      };
    }
    if (hasUrl && hasToken) {
      return {
        name: 'tanss-config',
        severity: 'ok',
        message: `TANSS bridge configured (server=${url})`,
      };
    }
    if (hasUrl && !hasToken) {
      return {
        name: 'tanss-config',
        severity: 'warn',
        message: `TANSS server-URL set but no apiToken in secrets-backend`,
        hint: 'Run: claude-os secrets set tanss/apiToken <key>',
      };
    }
    return {
      name: 'tanss-config',
      severity: 'warn',
      message: 'TANSS apiToken in secrets-backend but $CLAUDE_OS_TANSS_SERVER_URL unset',
      hint: 'Set CLAUDE_OS_TANSS_SERVER_URL=https://your-tanss.example.com in your env',
    };
  });
}

/**
 * NinjaOne-Bridge config pre-flight (Phase MC-F).
 *
 * Base URL has a default (eu.ninjarmm.com) so it is not required; the gate is
 * the two OAuth-client secrets. Three states:
 *   - neither secret set → ok (bridge not configured)
 *   - both secrets set   → ok (configured)
 *   - one of two         → warn (half-finished setup)
 */
export async function checkNinjaConfig(
  env: NodeJS.ProcessEnv = process.env,
  secretsProbe?: (key: string) => Promise<string | null>,
): Promise<CheckResult> {
  return timed('ninja-config', async () => {
    const baseUrl = (env.CLAUDE_OS_NINJA_BASE_URL ?? 'https://eu.ninjarmm.com').trim();
    const probe =
      secretsProbe ??
      (async (k: string) => {
        const { createSecretStore } = await import('../../domains/secrets/index.js');
        return createSecretStore({ env }).get(k);
      });
    let clientId: string | null = null;
    let clientSecret: string | null = null;
    try {
      [clientId, clientSecret] = await Promise.all([
        probe('ninja/clientId'),
        probe('ninja/clientSecret'),
      ]);
    } catch (err) {
      return {
        name: 'ninja-config',
        severity: 'warn',
        message: 'secrets-store probe failed — cannot verify ninja credentials',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const hasId = clientId !== null && clientId.length > 0;
    const hasSecret = clientSecret !== null && clientSecret.length > 0;

    if (!hasId && !hasSecret) {
      return {
        name: 'ninja-config',
        severity: 'ok',
        message: 'NinjaOne bridge not configured (skipped — no client credentials)',
      };
    }
    if (hasId && hasSecret) {
      return {
        name: 'ninja-config',
        severity: 'ok',
        message: `NinjaOne bridge configured (base=${baseUrl})`,
      };
    }
    return {
      name: 'ninja-config',
      severity: 'warn',
      message: 'NinjaOne credentials incomplete — set BOTH ninja/clientId and ninja/clientSecret',
      hint: 'claude-os secrets set ninja/clientId <id>  +  claude-os secrets set ninja/clientSecret <secret>',
    };
  });
}

/**
 * Veeam-Bridges config pre-flight (ADR-0040, Phase 7-C).
 *
 * Per-customer-VBR architecture means there's no single env var to check.
 * Instead we:
 *   1. Enumerate all customer-workspaces under the vault
 *   2. Collect distinct serverHostnames from bridges.veeam.serverHostname
 *   3. For each host: probe secrets-backend for `veeam/<host>/username` AND `veeam/<host>/password`
 *
 * Three states:
 *   - no customer has bridges.veeam               → ok (Veeam optional, none configured)
 *   - all hosts have both creds                   → ok (count of hosts in message)
 *   - some hosts missing creds                    → warn (lists which)
 *
 * Never `fail` — Veeam is optional. Vault-resolution failure → warn (can't
 * check). Secrets-probe failure → warn.
 *
 * @param vaultRoot - optional explicit override; default uses resolveRoot
 * @param secretsProbe - injectable for tests; defaults to createSecretStore().get()
 * @param listSlugsFn - injectable for tests
 * @param getCustomerFn - injectable for tests
 */
export async function checkVeeamConfig(
  opts: {
    readonly vaultRoot?: string;
    readonly secretsProbe?: (key: string) => Promise<string | null>;
    readonly listSlugsFn?: (vaultRoot: string) => readonly string[];
    readonly getCustomerFn?: (
      vaultRoot: string,
      slug: string,
    ) => Promise<{
      readonly bridges?: { readonly veeam?: { readonly serverHostname: string } };
    } | null>;
  } = {},
): Promise<CheckResult> {
  return timed('veeam-config', async () => {
    let vaultRoot = opts.vaultRoot;
    if (vaultRoot === undefined) {
      try {
        const { resolveRoot } = await import('../environment/index.js');
        const root = resolveRoot();
        vaultRoot = join(root.path, 'vault');
      } catch (err) {
        return {
          name: 'veeam-config',
          severity: 'ok' as const,
          message: 'vault unreachable — Veeam check skipped',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    let slugs: readonly string[];
    try {
      if (opts.listSlugsFn !== undefined) {
        slugs = opts.listSlugsFn(vaultRoot);
      } else {
        const { listCustomerSlugs } = await import('../../domains/msp-customers/paths.js');
        slugs = listCustomerSlugs(vaultRoot);
      }
    } catch (err) {
      return {
        name: 'veeam-config',
        severity: 'warn',
        message: 'failed to enumerate customer-workspaces',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const hosts = new Set<string>();
    for (const slug of slugs) {
      let record: { bridges?: { veeam?: { serverHostname: string } } } | null = null;
      try {
        if (opts.getCustomerFn !== undefined) {
          record = await opts.getCustomerFn(vaultRoot, slug);
        } else {
          const { CustomerRepository } = await import('../../domains/msp-customers/index.js');
          const repo = new CustomerRepository({ vaultRoot, autoCreate: false });
          record = await repo.get(slug);
        }
      } catch {
        // Tolerate individual broken customer.yaml — they'll surface via other tooling
        continue;
      }
      const host = record?.bridges?.veeam?.serverHostname;
      if (typeof host === 'string' && host.length > 0) hosts.add(host);
    }

    if (hosts.size === 0) {
      return {
        name: 'veeam-config',
        severity: 'ok',
        message: 'no customer-workspaces reference bridges.veeam (skipped)',
      };
    }

    const probe =
      opts.secretsProbe ??
      (async (k: string) => {
        const { createSecretStore } = await import('../../domains/secrets/index.js');
        return createSecretStore().get(k);
      });

    const missing: string[] = [];
    for (const host of hosts) {
      let u: string | null;
      let p: string | null;
      try {
        [u, p] = await Promise.all([
          probe(`veeam/${host}/username`),
          probe(`veeam/${host}/password`),
        ]);
      } catch (err) {
        return {
          name: 'veeam-config',
          severity: 'warn',
          message: 'secrets-store probe failed during veeam-config check',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (u === null || u.length === 0 || p === null || p.length === 0) {
        missing.push(host);
      }
    }

    if (missing.length === 0) {
      return {
        name: 'veeam-config',
        severity: 'ok',
        message: `Veeam configured for ${hosts.size} host(s)`,
      };
    }
    return {
      name: 'veeam-config',
      severity: 'warn',
      message: `Veeam credentials missing for ${missing.length} of ${hosts.size} host(s)`,
      detail: missing.join(', '),
      hint: 'Run: claude-os secrets set veeam/<host>/username <user> AND veeam/<host>/password <pwd> for each',
    };
  });
}

/**
 * Sophos-Bridges config pre-flight (ADR-0042, Phase 7-D).
 *
 * Same shape as `checkVeeamConfig`: enumerates per-customer firewall
 * hostnames, verifies `sophos/<host>/{username,password}` are in the
 * secrets-backend for each. Never fails (Sophos is optional).
 */
export async function checkSophosConfig(
  opts: {
    readonly vaultRoot?: string;
    readonly secretsProbe?: (key: string) => Promise<string | null>;
    readonly listSlugsFn?: (vaultRoot: string) => readonly string[];
    readonly getCustomerFn?: (
      vaultRoot: string,
      slug: string,
    ) => Promise<{
      readonly bridges?: { readonly sophos?: { readonly firewallHostname: string } };
    } | null>;
  } = {},
): Promise<CheckResult> {
  return timed('sophos-config', async () => {
    let vaultRoot = opts.vaultRoot;
    if (vaultRoot === undefined) {
      try {
        const { resolveRoot } = await import('../environment/index.js');
        const root = resolveRoot();
        vaultRoot = join(root.path, 'vault');
      } catch (err) {
        return {
          name: 'sophos-config',
          severity: 'ok' as const,
          message: 'vault unreachable — Sophos check skipped',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    let slugs: readonly string[];
    try {
      if (opts.listSlugsFn !== undefined) {
        slugs = opts.listSlugsFn(vaultRoot);
      } else {
        const { listCustomerSlugs } = await import('../../domains/msp-customers/paths.js');
        slugs = listCustomerSlugs(vaultRoot);
      }
    } catch (err) {
      return {
        name: 'sophos-config',
        severity: 'warn',
        message: 'failed to enumerate customer-workspaces',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const hosts = new Set<string>();
    for (const slug of slugs) {
      let record: { bridges?: { sophos?: { firewallHostname: string } } } | null = null;
      try {
        if (opts.getCustomerFn !== undefined) {
          record = await opts.getCustomerFn(vaultRoot, slug);
        } else {
          const { CustomerRepository } = await import('../../domains/msp-customers/index.js');
          const repo = new CustomerRepository({ vaultRoot, autoCreate: false });
          record = await repo.get(slug);
        }
      } catch {
        continue;
      }
      const host = record?.bridges?.sophos?.firewallHostname;
      if (typeof host === 'string' && host.length > 0) hosts.add(host);
    }

    if (hosts.size === 0) {
      return {
        name: 'sophos-config',
        severity: 'ok',
        message: 'no customer-workspaces reference bridges.sophos (skipped)',
      };
    }

    const probe =
      opts.secretsProbe ??
      (async (k: string) => {
        const { createSecretStore } = await import('../../domains/secrets/index.js');
        return createSecretStore().get(k);
      });

    const missing: string[] = [];
    for (const host of hosts) {
      let u: string | null;
      let p: string | null;
      try {
        [u, p] = await Promise.all([
          probe(`sophos/${host}/username`),
          probe(`sophos/${host}/password`),
        ]);
      } catch (err) {
        return {
          name: 'sophos-config',
          severity: 'warn',
          message: 'secrets-store probe failed during sophos-config check',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (u === null || u.length === 0 || p === null || p.length === 0) {
        missing.push(host);
      }
    }

    if (missing.length === 0) {
      return {
        name: 'sophos-config',
        severity: 'ok',
        message: `Sophos configured for ${hosts.size} host(s)`,
      };
    }
    return {
      name: 'sophos-config',
      severity: 'warn',
      message: `Sophos credentials missing for ${missing.length} of ${hosts.size} host(s)`,
      detail: missing.join(', '),
      hint: 'Run: claude-os secrets set sophos/<host>/username <user> AND sophos/<host>/password <pwd> for each',
    };
  });
}

/**
 * Securepoint USC config pre-flight (ADR-0043, Phase 7-D.2).
 *
 * Single MSP-wide API key. Three states:
 *  - no customer has bridges.securepoint     → ok (skipped)
 *  - has-customer AND apiKey in secrets      → ok
 *  - has-customer but no apiKey              → warn
 *
 * Never fails — Securepoint is optional.
 */
export async function checkSecurepointConfig(
  opts: {
    readonly vaultRoot?: string;
    readonly secretsProbe?: (key: string) => Promise<string | null>;
    readonly listSlugsFn?: (vaultRoot: string) => readonly string[];
    readonly getCustomerFn?: (
      vaultRoot: string,
      slug: string,
    ) => Promise<{
      readonly bridges?: { readonly securepoint?: { readonly deviceId: string } };
    } | null>;
  } = {},
): Promise<CheckResult> {
  return timed('securepoint-config', async () => {
    let vaultRoot = opts.vaultRoot;
    if (vaultRoot === undefined) {
      try {
        const { resolveRoot } = await import('../environment/index.js');
        const root = resolveRoot();
        vaultRoot = join(root.path, 'vault');
      } catch (err) {
        return {
          name: 'securepoint-config',
          severity: 'ok' as const,
          message: 'vault unreachable — Securepoint check skipped',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    let slugs: readonly string[];
    try {
      if (opts.listSlugsFn !== undefined) {
        slugs = opts.listSlugsFn(vaultRoot);
      } else {
        const { listCustomerSlugs } = await import('../../domains/msp-customers/paths.js');
        slugs = listCustomerSlugs(vaultRoot);
      }
    } catch (err) {
      return {
        name: 'securepoint-config',
        severity: 'warn',
        message: 'failed to enumerate customer-workspaces',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    let configuredCount = 0;
    for (const slug of slugs) {
      let record: { bridges?: { securepoint?: { deviceId: string } } } | null = null;
      try {
        if (opts.getCustomerFn !== undefined) {
          record = await opts.getCustomerFn(vaultRoot, slug);
        } else {
          const { CustomerRepository } = await import('../../domains/msp-customers/index.js');
          const repo = new CustomerRepository({ vaultRoot, autoCreate: false });
          record = await repo.get(slug);
        }
      } catch {
        continue;
      }
      if (record?.bridges?.securepoint?.deviceId) configuredCount += 1;
    }

    if (configuredCount === 0) {
      return {
        name: 'securepoint-config',
        severity: 'ok',
        message: 'no customer-workspaces reference bridges.securepoint (skipped)',
      };
    }

    const probe =
      opts.secretsProbe ??
      (async (k: string) => {
        const { createSecretStore } = await import('../../domains/secrets/index.js');
        return createSecretStore().get(k);
      });

    let apiKey: string | null;
    try {
      apiKey = await probe('securepoint/apiKey');
    } catch (err) {
      return {
        name: 'securepoint-config',
        severity: 'warn',
        message: 'secrets-store probe failed during securepoint-config check',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (apiKey === null || apiKey.length === 0) {
      return {
        name: 'securepoint-config',
        severity: 'warn',
        message: `${configuredCount} customer(s) reference bridges.securepoint but no API-Key in secrets-backend`,
        hint: 'Run: claude-os secrets set securepoint/apiKey <key>',
      };
    }

    return {
      name: 'securepoint-config',
      severity: 'ok',
      message: `Securepoint USC configured (${configuredCount} customer device(s))`,
    };
  });
}

/**
 * Server-mode signing-keypair pre-flight (ADR-0035).
 *
 * Returns `warn` if no keypair is initialized — that's the lazy
 * happy-path for Tauri-desktop where Yannik hasn't yet run
 * `claude-os signing init`. The signing-keypair is required ONLY
 * when actually promoting a skill or signing an MSP-write-approval-
 * token; not having it shouldn't fail the boot.
 *
 * Returns `ok` once both `claude-os-signing-private-key` +
 * `claude-os-signing-public-key` are present in the SecretStore.
 *
 * Skipped (returns `ok`) outside server-mode (no `CLAUDE_OS_AUTH_TOKEN`)
 * — Tauri-desktop has its own init-flow via the GUI.
 */
export async function checkSigningKeypair(
  env: NodeJS.ProcessEnv = process.env,
  factory?: () => Promise<{
    readonly hasPublic: boolean;
    readonly hasPrivate: boolean;
    readonly backend: string;
  }>,
): Promise<CheckResult> {
  return timed('signing-keypair', async () => {
    if (env.CLAUDE_OS_AUTH_TOKEN === undefined || env.CLAUDE_OS_AUTH_TOKEN.length === 0) {
      return {
        name: 'signing-keypair',
        severity: 'ok',
        message: 'not in server mode (skipped — initialize via GUI or `claude-os signing init`)',
      };
    }
    let info: { hasPublic: boolean; hasPrivate: boolean; backend: string };
    if (factory !== undefined) {
      info = await factory();
    } else {
      // Lazy-load to avoid pulling secrets+skill-lifecycle when this
      // check isn't relevant (e.g. Tauri-desktop default doctor-run).
      const { createSecretStore } = await import('../../domains/secrets/index.js');
      const { SIGNING_KEY_NAMES } = await import('../../domains/skill-lifecycle/index.js');
      const store = createSecretStore();
      const [priv, pub] = await Promise.all([
        store.get(SIGNING_KEY_NAMES.PRIVATE),
        store.get(SIGNING_KEY_NAMES.PUBLIC),
      ]);
      info = { hasPrivate: priv !== null, hasPublic: pub !== null, backend: store.backend };
    }
    if (info.hasPrivate && info.hasPublic) {
      return {
        name: 'signing-keypair',
        severity: 'ok',
        message: `keypair present (backend=${info.backend})`,
      };
    }
    if (!info.hasPrivate && !info.hasPublic) {
      return {
        name: 'signing-keypair',
        severity: 'warn',
        message: 'signing keypair not initialized',
        hint: 'Run: claude-os signing init (needed for skill-promote + MSP-write approval-tokens)',
      };
    }
    // Half-state — one key but not the other. `loadOrCreateSigningKeypair`
    // would regenerate but only on its next call; surface it as a fail
    // so doctor highlights the inconsistency.
    return {
      name: 'signing-keypair',
      severity: 'fail',
      message: 'signing keypair half-state (one of private/public missing — corruption)',
      hint: 'Run: claude-os signing rotate --confirm  (regenerates fresh keypair)',
    };
  });
}

/**
 * Server-mode user-store pre-flight (Phase Web-7-3, ADR-0036 draft).
 *
 * Three outcomes:
 *   - `ok` when `users.sqlite` is absent (single-user Stage-1 token-only)
 *     OR present and openable with the expected schema-version.
 *   - `fail` when the file is present but unreadable, corrupt, or the
 *     schema-version mismatches (autoRebuildOnSchemaDrift=false so a
 *     drift surfaces here rather than silently dropping users).
 *   - Skipped (returns `ok`) outside server-mode.
 *
 * `dataDirOverride` lets tests target a tmp dir; production uses
 * `resolveMachinePaths().dataDir`.
 */
export async function checkUserStore(
  opts: { readonly env?: NodeJS.ProcessEnv; readonly dataDirOverride?: string } = {},
): Promise<CheckResult> {
  return timed('user-store', async () => {
    const env = opts.env ?? process.env;
    if (env.CLAUDE_OS_AUTH_TOKEN === undefined || env.CLAUDE_OS_AUTH_TOKEN.length === 0) {
      return {
        name: 'user-store',
        severity: 'ok',
        message: 'not in server mode (skipped — multi-user Stage-2 is server-only)',
      };
    }
    const { resolveMachinePaths } = await import('../paths/index.js');
    const { resolveUsersDbPath, UserRepository } = await import('../../domains/users/index.js');
    const dataDir = opts.dataDirOverride ?? resolveMachinePaths({ env }).dataDir;
    const dbPath = resolveUsersDbPath(dataDir);
    if (!existsSync(dbPath)) {
      return {
        name: 'user-store',
        severity: 'ok',
        message: 'no users.sqlite (Stage-1 token-only — multi-user via "claude-os users create")',
      };
    }
    try {
      const repo = await UserRepository.open({ dataDir, autoRebuildOnSchemaDrift: false });
      const n = repo.countAll();
      repo.close();
      return {
        name: 'user-store',
        severity: 'ok',
        message: `users.sqlite ok (${n} user${n === 1 ? '' : 's'})`,
      };
    } catch (err) {
      return {
        name: 'user-store',
        severity: 'fail',
        message: 'users.sqlite present but unreadable',
        detail: err instanceof Error ? err.message : String(err),
        hint: 'Restore from backup, or re-init via "claude-os users create --email <e> --password <p>" after removing the corrupt file.',
      };
    }
  });
}

export async function checkWritePermission(rootPath: string): Promise<CheckResult> {
  return timed('write-permission', () => {
    try {
      accessSync(rootPath, fsConstants.W_OK);
      return Promise.resolve({
        name: 'write-permission',
        severity: 'ok',
        message: `Writable: ${rootPath}`,
      });
    } catch {
      return Promise.resolve({
        name: 'write-permission',
        severity: 'fail',
        message: `Root path is not writable: ${rootPath}`,
        hint: 'Check filesystem permissions, cloud-sync read-only state, or disk-full condition',
      });
    }
  });
}
