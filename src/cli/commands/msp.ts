/**
 * `claude-os msp` — operational CLI for the MSP-Health-Bridges.
 *
 * Phase 7-B ships `msp probe tanss <slug>` as the user-facing smoke
 * test. It does the full Production wiring (env-var server-URL,
 * secrets-backend apiToken, vault customer-repo) so a green probe here
 * proves the bridge is ready for the Phase-7-E aggregator.
 *
 * Output is intentionally compact — `--json` mirrors the BridgeProbe
 * shape 1:1 for machine consumers.
 *
 * @module @cli/commands/msp
 */
import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveRoot } from '../../core/environment/index.js';
import { SecurepointBridge } from '../../domains/msp-bridges/securepoint/index.js';
import { SophosBridge } from '../../domains/msp-bridges/sophos/index.js';
import type { SophosBridgeConfig } from '../../domains/msp-bridges/sophos/types.js';
import { TanssBridge } from '../../domains/msp-bridges/tanss/index.js';
import { VeeamBridge } from '../../domains/msp-bridges/veeam/index.js';
import type { VeeamCredentials } from '../../domains/msp-bridges/veeam/types.js';
import { CustomerRepository } from '../../domains/msp-customers/index.js';
import { createSecretStore, type SecretStore } from '../../domains/secrets/index.js';
import { type GlobalOpts, printErr, printJson, printLine } from '../output.js';

const TANSS_API_TOKEN_KEY = 'tanss/apiToken';

interface ProbeOpts {
  readonly serverUrl?: string;
  readonly timeoutMs?: string;
}

interface ProbeSophosOpts {
  readonly insecureTls?: boolean;
  readonly timeoutMs?: string;
}

interface ProbeSecurepointOpts {
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly timeoutMs?: string;
}

interface ProbeVeeamOpts {
  readonly apiVersion?: string;
  readonly insecureTls?: boolean;
  readonly timeoutMs?: string;
}

async function getVeeamCredsFromStore(
  store: SecretStore,
  host: string,
): Promise<VeeamCredentials | null> {
  const [username, password] = await Promise.all([
    store.get(`veeam/${host}/username`),
    store.get(`veeam/${host}/password`),
  ]);
  if (username === null || password === null) return null;
  return { username, password };
}

async function getSophosCredsFromStore(
  store: SecretStore,
  host: string,
): Promise<{ username: string; password: string } | null> {
  const [username, password] = await Promise.all([
    store.get(`sophos/${host}/username`),
    store.get(`sophos/${host}/password`),
  ]);
  if (username === null || password === null) return null;
  return { username, password };
}

