import { createInterface } from 'node:readline';

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
  /**
   * M8 (2026-05-21 code-review): optional shared-secret nonce. Wenn der
   * Dispatcher via `setExpectedNonce()` einen erwarteten Wert hat, MUSS
   * jeder Request diesen `nonce` mitsenden — andere local-Prozesse
   * koennen sonst potentiell stdio-MITM oder (in v1.7-HTTP-Transport-
   * Plaenen) HTTP-RPC machen ohne den Tauri-Supervisor-Handshake.
   */
  nonce?: string;
}

export interface RpcSuccessResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface RpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

export class RpcDispatcher {
  private handlers = new Map<string, RpcHandler>();
  /**
   * M8 (2026-05-21 code-review): wenn gesetzt, MUSS jeder eingehende
   * Wire-Request `nonce` mit diesem Wert mitsenden. `invoke()`
   * (in-process direct-call) ist NICHT betroffen — Tests + MCP-Server
   * sind im selben Prozess und brauchen keinen handshake.
   */
  private expectedNonce: string | null = null;

  register(method: string, handler: RpcHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`RPC method already registered: ${method}`);
    }
    this.handlers.set(method, handler);
  }

  /**
   * M8: aktiviert nonce-Pruefung fuer alle nachfolgenden `handle()`-
   * Calls. Vor diesem Call ist der Dispatcher offen (back-compat fuer
   * sidecar-Startup BEFORE handshake-write, in dem ping/shutdown noch
   * unauthenticated arbeiten muessen). Tauri-Supervisor liest den Nonce
   * aus dem stderr-handshake (`{"type":"sidecar-ready","nonce":"..."}`).
   */
  setExpectedNonce(nonce: string): void {
    if (nonce.length === 0) {
      throw new Error('setExpectedNonce: nonce must be a non-empty string');
    }
    this.expectedNonce = nonce;
  }

  list(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /**
   * Direct method invocation, bypassing the NDJSON envelope. Used by
   * non-stdio transports (MCP server, in-process tests) so they share the
   * same handler registry as the Tauri sidecar without re-implementing
   * domain plumbing.
   *
   * @throws {Error} when the method is unknown (`MethodNotFound`)
   * @throws whatever the handler throws (no JSON-RPC error-envelope wrap)
   */
  async invoke(method: string, params: unknown = null): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`MethodNotFound: ${method}`);
    return await handler(params);
  }

  async handle(line: string): Promise<RpcResponse | null> {
    let parsed: RpcRequest;
    try {
      parsed = JSON.parse(line) as RpcRequest;
    } catch {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
    }

    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: parsed.id ?? null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }

    // M8 (2026-05-21 code-review): nonce-Pruefung. Wenn der Dispatcher
    // einen expectedNonce hat, MUSS jeder Wire-Request ihn matchen.
    // -32001 ist der `serverError`-Range fuer Custom-Errors (JSON-RPC
    // 2.0 §5.1 reservedRange is -32099..-32000).
    if (this.expectedNonce !== null) {
      if (typeof parsed.nonce !== 'string' || parsed.nonce !== this.expectedNonce) {
        return {
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          error: { code: -32001, message: 'Invalid or missing nonce' },
        };
      }
    }

    const handler = this.handlers.get(parsed.method);
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id: parsed.id ?? null,
        error: { code: -32601, message: `Method not found: ${parsed.method}` },
      };
    }

    if (parsed.id === undefined) {
      try {
        await handler(parsed.params);
      } catch (err) {
        // M30 (2026-05-21 code-review): JSON-RPC §4.1 verlangt zwar
        // fire-and-forget fuer notifications, aber TypeError /
        // ReferenceError aus dem Handler sind Bugs die debugged werden
        // sollten. Wir loggen auf stderr (geht zum Tauri-Supervisor)
        // und verschlucken den Error trotzdem auf Wire-Ebene.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`rpc notification handler error (method=${parsed.method}): ${msg}`);
      }
      return null;
    }

    try {
      const result = await handler(parsed.params);
      return { jsonrpc: '2.0', id: parsed.id, result };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: parsed.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

export interface RpcServerOptions {
  dispatcher: RpcDispatcher;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function runRpcServer(opts: RpcServerOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const response = await opts.dispatcher.handle(line);
    if (response !== null) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
