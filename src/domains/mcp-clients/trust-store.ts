/**
 * M3 (2026-05-21 code-review): MCP-Server trust-list.
 *
 * Vorher: jeder neu in `mcp.json` aufgetauchte Server wurde beim
 * naechsten `mcp.clients.status`-Poll automatisch ge-spawnt + ge-probt.
 * Ein malicious mcp.json-Eintrag (z. B. uebernommen via supply-chain
 * eines anderen Tool-Konfigurations-Merges) konnte so eine arbitrary-
 * binary-execution triggern, bevor der User es ueberhaupt zu Gesicht
 * bekam.
 *
 * Fix: persistente trust-list unter `<dataDir>/mcp-trust.json`. Nur
 * acknowledged servers werden ge-probt. Live-probe gibt fuer
 * un-acknowledged servers `ProbeResult.kind = 'trust-required'` zurueck;
 * GUI rendert dann eine "Trust this server?"-Modal die `mcp.trust.
 * acknowledge(serverKey)` ruft.
 *
 * Trust-state Lifecycle:
 *  - First-seen: kein Eintrag in trust-store → `trust-required`
 *  - Acknowledged: `acknowledged[serverKey] = ISO-timestamp`
 *  - Revoked: `mcp.trust.revoke(serverKey)` → Eintrag entfernt
 *
 * Trust ist serverKey-scoped (typically `<host>:<entry.name>` aus
 * discovery), NICHT command-scoped — so wuerde ein neuer
 * binary-Pfad fuer denselben Namen den User RE-trusten lassen muessen.
 * Die `serverKey` Konvention wird vom Discovery-Layer bestimmt.
 *
 * @module @domains/mcp-clients/trust-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface McpTrustEnvelope {
  readonly version: 1;
  /** key = serverKey, value = ISO-timestamp wann acknowledged */
  readonly acknowledged: Readonly<Record<string, string>>;
}

const FORMAT_VERSION = 1;

export class McpTrustStore {
  readonly filePath: string;

  constructor(opts: { readonly filePath: string }) {
    this.filePath = opts.filePath;
  }

  private read(): McpTrustEnvelope {
    if (!existsSync(this.filePath)) {
      return { version: FORMAT_VERSION, acknowledged: {} };
    }
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        (parsed as { version?: unknown }).version !== FORMAT_VERSION ||
        typeof (parsed as { acknowledged?: unknown }).acknowledged !== 'object' ||
        (parsed as { acknowledged?: unknown }).acknowledged === null
      ) {
        // Malformed → behandle als leer. Pessimistic-by-default (alle
        // server muessen neu acknowledged werden).
        return { version: FORMAT_VERSION, acknowledged: {} };
      }
      return parsed as McpTrustEnvelope;
    } catch {
      return { version: FORMAT_VERSION, acknowledged: {} };
    }
  }

  private write(envelope: McpTrustEnvelope): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  /** true wenn `serverKey` bereits acknowledged ist. */
  isAcknowledged(serverKey: string): boolean {
    return serverKey in this.read().acknowledged;
  }

  /** Returns the ISO timestamp when `serverKey` was acknowledged, or null. */
  acknowledgedAt(serverKey: string): string | null {
    return this.read().acknowledged[serverKey] ?? null;
  }

  /**
   * Mark `serverKey` as trusted. Idempotent — falls schon acknowledged,
   * wird der timestamp NICHT ueberschrieben (preserves first-acknowledgement
   * fuer Audit-Trails).
   */
  acknowledge(serverKey: string, now: () => Date = () => new Date()): void {
    const env = this.read();
    if (serverKey in env.acknowledged) return;
    const next: McpTrustEnvelope = {
      version: FORMAT_VERSION,
      acknowledged: {
        ...env.acknowledged,
        [serverKey]: now().toISOString(),
      },
    };
    this.write(next);
  }

  /** Remove a server from the trust-list (forces re-acknowledgement). */
  revoke(serverKey: string): boolean {
    const env = this.read();
    if (!(serverKey in env.acknowledged)) return false;
    const next: Record<string, string> = { ...env.acknowledged };
    delete next[serverKey];
    this.write({ version: FORMAT_VERSION, acknowledged: next });
    return true;
  }

  /** List all acknowledged server-keys mit timestamps (frozen snapshot). */
  list(): readonly { readonly serverKey: string; readonly acknowledgedAt: string }[] {
    const env = this.read();
    return Object.entries(env.acknowledged)
      .map(([serverKey, acknowledgedAt]) => ({ serverKey, acknowledgedAt }))
      .sort((a, b) => a.serverKey.localeCompare(b.serverKey));
  }
}

/** Default-Pfad fuer den trust-store relativ zu `dataDir`. */
export function mcpTrustPathFor(dataDir: string): string {
  return `${dataDir}/mcp-trust.json`;
}
