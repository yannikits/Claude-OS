/**
 * SourceResolver — parses the three catalog source-string formats per
 * ADR-0009 §31.
 *
 * Pure function — no FS or network. Phase 5f marketplace-registry and
 * Phase 5h CLI `catalog install` consume the parsed shape.
 *
 * Supported formats:
 *   marketplace:<name>:<plugin>         — resolved via marketplace registry
 *   github:<owner>/<repo>[@<ref>][:<subPath>]   — git tarball
 *   local:<absolute-or-relative-path>   — copy from FS
 *
 * @module @domains/catalog/source-resolver
 */
import { isAbsolute, resolve } from 'node:path';

export type SourceKind = 'marketplace' | 'github' | 'local';

export interface ParsedMarketplaceSource {
  readonly kind: 'marketplace';
  readonly raw: string;
  readonly marketplace: string;
  readonly plugin: string;
}

export interface ParsedGithubSource {
  readonly kind: 'github';
  readonly raw: string;
  readonly owner: string;
  readonly repo: string;
  /** Optional git ref (branch, tag, or sha). Defaults to repo HEAD. */
  readonly ref?: string;
  /** Optional sub-path inside the repo (for skill-pack installs). */
  readonly subPath?: string;
}

export interface ParsedLocalSource {
  readonly kind: 'local';
  readonly raw: string;
  /** Absolute path (resolved relative to cwd when input was relative). */
  readonly path: string;
}

export type ParsedSource = ParsedMarketplaceSource | ParsedGithubSource | ParsedLocalSource;

export class SourceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceParseError';
  }
}

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const REPO_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

interface ParseOpts {
  /** cwd for resolving relative `local:` paths. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

function parseMarketplace(remainder: string, raw: string): ParsedMarketplaceSource {
  const idx = remainder.indexOf(':');
  if (idx === -1) {
    throw new SourceParseError(
      `marketplace source must be "marketplace:<name>:<plugin>", got "${raw}"`,
    );
  }
  const marketplace = remainder.slice(0, idx);
  const plugin = remainder.slice(idx + 1);
  if (marketplace.length === 0 || plugin.length === 0) {
    throw new SourceParseError(`marketplace source has empty name or plugin: "${raw}"`);
  }
  if (!NAME_PATTERN.test(marketplace) || !NAME_PATTERN.test(plugin)) {
    throw new SourceParseError(`marketplace name and plugin must match [A-Za-z0-9._-]+: "${raw}"`);
  }
  return { kind: 'marketplace', raw, marketplace, plugin };
}

function parseGithub(remainder: string, raw: string): ParsedGithubSource {
  let body = remainder;
  let subPath: string | undefined;
  const subPathIdx = body.indexOf(':');
  if (subPathIdx !== -1) {
    subPath = body.slice(subPathIdx + 1);
    body = body.slice(0, subPathIdx);
    if (subPath.length === 0) {
      throw new SourceParseError(`github source has empty subPath: "${raw}"`);
    }
  }
  let ref: string | undefined;
  const refIdx = body.indexOf('@');
  if (refIdx !== -1) {
    ref = body.slice(refIdx + 1);
    body = body.slice(0, refIdx);
    if (ref.length === 0) {
      throw new SourceParseError(`github source has empty ref: "${raw}"`);
    }
  }
  const match = REPO_PATTERN.exec(body);
  if (match === null) {
    throw new SourceParseError(
      `github source must be "github:<owner>/<repo>[@ref][:subPath]", got "${raw}"`,
    );
  }
  const owner = match[1] as string;
  const repo = match[2] as string;
  return {
    kind: 'github',
    raw,
    owner,
    repo,
    ...(ref === undefined ? {} : { ref }),
    ...(subPath === undefined ? {} : { subPath }),
  };
}

function parseLocal(remainder: string, raw: string, cwd: string): ParsedLocalSource {
  if (remainder.length === 0) {
    throw new SourceParseError(`local source has empty path: "${raw}"`);
  }
  const path = isAbsolute(remainder) ? resolve(remainder) : resolve(cwd, remainder);
  return { kind: 'local', raw, path };
}

export function parseSource(input: string, opts: ParseOpts = {}): ParsedSource {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new SourceParseError('source string is empty');
  }
  const colon = trimmed.indexOf(':');
  if (colon === -1) {
    throw new SourceParseError(
      `source must start with "marketplace:", "github:", or "local:", got "${trimmed}"`,
    );
  }
  const scheme = trimmed.slice(0, colon);
  const remainder = trimmed.slice(colon + 1);
  const cwd = opts.cwd ?? process.cwd();
  switch (scheme) {
    case 'marketplace':
      return parseMarketplace(remainder, trimmed);
    case 'github':
      return parseGithub(remainder, trimmed);
    case 'local':
      return parseLocal(remainder, trimmed, cwd);
    default:
      throw new SourceParseError(
        `unknown source scheme "${scheme}"; expected marketplace|github|local`,
      );
  }
}

/**
 * Builds the GitHub tarball URL for a parsed source. Uses the
 * codeload host so the response is a direct tar.gz stream (no
 * api.github.com auth needed for public repos).
 */
export function githubTarballUrl(parsed: ParsedGithubSource): string {
  const ref = parsed.ref ?? 'HEAD';
  return `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${ref}`;
}
