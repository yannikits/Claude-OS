import { createInterface } from 'node:readline';

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
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

  register(method: string, handler: RpcHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`RPC method already registered: ${method}`);
    }
    this.handlers.set(method, handler);
  }

  list(): string[] {
    return [...this.handlers.keys()].sort();
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
      } catch {
        // notification: fire-and-forget per JSON-RPC 2.0 §4.1
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
