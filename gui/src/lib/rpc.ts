/**
 * RPC facade — the API surface is identical whether claude-os runs as
 * a Tauri-desktop app or as a server-served web-app. The runtime
 * detection happens once at module-init via `isTauriRuntime()`; every
 * helper below uses the routed `invoke()` and `listen()` shims declared
 * here. See ADR-0032 phase Web-2.
 */
import { createHttpTransport } from './rpc-http';
import { createTauriTransport } from './rpc-tauri';
import {
  type AuthCapableTransport,
  isAuthCapable,
  isTauriRuntime,
  type RpcTransport,
  type UnsubscribeFn,
} from './rpc-transport';

/** Backwards-compatible alias for the Tauri-API event-unsubscribe signature. */
export type UnlistenFn = UnsubscribeFn;

let transport: RpcTransport | null = null;

function getTransport(): RpcTransport {
  if (transport === null) {
    transport = isTauriRuntime() ? createTauriTransport() : createHttpTransport();
  }
  return transport;
}

/**
 * Get the active transport if it supports auth (HTTP build only). Returns
 * null in the Tauri build — the Tauri shell is the authenticated session.
 */
export function getAuthTransport(): AuthCapableTransport | null {
  const t = getTransport();
  return isAuthCapable(t) ? t : null;
}

/** Re-exported runtime check for AuthGate / Login-Page. */
export { isTauriRuntime };

/**
 * Tauri-flavoured `invoke` shim. `rpc_call` is the universal RPC entry
 * point and is routed through the transport. Other invoke-commands are
 * Tauri-shell-specific (drag-drop, native dialogs) and throw in web mode.
 */
async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (command === 'rpc_call') {
    const method = args.method as string;
    const params = args.params as unknown;
    return getTransport().call<T>(method, params);
  }
  if (!isTauriRuntime()) {
    throw new Error(`invoke('${command}'): only available in the Tauri desktop build`);
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command, args);
}

/**
 * Tauri-flavoured `listen` shim. Routes to the active transport's
 * `subscribe()` and wraps the handler so `e.payload` keeps the same
 * shape as `@tauri-apps/api/event#listen`.
 */
async function listen<T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return getTransport().subscribe<T>(eventName, (payload) => handler({ payload }));
}

export const SIDECAR_FAILED_EVENT = 'sidecar://failed';
export const SIDECAR_STDERR_EVENT = 'sidecar://stderr';

export interface SidecarFailedPayload {
  reason: string;
  strikes: number;
}

export interface SidecarStderrPayload {
  line: string;
}

export async function rpcCall<T = unknown>(method: string, params: unknown = null): Promise<T> {
  return invoke<T>('rpc_call', { method, params });
}

