/**
 * MarketplaceRegistry — resolves `marketplace:<name>:<plugin>` source
 * strings to a concrete `github:` source per ADR-0009 §31.
 *
 * v1 ships the file-loader variant. The ETag-based URL fetch (so
 * registries can be hosted on the env-repo and updated like skills)
 * is staged for a Phase 5h tail or Phase 6 sidecar — the API here is
 * already structured to accept an async loader.
 *
 * Registry JSON shape:
 *   {
 *     "version": 1,
 *     "marketplaces": {
 *       "<name>": {
 *         "source": "github:owner/repo",
 *         "ref": "main",
 *         "plugins": {
 *           "<plugin>": {"path": "sub/path"}
 *         }
 *       }
 *     }
 *   }
 *
 * @module @domains/catalog/marketplace-registry
 */
import { existsSync, readFileSync } from 'node:fs';
import { type ParsedGithubSource, parseSource, SourceParseError } from './source-resolver.js';

export interface MarketplaceRegistryFile {
  readonly version: 1;
  readonly marketplaces: Readonly<Record<string, MarketplaceEntry>>;
}

export interface MarketplaceEntry {
  readonly source: string;
  readonly ref?: string;
  readonly plugins: Readonly<Record<string, MarketplacePlugin>>;
}

export interface MarketplacePlugin {
  readonly path?: string;
}

export class MarketplaceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceRegistryError';
  }
}

export type RegistryLoader = () => Promise<MarketplaceRegistryFile> | MarketplaceRegistryFile;

interface RegistryOpts {
  readonly load: RegistryLoader;
}

function isMarketplacePlugin(value: unknown): value is MarketplacePlugin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.path !== undefined && typeof v.path !== 'string') return false;
  return true;
}

function isMarketplaceEntry(value: unknown): value is MarketplaceEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.source !== 'string') return false;
  if (v.ref !== undefined && typeof v.ref !== 'string') return false;
  if (v.plugins === null || typeof v.plugins !== 'object' || Array.isArray(v.plugins)) {
    return false;
  }
  for (const plugin of Object.values(v.plugins as Record<string, unknown>)) {
    if (!isMarketplacePlugin(plugin)) return false;
  }
  return true;
}

function isRegistryFile(value: unknown): value is MarketplaceRegistryFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (
    v.marketplaces === null ||
    typeof v.marketplaces !== 'object' ||
    Array.isArray(v.marketplaces)
  ) {
    return false;
  }
  for (const entry of Object.values(v.marketplaces as Record<string, unknown>)) {
    if (!isMarketplaceEntry(entry)) return false;
  }
  return true;
}

/**
 * Validates a raw JSON string against the registry shape. Used by both
 * `fileLoader` and `urlLoader` (Phase 5k) so the parse + structural
 * check is single-sourced.
 */
export function validateRegistry(raw: string, source: string): MarketplaceRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MarketplaceRegistryError(
      `registry ${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRegistryFile(parsed)) {
    throw new MarketplaceRegistryError(`registry ${source} has invalid shape`);
  }
  return parsed;
}

/** Returns a loader that reads + validates a JSON file at `path`. */
export function fileLoader(path: string): RegistryLoader {
  return () => {
    if (!existsSync(path)) {
      throw new MarketplaceRegistryError(`registry file does not exist: ${path}`);
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new MarketplaceRegistryError(
        `cannot read registry ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return validateRegistry(raw, path);
  };
}

export class MarketplaceRegistry {
  private readonly load: RegistryLoader;
  private cached: MarketplaceRegistryFile | null = null;

  constructor(opts: RegistryOpts) {
    this.load = opts.load;
  }

  /** Forces a reload on the next access. */
  invalidate(): void {
    this.cached = null;
  }

  /** Lists known marketplaces. */
  async marketplaces(): Promise<readonly string[]> {
    const registry = await this.snapshot();
    return Object.keys(registry.marketplaces).sort();
  }

  /** Lists plugins available in a marketplace, or throws if unknown. */
  async plugins(marketplace: string): Promise<readonly string[]> {
    const entry = await this.entry(marketplace);
    return Object.keys(entry.plugins).sort();
  }

  /**
   * Resolves `marketplace:<name>:<plugin>` to a concrete github source.
   * Plugin's `path` becomes the subPath. Entry's `ref` becomes the ref
   * when present.
   */
  async resolve(marketplace: string, plugin: string): Promise<ParsedGithubSource> {
    const entry = await this.entry(marketplace);
    const pluginEntry = entry.plugins[plugin];
    if (pluginEntry === undefined) {
      throw new MarketplaceRegistryError(
        `unknown plugin "${plugin}" in marketplace "${marketplace}"`,
      );
    }
    let parsed: ReturnType<typeof parseSource>;
    try {
      parsed = parseSource(entry.source);
    } catch (err) {
      throw new MarketplaceRegistryError(
        `marketplace "${marketplace}" has invalid source "${entry.source}": ` +
          (err instanceof SourceParseError ? err.message : String(err)),
      );
    }
    if (parsed.kind !== 'github') {
      throw new MarketplaceRegistryError(
        `marketplace "${marketplace}" source must be github:*, got ${parsed.kind}`,
      );
    }
    const ref = entry.ref ?? parsed.ref;
    const subPath = pluginEntry.path ?? parsed.subPath;
    return {
      kind: 'github',
      raw: `marketplace:${marketplace}:${plugin}`,
      owner: parsed.owner,
      repo: parsed.repo,
      ...(ref === undefined ? {} : { ref }),
      ...(subPath === undefined ? {} : { subPath }),
    };
  }

  private async entry(marketplace: string): Promise<MarketplaceEntry> {
    const registry = await this.snapshot();
    const entry = registry.marketplaces[marketplace];
    if (entry === undefined) {
      throw new MarketplaceRegistryError(`unknown marketplace "${marketplace}"`);
    }
    return entry;
  }

  private async snapshot(): Promise<MarketplaceRegistryFile> {
    if (this.cached !== null) return this.cached;
    const result = await this.load();
    this.cached = result;
    return result;
  }
}
