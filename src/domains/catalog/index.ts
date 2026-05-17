/**
 * Catalog domain — Phase 5 (ADR-0009 + ADR-0010).
 *
 * @module @domains/catalog
 */
export {
  SourceParseError,
  githubTarballUrl,
  parseSource,
  type ParsedGithubSource,
  type ParsedLocalSource,
  type ParsedMarketplaceSource,
  type ParsedSource,
  type SourceKind,
} from './source-resolver.js';
export {
  TarballInstallError,
  installFromTarball,
  tarballCacheDirFor,
  type InstallResult,
} from './tarball-installer.js';
export {
  MarketplaceRegistry,
  MarketplaceRegistryError,
  fileLoader,
  type MarketplaceEntry,
  type MarketplacePlugin,
  type MarketplaceRegistryFile,
} from './marketplace-registry.js';
export {
  existsInAnyScope,
  mergeScopes,
  type Scope,
  type ScopedFile,
} from './scope-merger.js';
export {
  DEFAULT_TARBALL_RETENTION_MS,
  cleanTarballCache,
  type CleanResult,
} from './cache-cleaner.js';
