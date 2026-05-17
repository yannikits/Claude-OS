/**
 * Environment domain — public API.
 *
 * @module @core/environment
 */
export { detectCloudProvider, resolveRoot } from './root-resolver.js';
export type { CloudProvider, ResolvedRoot, RootSource } from './types.js';
export { RootNotFoundError } from './types.js';
