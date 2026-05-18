import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const SIDECAR_FAILED_EVENT = 'sidecar://failed';

export interface SidecarFailedPayload {
  reason: string;
  strikes: number;
}

export async function rpcCall<T = unknown>(method: string, params: unknown = null): Promise<T> {
  return invoke<T>('rpc_call', { method, params });
}

export async function onSidecarFailed(
  handler: (payload: SidecarFailedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SidecarFailedPayload>(SIDECAR_FAILED_EVENT, (e) => handler(e.payload));
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
