/**
 * Catalog domain — Phase 5 (ADR-0009 + ADR-0010).
 *
 * @module @domains/catalog
 */

export {
  type CleanResult,
  cleanTarballCache,
  DEFAULT_TARBALL_RETENTION_MS,
} from './cache-cleaner.js';
export {
  type Capability,
  type CapabilityKind,
  CapabilityParseError,
  type ComparisonOp,
  capabilityToString,
  compareVersions,
  parseCapability,
  satisfies,
  type VersionConstraint,
} from './capability.js';
export {
  AmbiguousProviderError,
  type Catalog,
  CyclicDependencyError,
  MissingProviderError,
  type PluginManifest,
  type ResolutionBinding,
  type ResolutionError,
  type ResolutionResult,
  ResolverError,
  resolveCapabilities,
  VersionConflictError,
} from './capability-resolver.js';
export {
  CATALOG_FILENAME,
  CATALOG_LOCK_FILENAME,
  catalogPathsFor,
  EMPTY_CATALOG,
  InvalidCatalogError,
  type RemoveEntryResult,
  readCatalog,
  readCatalogLock,
  removeCatalogEntry,
  type SetEnabledResult,
  setCatalogEntryEnabled,
  UnknownCatalogEntryError,
  writeCatalog,
  writeCatalogLock,
} from './catalog-store.js';
export {
  LockBuilderError,
  type LockBuilderOpts,
  type LockBuilderResult,
  lockCatalog,
} from './lock-builder.js';
export {
  fileLoader,
  type MarketplaceEntry,
  type MarketplacePlugin,
  MarketplaceRegistry,
  MarketplaceRegistryError,
  type MarketplaceRegistryFile,
  type RegistryLoader,
  validateRegistry,
} from './marketplace-registry.js';
export { type UrlLoaderOpts, urlLoader } from './marketplace-url-loader.js';
export {
  type CatalogConfig,
  CatalogConfigJsonSchema,
  CatalogConfigSchema,
  type CatalogEntry,
  CatalogEntryKindSchema,
  CatalogEntrySchema,
  type CatalogLock,
  type CatalogLockBinding,
  CatalogLockBindingSchema,
  type CatalogLockEntry,
  CatalogLockEntrySchema,
  CatalogLockJsonSchema,
  CatalogLockSchema,
  CatalogScopeSchema,
} from './schema.js';
export {
  existsInAnyScope,
  mergeScopes,
  type Scope,
  type ScopedFile,
} from './scope-merger.js';
export {
  githubTarballUrl,
  type ParsedGithubSource,
  type ParsedLocalSource,
  type ParsedMarketplaceSource,
  type ParsedSource,
  parseSource,
  type SourceKind,
  SourceParseError,
} from './source-resolver.js';
export {
  applyLock,
  installDestinationFor,
  mergeLockEntry,
  type SyncAppliedEntry,
  type SyncApplyOpts,
  type SyncApplyResult,
  type SyncError,
  type SyncSkipReason,
} from './sync-applier.js';
export {
  type InstallResult,
  installFromTarball,
  TarballInstallError,
  tarballCacheDirFor,
} from './tarball-installer.js';
