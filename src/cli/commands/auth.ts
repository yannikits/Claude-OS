/**
 * `claude-os auth` — Anthropic-CLI auth + multi-profile (Phase 5h).
 *
 * Replaces the Phase 3a stub. Wires checkAuthState (Phase 5d) +
 * ProfileManager. `auth login` delegates to the resolved claude
 * binary (spawn `claude auth login`) since v1 never reimplements the
 * OAuth flow per ADR-0011 §75.
 *
 * @module @cli/commands/auth
 */
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { RootNotFoundError, resolveRoot } from '../../core/environment/index.js';
import { resolveMachinePaths } from '../../core/paths/index.js';
import { checkAuthState, isAuthError, ProfileManager } from '../../domains/auth/index.js';
import { BinaryNotFoundError, resolveClaudeBinary } from '../../domains/claude-bridge/index.js';
import { type GlobalOpts, printErr, printJson, printLine } from '../output.js';

function machinePaths(): ReturnType<typeof resolveMachinePaths> {
  return resolveMachinePaths();
}

function makeProfileManager(): ProfileManager {
  return new ProfileManager({ dataRoot: machinePaths().dataRoot });
}

async function actStatus(globals: GlobalOpts): Promise<void> {
  const profileMgr = makeProfileManager();
  const activeProfile = profileMgr.active();
  let binaryPath: string | undefined;
  try {
    const root = resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
    const binary = resolveClaudeBinary({ rootPath: root.path });
    binaryPath = binary.path;
  } catch (err) {
    if (!(err instanceof RootNotFoundError) && !(err instanceof BinaryNotFoundError)) throw err;
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  const override = profileMgr.resolveEnvOverride();
  if (override !== null) env.ANTHROPIC_CONFIG_DIR = override;
  const state = await checkAuthState({
    env,
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(activeProfile === null ? {} : { profile: activeProfile }),
  });
  if (globals.json === true) {
    printJson(state);
    return;
  }
  const marker = state.loggedIn ? '[OK]  ' : '[WARN]';
  printLine(`${marker} auth.status: source=${state.source}, loggedIn=${state.loggedIn}`);
  if (state.expiresAt !== undefined) printLine(`        expiresAt: ${state.expiresAt}`);
  if (state.scopes !== undefined) printLine(`        scopes:    ${state.scopes.join(', ')}`);
  if (state.profile !== undefined) printLine(`        profile:   ${state.profile}`);
  if (state.warning !== undefined) printLine(`        warning:   ${state.warning}`);
}

async function actLogin(globals: GlobalOpts): Promise<void> {
  let binaryPath: string;
  try {
    const root = resolveRoot(globals.root === undefined ? {} : { explicit: globals.root });
    const binary = resolveClaudeBinary({ rootPath: root.path });
    binaryPath = binary.path;
  } catch (err) {
    if (err instanceof BinaryNotFoundError || err instanceof RootNotFoundError) {
      printErr(`auth login: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const profileMgr = makeProfileManager();
  const override = profileMgr.resolveEnvOverride();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (override !== null) env.ANTHROPIC_CONFIG_DIR = override;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, ['auth', 'login'], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`claude auth login exited ${code}`));
    });
  }).catch((err) => {
    printErr(`auth login: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

function actProfileList(globals: GlobalOpts): void {
  const mgr = makeProfileManager();
  const profiles = mgr.list();
  if (globals.json === true) {
    printJson({ ok: true, profiles, active: mgr.active() });
    return;
  }
  if (profiles.length === 0) {
    printLine('(no profiles configured)');
    return;
  }
  for (const p of profiles) {
    printLine(`${p.active ? '*' : ' '} ${p.name}    ${p.configDir}`);
  }
}

function actProfileCreate(globals: GlobalOpts, name: string): void {
  const mgr = makeProfileManager();
  try {
    const profile = mgr.create(name);
    if (globals.json === true) {
      printJson({ ok: true, profile });
    } else {
      printLine(`[OK] created profile "${profile.name}" at ${profile.configDir}`);
      printLine(`     run \`claude-os auth profile use ${profile.name}\` to activate`);
    }
  } catch (err) {
    if (isAuthError(err)) {
      printErr(`auth profile create: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function actProfileUse(globals: GlobalOpts, name: string): void {
  const mgr = makeProfileManager();
  try {
    const profile = mgr.use(name);
    if (globals.json === true) {
      printJson({ ok: true, profile });
    } else {
      printLine(`[OK] active profile set to "${profile.name}"`);
      printLine(`     next claude.exe spawns will use ANTHROPIC_CONFIG_DIR=${profile.configDir}`);
    }
  } catch (err) {
    if (isAuthError(err)) {
      printErr(`auth profile use: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function actProfileDelete(globals: GlobalOpts, name: string): void {
  const mgr = makeProfileManager();
  try {
    mgr.delete(name);
    if (globals.json === true) {
      printJson({ ok: true, deleted: name });
    } else {
      printLine(`[OK] deleted profile "${name}"`);
    }
  } catch (err) {
    if (isAuthError(err)) {
      printErr(`auth profile delete: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Anthropic-CLI auth + multi-profile (ADR-0011)');

  auth
    .command('status')
    .description('Show current auth state')
    .action(async (_opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      await actStatus(globals);
    });

  auth
    .command('login')
    .description('Delegate to `claude auth login` (Anthropic-owned OAuth flow)')
    .action(async (_opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOpts>();
      await actLogin(globals);
    });

  const profile = auth.command('profile').description('Multi-profile management');
  profile
    .command('list')
    .description('List profiles')
    .action((_opts: unknown, command: Command) => {
      actProfileList(command.optsWithGlobals<GlobalOpts>());
    });
  profile
    .command('create <name>')
    .description('Create a new profile dir under <dataRoot>/auth-profiles/')
    .action((name: string, _opts: unknown, command: Command) => {
      actProfileCreate(command.optsWithGlobals<GlobalOpts>(), name);
    });
  profile
    .command('use <name>')
    .description('Activate a profile')
    .action((name: string, _opts: unknown, command: Command) => {
      actProfileUse(command.optsWithGlobals<GlobalOpts>(), name);
    });
  profile
    .command('delete <name>')
    .description('Remove a profile dir + active marker if it was active')
    .action((name: string, _opts: unknown, command: Command) => {
      actProfileDelete(command.optsWithGlobals<GlobalOpts>(), name);
    });
}
