/**
 * ProfileManager — multi-account workaround via `$ANTHROPIC_CONFIG_DIR`
 * sandboxing per ADR-0011 §43.
 *
 * Anthropic-CLI has no first-class profile switching. We emulate it by
 * spawning the binary with `ANTHROPIC_CONFIG_DIR=<profile-dir>` so each
 * profile has its own `.credentials.json` namespace.
 *
 * Profile layout:
 *   <dataRoot>/auth-profiles/<name>/         (one dir per profile)
 *   <dataRoot>/auth-active-profile.json      ({"active": "<name>"})
 *
 * `claude-os auth profile use <name>` does NOT abort existing claude.exe
 * sessions; it merely flips the marker. Future spawns (Phase 5h wiring
 * into the ai-command) read the marker and set ANTHROPIC_CONFIG_DIR
 * appropriately.
 *
 * @module @domains/auth/profile-manager
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AuthError,
  type AuthProfile,
  AuthProfileExistsError,
  AuthProfileMissingError,
} from './types.js';

interface ProfileManagerOpts {
  readonly dataRoot: string;
}

const PROFILES_DIR = 'auth-profiles';
const ACTIVE_FILE = 'auth-active-profile.json';
const NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

interface ActiveEnvelope {
  readonly active: string;
}

function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && NAME_PATTERN.test(name);
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export class ProfileManager {
  readonly dataRoot: string;

  constructor(opts: ProfileManagerOpts) {
    this.dataRoot = opts.dataRoot;
  }

  /** Absolute path of `<dataRoot>/auth-profiles/`. */
  profilesDir(): string {
    return join(this.dataRoot, PROFILES_DIR);
  }

  /** Absolute path of `<dataRoot>/auth-profiles/<name>/`. */
  configDirFor(name: string): string {
    if (!isValidName(name)) {
      throw new AuthError(`Invalid profile name "${name}". Allowed: [A-Za-z0-9._-], max 64 chars.`);
    }
    return join(this.profilesDir(), name);
  }

  /** Returns the active-profile marker file path. */
  activeMarkerPath(): string {
    return join(this.dataRoot, ACTIVE_FILE);
  }

  /** Reads the active marker. Returns null when none set. */
  active(): string | null {
    const path = this.activeMarkerPath();
    if (!existsSync(path)) return null;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).active;
    if (typeof value !== 'string' || !isValidName(value)) return null;
    return value;
  }

  /** Lists all profiles, marking which one is active. */
  list(): readonly AuthProfile[] {
    const dir = this.profilesDir();
    if (!existsSync(dir)) return [];
    const active = this.active();
    const entries: AuthProfile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!isValidName(entry.name)) continue;
      entries.push({
        name: entry.name,
        configDir: join(dir, entry.name),
        active: active === entry.name,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /** Creates an empty profile directory. */
  create(name: string): AuthProfile {
    const dir = this.configDirFor(name);
    if (existsSync(dir)) {
      throw new AuthProfileExistsError(`Profile "${name}" already exists at ${dir}`);
    }
    mkdirSync(dir, { recursive: true });
    return { name, configDir: dir, active: this.active() === name };
  }

  /** Deletes a profile directory. Refuses if profile doesn't exist. */
  delete(name: string): void {
    const dir = this.configDirFor(name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new AuthProfileMissingError(`Profile "${name}" does not exist`);
    }
    rmSync(dir, { recursive: true, force: true });
    if (this.active() === name) {
      const marker = this.activeMarkerPath();
      if (existsSync(marker)) rmSync(marker, { force: true });
    }
  }

  /** Marks a profile as active. Throws if it does not exist. */
  use(name: string): AuthProfile {
    const dir = this.configDirFor(name);
    if (!existsSync(dir)) {
      throw new AuthProfileMissingError(`Profile "${name}" does not exist — create it first`);
    }
    const envelope: ActiveEnvelope = { active: name };
    atomicWrite(this.activeMarkerPath(), JSON.stringify(envelope));
    return { name, configDir: dir, active: true };
  }

  /**
   * Returns the `$ANTHROPIC_CONFIG_DIR` value to inject into a child
   * claude.exe spawn — or null when no profile is active (the binary
   * uses its default location).
   */
  resolveEnvOverride(): string | null {
    const name = this.active();
    if (name === null) return null;
    const dir = join(this.profilesDir(), name);
    if (!existsSync(dir)) return null;
    return dir;
  }
}