export async function onSidecarFailed(
  handler: (payload: SidecarFailedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SidecarFailedPayload>(SIDECAR_FAILED_EVENT, (e) => handler(e.payload));
}

export async function onSidecarStderr(
  handler: (payload: SidecarStderrPayload) => void,
): Promise<UnlistenFn> {
  return listen<SidecarStderrPayload>(SIDECAR_STDERR_EVENT, (e) => handler(e.payload));
}

export async function ping(): Promise<{ pong: boolean; ts: number }> {
  return rpcCall('ping');
}

export interface CatalogEntry {
  id: string;
  kind: 'skill' | 'plugin' | 'mcp';
  source: string;
  enabled: boolean;
  scope: 'user' | 'project';
}

export interface CatalogListResult {
  catalogPath: string;
  lockPath: string;
  lockResolvedAt: string | null;
  entries: CatalogEntry[];
}

export async function listCatalog(): Promise<CatalogListResult> {
  return rpcCall<CatalogListResult>('catalog.list');
}

export interface CatalogInstallAutoDepsInput {
  source: string;
  registryPath: string;
}

export interface CatalogInstallAutoDepsSuccess {
  ok: true;
  target: { id: string; version: string };
  newEntries: CatalogEntry[];
  iterations: number;
  catalogPath: string;
  lockPath: string;
  lockWarnings: string[];
  applied: number;
  skipped: number;
  errors: { id: string; message: string }[];
}

export interface CatalogInstallAutoDepsFailure {
  ok: false;
  code: string;
  message: string;
}

export type CatalogInstallAutoDepsResult =
  | CatalogInstallAutoDepsSuccess
  | CatalogInstallAutoDepsFailure;

export async function installCatalogAutoDeps(
  input: CatalogInstallAutoDepsInput,
): Promise<CatalogInstallAutoDepsResult> {
  return rpcCall<CatalogInstallAutoDepsResult>('catalog.installAutoDeps', input);
}

export type CatalogRemoveResult =
  | { ok: true; id: string; removedEntry: CatalogEntry }
  | { ok: false; code: 'unknown-id'; id: string; message: string };

export async function removeCatalogEntry(id: string): Promise<CatalogRemoveResult> {
  return rpcCall<CatalogRemoveResult>('catalog.removeEntry', { id });
}

// ---------- mcp.clients.* (v1.7 Phase A+B) ----------

export const MCP_CLIENT_EVENT = 'mcp-client://event';

export type McpProbeKind =
  | 'alive'
  | 'init-timeout'
  | 'crashed'
  | 'protocol-error'
  | 'spawn-failed'
  | 'trust-required';

export interface McpServerEntry {
  name: string;
  host: 'claude-desktop' | 'claude-code-user' | 'claude-code-project';
  sourcePath: string;
  command: string;
  args: string[];
  enabled?: boolean;
}

export type McpProbeResult =
  | { kind: 'alive'; toolsCount: number; durationMs: number; protocolVersion: string }
  | { kind: 'init-timeout'; durationMs: number; message: string }
  | { kind: 'crashed'; durationMs: number; exitCode: number | null; stderr: string }
  | { kind: 'protocol-error'; durationMs: number; message: string }
  | { kind: 'spawn-failed'; durationMs: number; message: string }
  | { kind: 'trust-required'; durationMs: number; serverKey: string; message: string };

export interface McpClientStatusEntry {
  key: string;
  entry: McpServerEntry;
  result: McpProbeResult;
  probedAt: string;
}

export interface McpClientsStatusResult {
  count: number;
  entries: McpClientStatusEntry[];
}

export interface McpClientEventPayload {
  type: 'tick-started' | 'tick-finished' | 'status-changed' | 'skip-overlap';
  timestamp: string;
  serverKey?: string;
  kind?: McpProbeKind;
  probedCount?: number;
  message?: string;
}

export async function getMcpClientsStatus(): Promise<McpClientsStatusResult> {
  return rpcCall<McpClientsStatusResult>('mcp.clients.status');
}

export type McpReprobeResult =
  | { ok: true; key: string; entry: McpServerEntry; result: McpProbeResult; probedAt: string }
  | { ok: false; code: 'unknown-server'; serverKey: string };

export async function reprobeMcpClient(serverKey: string): Promise<McpReprobeResult> {
  return rpcCall<McpReprobeResult>('mcp.clients.reprobe', { serverKey });
}

export async function onMcpClientEvent(
  handler: (e: McpClientEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<McpClientEventPayload>(MCP_CLIENT_EVENT, (e) => handler(e.payload));
}

// ---------- mcp.trust.* (M3 — trust-prompt-model, v1.x) ----------

export interface McpTrustEntry {
  serverKey: string;
  acknowledgedAt: string;
}

export interface McpTrustListResult {
  entries: McpTrustEntry[];
}

export interface McpTrustAckResult {
  ok: true;
  serverKey: string;
  acknowledgedAt: string | null;
}

export interface McpTrustRevokeResult {
  ok: true;
  serverKey: string;
  revoked: boolean;
}

export async function listMcpTrust(): Promise<McpTrustListResult> {
  return rpcCall<McpTrustListResult>('mcp.trust.list');
}

export async function acknowledgeMcpTrust(serverKey: string): Promise<McpTrustAckResult> {
  return rpcCall<McpTrustAckResult>('mcp.trust.acknowledge', { serverKey });
}

export async function revokeMcpTrust(serverKey: string): Promise<McpTrustRevokeResult> {
  return rpcCall<McpTrustRevokeResult>('mcp.trust.revoke', { serverKey });
}

export interface VaultBusyState {
  busy: boolean;
  reason: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface VaultConfig {
  conflictMode: 'abort' | 'prefer-local' | 'prefer-remote';
  scheduleEnabled: boolean;
  idleSeconds: number;
}

export interface VaultStatusResult {
  vaultPath: string;
  busy: VaultBusyState | null;
  config: VaultConfig;
}

export async function getVaultStatus(): Promise<VaultStatusResult> {
  return rpcCall<VaultStatusResult>('vault.status');
}

export interface AgentRunRecord {
  runId: string;
  project: string;
  machineId: string;
  timestamp: string;
  prompt: string;
}

export interface AgentListResult {
  count: number;
  items: AgentRunRecord[];
}

export async function listAgentRuns(
  opts: { project?: string; limit?: number } = {},
): Promise<AgentListResult> {
  return rpcCall<AgentListResult>('agent.list', opts);
}

export interface SettingsProfile {
  name: string;
  active: boolean;
  configDir: string;
}

export interface ClaudeCodeSettingsFile {
  scope: 'global' | 'project';
  name: 'settings.json' | 'settings.local.json';
  path: string;
  exists: boolean;
  mtime: string | null;
  size: number | null;
}

export interface SettingsReadResult {
  anthropic: {
    resolvedConfigDir: string;
    envOverride: string | null;
    activeProfile: string | null;
    availableProfiles: SettingsProfile[];
    credentialsFile: string;
    credentialsFileExists: boolean;
  };
  secrets: {
    backend: 'keyring' | 'encrypted-file';
    envOverride: string | null;
  };
  claudeCodeSettings: ClaudeCodeSettingsFile[];
}

export async function getSettings(): Promise<SettingsReadResult> {
  return rpcCall<SettingsReadResult>('settings.read');
}

export async function activateProfile(name: string): Promise<{ activeProfile: string }> {
  return rpcCall<{ activeProfile: string }>('settings.activateProfile', { name });
}

export interface ProfileCreateResult {
  name: string;
  configDir: string;
  active: boolean;
}

export async function createProfile(name: string): Promise<ProfileCreateResult> {
  return rpcCall<ProfileCreateResult>('settings.createProfile', { name });
}

export interface ProfileDeleteResult {
  name: string;
  deleted: boolean;
  configDir: string;
}

export async function deleteProfile(name: string): Promise<ProfileDeleteResult> {
  return rpcCall<ProfileDeleteResult>('settings.deleteProfile', { name });
}

export type SecretBackend = 'keyring' | 'encrypted-file';

export interface SecretMetadata {
  key: string;
  backend: SecretBackend;
}

export interface SecretsListResult {
  backend: SecretBackend;
  count: number;
  entries: SecretMetadata[];
  locked: boolean;
  lockedReason?: string;
}

export interface SecretsDeleteResult {
  key: string;
  deleted: boolean;
  backend: SecretBackend;
}

export interface SecretsSetResult {
  key: string;
  backend: SecretBackend;
  updated: boolean;
}

export async function listSecrets(): Promise<SecretsListResult> {
  return rpcCall<SecretsListResult>('secrets.list');
}

export async function deleteSecret(key: string): Promise<SecretsDeleteResult> {
  return rpcCall<SecretsDeleteResult>('secrets.delete', { key });
}

/**
 * Setzt einen Secret-Wert (create-or-update). Value geht durch Tauri-
 * IPC → Sidecar → SecretStore. Caller-Verantwortung:
 *   1. Wert NICHT in React-State persistieren (clear-on-submit)
 *   2. Backend-locked-Status (err.message === 'secrets-backend-locked')
 *      separat behandeln und UX-Hint zeigen
 *   3. NIEMALS den Value loggen
 */
export async function setSecret(key: string, value: string): Promise<SecretsSetResult> {
  return rpcCall<SecretsSetResult>('secrets.set', { key, value });
}

/**
 * v1.x.+2: setzt einen Secret-Wert via native OS-Dialog. Der Wert geht
 * NIE durch den Renderer-JS-Heap — Rust-side `set_secret_native` zeigt
 * den native password-dialog (tinyfiledialogs) und forwarded den Wert
 * direkt in `secrets.set` ueber den existing SidecarRpc-channel.
 *
 * Typed errors:
 *  - 'cancelled' — User hat den Dialog abgebrochen (kein UX-feedback noetig)
 *  - 'dialog-unavailable' — Linux ohne zenity/kdialog/matedialog/qarma;
 *    Frontend sollte auf den Inline-Mode aus PR #96 zurueckschalten
 *  - 'sidecar not available' — Sidecar nicht hochgefahren / abgestuerzt
 */
export async function setSecretNative(key: string): Promise<SecretsSetResult> {
  return invoke<SecretsSetResult>('set_secret_native', { key });
}

export const FILES_DROPPED_EVENT = 'files://dropped';
export const INBOX_CHANGED_EVENT = 'inbox://changed';
export const OUTBOX_CHANGED_EVENT = 'outbox://changed';

export interface FilesDroppedPayload {
  paths: string[];
}

export interface WatcherChangeEvent {
  event: 'add' | 'change' | 'unlink';
  path: string;
}

export interface InboxImportResult {
  count: number;
  paths: string[];
}

export async function importToInbox(paths: string[]): Promise<InboxImportResult> {
  return rpcCall<InboxImportResult>('inbox.import', { paths });
}

export async function onFilesDropped(
  handler: (p: FilesDroppedPayload) => void,
): Promise<UnlistenFn> {
  return listen<FilesDroppedPayload>(FILES_DROPPED_EVENT, (e) => handler(e.payload));
}

export async function onInboxChanged(
  handler: (e: WatcherChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<WatcherChangeEvent>(INBOX_CHANGED_EVENT, (e) => handler(e.payload));
}

export async function onOutboxChanged(
  handler: (e: WatcherChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<WatcherChangeEvent>(OUTBOX_CHANGED_EVENT, (e) => handler(e.payload));
}

// ---------- auth.* (v1.x.+1) ----------

export type AuthSource = 'cli' | 'file' | 'env' | 'no-creds';

export interface AuthStatusResult {
  loggedIn: boolean;
  source: AuthSource;
  expiresAt?: string;
  scopes?: string[];
  profile?: string;
  warning?: string;
}

export async function authStatus(): Promise<AuthStatusResult> {
  return rpcCall<AuthStatusResult>('auth.status');
}

export async function authLogin(opts: { cols?: number; rows?: number } = {}): Promise<{
  sessionId: string;
}> {
  return rpcCall<{ sessionId: string }>('auth.login', opts);
}

// ---------- pty.* (v1.x full-TTY) ----------

export const PTY_DATA_EVENT = 'pty.data';
export const PTY_EXIT_EVENT = 'pty.exit';

export interface PtySpawnResult {
  sessionId: string;
}

export interface PtyDataPayload {
  sessionId: string;
  /** Raw PTY-output: stdout+stderr merged, ANSI-Sequences inkl. */
  data: string;
}

export interface PtyExitPayload {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

export interface PtySpawnOpts {
  cols?: number;
  rows?: number;
}

export async function ptySpawn(
  args: readonly string[],
  opts: PtySpawnOpts = {},
): Promise<PtySpawnResult> {
  return rpcCall<PtySpawnResult>('pty.spawn', { args, ...opts });
}

export async function ptyWrite(sessionId: string, input: string): Promise<{ ok: true }> {
  return rpcCall<{ ok: true }>('pty.write', { sessionId, input });
}

export async function ptyResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<{ ok: true }> {
  return rpcCall<{ ok: true }>('pty.resize', { sessionId, cols, rows });
}

export async function ptyKill(sessionId: string): Promise<{ ok: true }> {
  return rpcCall<{ ok: true }>('pty.kill', { sessionId });
}

export async function onPtyData(handler: (p: PtyDataPayload) => void): Promise<UnlistenFn> {
  return listen<PtyDataPayload>(PTY_DATA_EVENT, (e) => handler(e.payload));
}

export async function onPtyExit(handler: (p: PtyExitPayload) => void): Promise<UnlistenFn> {
  return listen<PtyExitPayload>(PTY_EXIT_EVENT, (e) => handler(e.payload));
}

// ---------- chat.* (v1.2 MVP — kept for back-compat; deprecated in v1.x) ----------

export const CHAT_OUTPUT_EVENT = 'chat.output';
export const CHAT_EXIT_EVENT = 'chat.exit';

export interface ChatSpawnResult {
  sessionId: string;
}

export interface ChatOutputPayload {
  sessionId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface ChatExitPayload {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

export async function chatSpawn(args: readonly string[]): Promise<ChatSpawnResult> {
  return rpcCall<ChatSpawnResult>('chat.spawn', { args });
}

export async function chatWrite(sessionId: string, input: string): Promise<{ ok: true }> {
  return rpcCall<{ ok: true }>('chat.write', { sessionId, input });
}

export async function chatKill(sessionId: string): Promise<{ ok: true }> {
  return rpcCall<{ ok: true }>('chat.kill', { sessionId });
}

export async function onChatOutput(handler: (p: ChatOutputPayload) => void): Promise<UnlistenFn> {
  return listen<ChatOutputPayload>(CHAT_OUTPUT_EVENT, (e) => handler(e.payload));
}

export async function onChatExit(handler: (p: ChatExitPayload) => void): Promise<UnlistenFn> {
  return listen<ChatExitPayload>(CHAT_EXIT_EVENT, (e) => handler(e.payload));
}

// ---------- schedule.* (v1.5 Phase 3) ----------

export const SCHEDULE_EVENT = 'schedule://event';

export interface ScheduleEntry {
  id: string;
  cron: string;
  command: string;
  createdAt: string;
  enabled: boolean;
  description?: string;
  /** Naechste Feuer-Zeit als ISO-8601, oder null wenn nicht erreichbar.
   *  Nur aus schedule.list enriched zurueckgegeben — bei schedule.add/remove
   *  fehlt das Feld. */
  next?: string | null;
}

export interface ScheduleListResult {
  count: number;
  entries: ScheduleEntry[];
}

export interface SchedulerEventPayload {
  type: 'fire' | 'skip-overlap' | 'output' | 'exit' | 'parse-error';
  entryId: string;
  timestamp: string;
  stream?: 'stdout' | 'stderr';
  line?: string;
  exitCode?: number | null;
  signal?: string | null;
  message?: string;
}

export interface ScheduleAddInput {
  id: string;
  cron: string;
  command: string;
  description?: string;
  disabled?: boolean;
}

export interface ScheduleAddResult {
  entry: ScheduleEntry;
}

export async function listSchedules(): Promise<ScheduleListResult> {
  return rpcCall<ScheduleListResult>('schedule.list');
}

export async function addScheduleEntry(input: ScheduleAddInput): Promise<ScheduleAddResult> {
  return rpcCall<ScheduleAddResult>('schedule.add', input);
}

export async function removeScheduleEntry(id: string): Promise<{ id: string; removed: boolean }> {
  return rpcCall<{ id: string; removed: boolean }>('schedule.remove', { id });
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
): Promise<{ id: string; enabled: boolean }> {
  return rpcCall<{ id: string; enabled: boolean }>('schedule.setEnabled', { id, enabled });
}

export async function onSchedulerEvent(
  handler: (e: SchedulerEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<SchedulerEventPayload>(SCHEDULE_EVENT, (e) => handler(e.payload));
}

// ---------- workspace.* / notes.* / retrieval.* (Phase 2f — Memory MVP GUI) ----------

export const WORKSPACE_SWITCHED_EVENT = 'workspace://switched';

export type WorkspaceKind = 'personal' | 'msp-internal' | 'msp-customers' | 'unsorted';

export interface WorkspaceEntry {
  id: string;
  kind: WorkspaceKind;
  path: string | null;
}

export interface WorkspaceCurrent {
  active: string;
  kind: WorkspaceKind;
  switchedAt: string;
  path: string | null;
  vaultPath: string;
}

export interface WorkspaceList {
  active: string;
  vaultPath: string;
  workspaces: WorkspaceEntry[];
}

export interface WorkspaceUseResult {
  from: string;
  to: string;
  switchedAt: string;
}

export interface WorkspaceSwitchedPayload {
  from: string;
  to: string;
}

export async function getWorkspaceCurrent(): Promise<WorkspaceCurrent> {
  return rpcCall<WorkspaceCurrent>('workspace.current');
}

export async function getWorkspaceList(): Promise<WorkspaceList> {
  return rpcCall<WorkspaceList>('workspace.list');
}

export async function switchWorkspace(id: string): Promise<WorkspaceUseResult> {
  return rpcCall<WorkspaceUseResult>('workspace.use', { id });
}

export async function onWorkspaceSwitched(
  handler: (p: WorkspaceSwitchedPayload) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceSwitchedPayload>(WORKSPACE_SWITCHED_EVENT, (e) => handler(e.payload));
}

export type NoteClassification =
  | 'personal'
  | 'operational'
  | 'customer-confidential'
  | 'secret'
  | 'ephemeral';

export type NoteType = 'session' | 'skill-memory' | 'person' | 'project';

export interface NoteFrontmatter {
  workspace: string;
  classification: NoteClassification;
  schema_version: number;
  tenant?: string;
  created?: string;
  updated?: string;
  tags?: string[];
  type?: NoteType;
  [key: string]: unknown;
}

export interface NotesSaveInput {
  filename: string;
  body: string;
  frontmatter: Partial<NoteFrontmatter> & { classification: NoteClassification };
  workspace?: string;
  overwrite?: boolean;
}

export interface NotesSaveResult {
  path: string;
  created: boolean;
  workspace: string;
}

export interface NoteListItem {
  path: string;
  workspace: string;
  frontmatter: NoteFrontmatter;
  preview: string;
}

export async function saveNote(input: NotesSaveInput): Promise<NotesSaveResult> {
  return rpcCall<NotesSaveResult>('notes.save', input);
}

export async function listNotesByWorkspace(
  opts: { workspace?: string; recursive?: boolean; limit?: number } = {},
): Promise<NoteListItem[]> {
  return rpcCall<NoteListItem[]>('notes.list', opts);
}

export interface RetrievalHitDto {
  path: string;
  score: number;
  matchedTerms: string[];
  preview: string;
  frontmatter: NoteFrontmatter;
}

export interface RetrievalSearchResult {
  query: string;
  tokens: string[];
  hits: RetrievalHitDto[];
  totalScanned: number;
  durationMs: number;
  workspace: string;
}

export async function searchVault(opts: {
  text: string;
  workspace?: string;
  topK?: number;
  includeEphemeral?: boolean;
  recursive?: boolean;
}): Promise<RetrievalSearchResult> {
  return rpcCall<RetrievalSearchResult>('retrieval.search', opts);
}