function resolveVaultRoot(globals: GlobalOpts): string {
  const root = resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
  return join(root.path, 'vault');
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--timeout-ms must be a positive integer, got "${raw}"`);
  }
  return n;
}

async function actProbeTanss(slug: string, opts: ProbeOpts, command: Command): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOpts>();
  const json = globals.json === true;

  const serverUrl = opts.serverUrl ?? process.env.CLAUDE_OS_TANSS_SERVER_URL;
  if (serverUrl === undefined || serverUrl.length === 0) {
    printErr(
      'msp probe tanss: server-URL missing. Set $CLAUDE_OS_TANSS_SERVER_URL or pass --server-url <https://...>',
    );
    process.exit(2);
  }

  let timeoutMs: number | undefined;
  try {
    timeoutMs = parseTimeout(opts.timeoutMs);
  } catch (err) {
    printErr(`msp probe tanss: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const vaultRoot = resolveVaultRoot(globals);
  const repo = new CustomerRepository({ vaultRoot, autoCreate: false });
  const customer = await repo.get(slug);
  if (customer === null) {
    printErr(
      `msp probe tanss: customer "${slug}" not found at vault/workspaces/msp-customers/${slug}/`,
    );
    process.exit(1);
  }

  const store = createSecretStore();
  const bridge = new TanssBridge({
    serverUrl,
    getApiToken: () => store.get(TANSS_API_TOKEN_KEY),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  const probe = await bridge.probe(customer);

  if (json) {
    printJson(probe);
    process.exit(probe.result.kind === 'ok' ? 0 : 1);
  }

  printLine(`[${probe.result.kind === 'ok' ? 'OK' : 'FAIL'}] tanss.probe ${slug}`);
  printLine(`  bridgeKind=${probe.bridgeKind}  durationMs=${probe.durationMs}`);
  printLine(`  result.kind=${probe.result.kind}`);
  if (probe.result.kind === 'ok') {
    const { openCount, totalCount, newestUpdateAt, sample } = probe.result.data;
    printLine(`  openCount=${openCount}  totalCount=${totalCount}`);
    printLine(`  newestUpdateAt=${newestUpdateAt ?? '(none)'}`);
    if (sample !== null) {
      printLine(`  sample.id=${sample.id}  sample.status=${sample.status}`);
      printLine(`  sample.subject="${sample.subject}"`);
    }
  } else if ('message' in probe.result && probe.result.message !== undefined) {
    printLine(`  message=${probe.result.message}`);
  }

  process.exit(probe.result.kind === 'ok' ? 0 : 1);
}

async function actProbeVeeam(slug: string, opts: ProbeVeeamOpts, command: Command): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOpts>();
  const json = globals.json === true;

  let timeoutMs: number | undefined;
  try {
    timeoutMs = parseTimeout(opts.timeoutMs);
  } catch (err) {
    printErr(`msp probe veeam: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const vaultRoot = resolveVaultRoot(globals);
  const repo = new CustomerRepository({ vaultRoot, autoCreate: false });
  const customer = await repo.get(slug);
  if (customer === null) {
    printErr(
      `msp probe veeam: customer "${slug}" not found at vault/workspaces/msp-customers/${slug}/`,
    );
    process.exit(1);
  }
  if (!customer.bridges?.veeam) {
    printErr(`msp probe veeam: customer "${slug}" has no bridges.veeam in customer.yaml`);
    process.exit(1);
  }

  const insecureTls = opts.insecureTls === true || process.env.CLAUDE_OS_VEEAM_INSECURE_TLS === '1';
  if (insecureTls) {
    // Globally relax TLS verification for this CLI invocation only —
    // process exits right after the probe, so no spillover to other
    // long-running components. Matches the Veeam-default self-signed
    // cert use-case (per-customer VBR on-prem).
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const store = createSecretStore();
  const apiVersion = opts.apiVersion ?? process.env.CLAUDE_OS_VEEAM_API_VERSION;

  const bridge = new VeeamBridge({
    getCredentialsForHost: (host) => getVeeamCredsFromStore(store, host),
    ...(apiVersion !== undefined ? { apiVersion } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    insecureTls,
  });

  const probe = await bridge.probe(customer);

  if (json) {
    printJson(probe);
    process.exit(probe.result.kind === 'ok' ? 0 : 1);
  }

  printLine(`[${probe.result.kind === 'ok' ? 'OK' : 'FAIL'}] veeam.probe ${slug}`);
  printLine(`  bridgeKind=${probe.bridgeKind}  durationMs=${probe.durationMs}`);
  printLine(`  result.kind=${probe.result.kind}`);
  if (probe.result.kind === 'ok') {
    const d = probe.result.data;
    printLine(
      `  knownJobs=${d.knownJobs}  ok=${d.okCount}  warn=${d.warningCount}  failed=${d.failedCount}  running=${d.runningCount}`,
    );
    printLine(`  newestSuccessAt=${d.newestSuccessAt ?? '(none)'}`);
    printLine(`  oldestUnsuccessfulAt=${d.oldestUnsuccessfulAt ?? '(none)'}`);
    if (d.missingJobs.length > 0) {
      printLine(`  missingJobs=${d.missingJobs.join(', ')}  (renamed in Veeam UI?)`);
    }
    for (const r of d.latestRuns.slice(0, 5)) {
      printLine(`    [${r.state}] ${r.jobName}  endTimeUtc=${r.endTimeUtc ?? '(none)'}`);
    }
  } else if ('message' in probe.result && probe.result.message !== undefined) {
    printLine(`  message=${probe.result.message}`);
  }

  process.exit(probe.result.kind === 'ok' ? 0 : 1);
}

async function actProbeSophos(
  slug: string,
  opts: ProbeSophosOpts,
  command: Command,
): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOpts>();
  const json = globals.json === true;

  let timeoutMs: number | undefined;
  try {
    timeoutMs = parseTimeout(opts.timeoutMs);
  } catch (err) {
    printErr(`msp probe sophos: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const vaultRoot = resolveVaultRoot(globals);
  const repo = new CustomerRepository({ vaultRoot, autoCreate: false });
  const customer = await repo.get(slug);
  if (customer === null) {
    printErr(
      `msp probe sophos: customer "${slug}" not found at vault/workspaces/msp-customers/${slug}/`,
    );
    process.exit(1);
  }
  if (!customer.bridges?.sophos) {
    printErr(`msp probe sophos: customer "${slug}" has no bridges.sophos in customer.yaml`);
    process.exit(1);
  }

  const insecureTls =
    opts.insecureTls === true || process.env.CLAUDE_OS_SOPHOS_INSECURE_TLS === '1';
  if (insecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const store = createSecretStore();
  const bridgeCfg: SophosBridgeConfig = {
    getCredentialsForHost: (host) => getSophosCredsFromStore(store, host),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    insecureTls,
  };
  const bridge = new SophosBridge(bridgeCfg);

  const probe = await bridge.probe(customer);

  if (json) {
    printJson(probe);
    process.exit(probe.result.kind === 'ok' ? 0 : 1);
  }

  printLine(`[${probe.result.kind === 'ok' ? 'OK' : 'FAIL'}] sophos.probe ${slug}`);
  printLine(`  bridgeKind=${probe.bridgeKind}  durationMs=${probe.durationMs}`);
  printLine(`  result.kind=${probe.result.kind}`);
  if (probe.result.kind === 'ok') {
    const d = probe.result.data;
    printLine(
      `  firmware=${d.firmwareVersion}${d.firmwareType !== null ? ` (${d.firmwareType})` : ''}`,
    );
    printLine(
      `  license=${d.licenseSummary}` +
        (d.daysToEarliestExpiry !== null ? `  earliest-expiry=${d.daysToEarliestExpiry}d` : ''),
    );
    for (const s of d.subscriptions.slice(0, 6)) {
      printLine(
        `    [${s.status}] ${s.name}` +
          (s.expiresAt !== null
            ? `  exp=${s.expiresAt.slice(0, 10)}${s.daysRemaining !== null ? ` (${s.daysRemaining}d)` : ''}`
            : ''),
      );
    }
  } else if ('message' in probe.result && probe.result.message !== undefined) {
    printLine(`  message=${probe.result.message}`);
  }

  process.exit(probe.result.kind === 'ok' ? 0 : 1);
}

async function actProbeSecurepoint(
  slug: string,
  opts: ProbeSecurepointOpts,
  command: Command,
): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOpts>();
  const json = globals.json === true;

  let timeoutMs: number | undefined;
  try {
    timeoutMs = parseTimeout(opts.timeoutMs);
  } catch (err) {
    printErr(`msp probe securepoint: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const vaultRoot = resolveVaultRoot(globals);
  const repo = new CustomerRepository({ vaultRoot, autoCreate: false });
  const customer = await repo.get(slug);
  if (customer === null) {
    printErr(
      `msp probe securepoint: customer "${slug}" not found at vault/workspaces/msp-customers/${slug}/`,
    );
    process.exit(1);
  }
  if (!customer.bridges?.securepoint) {
    printErr(
      `msp probe securepoint: customer "${slug}" has no bridges.securepoint in customer.yaml`,
    );
    process.exit(1);
  }

  const store = createSecretStore();
  const baseUrl = opts.baseUrl ?? process.env.CLAUDE_OS_SECUREPOINT_BASE_URL;
  const apiVersion = opts.apiVersion ?? process.env.CLAUDE_OS_SECUREPOINT_API_VERSION;

  const bridge = new SecurepointBridge({
    getApiKey: () => store.get('securepoint/apiKey'),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiVersion !== undefined ? { apiVersion } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  const probe = await bridge.probe(customer);

  if (json) {
    printJson(probe);
    process.exit(probe.result.kind === 'ok' ? 0 : 1);
  }

  printLine(`[${probe.result.kind === 'ok' ? 'OK' : 'FAIL'}] securepoint.probe ${slug}`);
  printLine(`  bridgeKind=${probe.bridgeKind}  durationMs=${probe.durationMs}`);
  printLine(`  result.kind=${probe.result.kind}`);
  if (probe.result.kind === 'ok') {
    const d = probe.result.data;
    printLine(`  deviceId=${d.deviceId}  online=${d.online}`);
    printLine(
      `  license=${d.licenseStatus}` +
        (d.licenseDaysRemaining !== null ? `  days=${d.licenseDaysRemaining}` : ''),
    );
    if (d.additionalMetrics.length > 0) {
      printLine(`  +${d.additionalMetrics.length} additional metric(s)`);
      for (const m of d.additionalMetrics.slice(0, 5)) {
        printLine(`    ${m.name} = ${m.value}`);
      }
    }
  } else if ('message' in probe.result && probe.result.message !== undefined) {
    printLine(`  message=${probe.result.message}`);
  }

  process.exit(probe.result.kind === 'ok' ? 0 : 1);
}

export function registerMspCommand(program: Command): void {
  const msp = program
    .command('msp')
    .description('MSP-Health Read-Bridges (TANSS, Veeam, Sophos, Securepoint, M365)');

  const probe = msp.command('probe').description('Probe a bridge for one customer (read-only)');

  probe
    .command('tanss <slug>')
    .description('Probe the TANSS Read-Bridge for the customer with given slug')
    .option('--server-url <url>', 'Override $CLAUDE_OS_TANSS_SERVER_URL for this invocation')
    .option('--timeout-ms <ms>', 'Override request timeout (default 10000)')
    .action(async (slug: string, opts: ProbeOpts, command: Command) => {
      try {
        await actProbeTanss(slug, opts, command);
      } catch (err) {
        printErr(`msp probe tanss: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  probe
    .command('securepoint <slug>')
    .description('Probe the Securepoint USC Read-Bridge for the customer with given slug')
    .option(
      '--base-url <url>',
      'Override $CLAUDE_OS_SECUREPOINT_BASE_URL (default portal.securepoint.cloud)',
    )
    .option('--api-version <ver>', 'Override $CLAUDE_OS_SECUREPOINT_API_VERSION (default 2.2)')
    .option('--timeout-ms <ms>', 'Override request timeout (default 15000)')
    .action(async (slug: string, opts: ProbeSecurepointOpts, command: Command) => {
      try {
        await actProbeSecurepoint(slug, opts, command);
      } catch (err) {
        printErr(`msp probe securepoint: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  probe
    .command('sophos <slug>')
    .description('Probe the Sophos XG/XGS Firewall Read-Bridge for the customer with given slug')
    .option(
      '--insecure-tls',
      'Accept self-signed firewall cert (also via $CLAUDE_OS_SOPHOS_INSECURE_TLS=1)',
    )
    .option('--timeout-ms <ms>', 'Override request timeout (default 15000)')
    .action(async (slug: string, opts: ProbeSophosOpts, command: Command) => {
      try {
        await actProbeSophos(slug, opts, command);
      } catch (err) {
        printErr(`msp probe sophos: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  probe
    .command('veeam <slug>')
    .description('Probe the Veeam Read-Bridge for the customer with given slug')
    .option('--api-version <ver>', 'Override $CLAUDE_OS_VEEAM_API_VERSION (default 1.1-rev1)')
    .option(
      '--insecure-tls',
      'Accept self-signed VBR cert (else also via $CLAUDE_OS_VEEAM_INSECURE_TLS=1)',
    )
    .option('--timeout-ms <ms>', 'Override request timeout (default 15000)')
    .action(async (slug: string, opts: ProbeVeeamOpts, command: Command) => {
      try {
        await actProbeVeeam(slug, opts, command);
      } catch (err) {
        printErr(`msp probe veeam: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
