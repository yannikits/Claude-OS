/**
 * Net-Guard (Phase-5b Foundation per ADR-0034) — installiert
 * hostname-allowlist auf `globalThis.fetch` BEVOR der Skill geladen wird.
 *
 * **Scope-Cut (bewusst):**
 *
 * Patched (Phase-5b-Foundation):
 *   - `globalThis.fetch` — der einzige standardisierte HTTP-Client
 *     im modernen Node und der häufigste Exfil-Vektor für AI-generated
 *     Skills (Tooling wie `axios`/`node-fetch` würde Skill-Author
 *     manuell installieren — Promote-Review-Gate fängt das ab)
 *
 * NICHT patched (Phase-5c future):
 *   - `node:net.connect` / `node:tls.connect` — raw TCP. Per ADR-0034
 *     §"Phase-5b deferred". Skill-Author müsste low-level sockets
 *     bauen — ungewöhnlich für AI-generated code.
 *   - `node:http.request` / `node:https.request` — legacy HTTP-Client.
 *     Skill-Author kann theoretisch via `require('node:http').request`
 *     bypassen. Promote-Review-Gate muss das im Diff fangen.
 *   - `node:dgram` — UDP. Niedrig-priorisiert.
 *   - DNS-Tunneling — out-of-scope (würde DNS-Layer-Patching brauchen)
 *
 * **Defense-Statement (per ADR-0034):** die Sandbox ist defense-in-
 * depth. Process-Boundary + 30s-Timeout sind die ECHTE Security-
 * Boundary. Diese fetch-Allowlist ist der zusätzliche Layer der die
 * Common-Case-Exfil-Versuche stoppt.
 *
 * @module @domains/skill-lifecycle/sandbox/net-guard
 */

export class NetGuardError extends Error {
  constructor(
    public readonly host: string,
    public readonly api: string,
  ) {
    super(`net-guard: outbound connection to "${host}" via ${api} denied — not in allowlist`);
    this.name = 'NetGuardError';
  }
}

function normalizeHost(host: string): string {
  if (host === '*') return '*';
  const lower = host.toLowerCase();
  const colon = lower.indexOf(':');
  return colon === -1 ? lower : lower.slice(0, colon);
}

/**
 * Returns `true` if `host` is in `allowlist`. Exact-match;
 * `*`-Wildcard erlaubt alles (escape-hatch für trusted Skills —
 * sollte im Promote-Review explicit gerechtfertigt werden).
 */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeHost(host);
  if (normalized === '') return false;
  for (const entry of allowlist) {
    const normalizedEntry = normalizeHost(entry);
    if (normalizedEntry === '*') return true;
    if (normalizedEntry === normalized) return true;
  }
  return false;
}

function hostFromUrl(input: unknown): string | null {
  try {
    if (typeof input === 'string') {
      return new URL(input).hostname;
    }
    if (input instanceof URL) {
      return input.hostname;
    }
    // Request-like object with `.url` property (fetch accepts Request)
    if (
      typeof input === 'object' &&
      input !== null &&
      'url' in input &&
      typeof (input as { url: unknown }).url === 'string'
    ) {
      return new URL((input as { url: string }).url).hostname;
    }
  } catch {
    return null;
  }
  return null;
}

export interface InstalledNetGuard {
  /** Reverts `globalThis.fetch` to its original. Tests only. */
  readonly uninstall: () => void;
}

/**
 * Installs the net-guard. Call BEFORE importing the skill-script.
 *
 * `allowlist: []` → block all outbound fetch. `['*']` → escape-hatch,
 * blocks nothing (Promote-Review-Gate sollte das explicit forbidden
 * für quarantined-Skills).
 *
 * Returns `{uninstall}` for tests; real sandbox-worker never uninstalls.
 */
export function installNetGuard(allowlist: readonly string[]): InstalledNetGuard {
  const originalFetch = globalThis.fetch;
  const allowed = (host: string): boolean => hostAllowed(host, allowlist);

  const guardedFetch = (async (
    input: Parameters<typeof originalFetch>[0],
    init?: Parameters<typeof originalFetch>[1],
  ): Promise<Response> => {
    const host = hostFromUrl(input);
    if (host === null || !allowed(host)) {
      throw new NetGuardError(host ?? '<unparseable>', 'fetch');
    }
    return originalFetch(input, init);
  }) as typeof originalFetch;

  globalThis.fetch = guardedFetch;

  return {
    uninstall: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
