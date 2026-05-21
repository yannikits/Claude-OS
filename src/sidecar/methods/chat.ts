/**
 * Chat-Namespace RPCs: spawn / write / kill.
 * Split aus `sidecar/methods.ts` (M21). Nur registriert wenn
 * `ChatSessions` injected ist (v1.2 MVP).
 *
 * @module @sidecar/methods/chat
 */
import type { ChatSessions } from '../chat-sessions.js';
import type { RpcDispatcher } from '../rpc.js';
import { requireString } from './_shared.js';

export function registerChatMethods(dispatcher: RpcDispatcher, chat: ChatSessions): void {
  dispatcher.register('chat.spawn', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { args?: readonly string[] };
    const args = Array.isArray(params.args) ? params.args : [];
    return chat.spawn(args);
  });
  dispatcher.register('chat.write', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { sessionId?: string; input?: string };
    const sessionId = requireString(params.sessionId, 'sessionId', 'chat.write');
    if (typeof params.input !== 'string') {
      throw new Error('chat.write: params.input must be a string');
    }
    const { drained } = chat.write(sessionId, params.input);
    // m7: surface backpressure-status to RPC consumers — sie koennen
    // auf "drained:false" ein Slow-Down einlegen (chunked-write).
    return { ok: true as const, drained };
  });
  dispatcher.register('chat.kill', (rawParams: unknown) => {
    const params = (rawParams ?? {}) as { sessionId?: string };
    const sessionId = requireString(params.sessionId, 'sessionId', 'chat.kill');
    chat.kill(sessionId);
    return { ok: true as const };
  });
}
