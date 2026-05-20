import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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

// ---------- mcp.clients.* (v1.7 Phase A+B) ----------

export const MCP_CLIENT_EVENT = 'mcp-client://event';

export type McpProbeKind = 'alive' | 'init-timeout' | 'crashed' | 'protocol-error' | 'spawn-failed';

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
  | { kind: 'spawn-failed'; durationMs: number; message: string };

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

export async function onMcpClientEvent(
  handler: (e: McpClientEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<McpClientEventPayload>(MCP_CLIENT_EVENT, (e) => handler(e.payload));
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

export async function listSecrets(): Promise<SecretsListResult> {
  return rpcCall<SecretsListResult>('secrets.list');
}

export async function deleteSecret(key: string): Promise<SecretsDeleteResult> {
  return rpcCall<SecretsDeleteResult>('secrets.delete', { key });
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

// ---------- chat.* (v1.2 MVP) ----------

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
