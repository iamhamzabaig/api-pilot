import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * JSON-RPC 2.0 over stdio, which is the whole of the MCP transport: one JSON
 * object per line on stdin, one per line on stdout. See ADR-0004 for why this
 * is ~120 lines here rather than a dependency.
 *
 * **stdout belongs to the protocol.** A stray `console.log` anywhere under this
 * server corrupts the stream and the host disconnects with a parse error.
 * Diagnostics go to stderr; the CLI command that starts the server says so too.
 */

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type RpcId = string | number;

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/**
 * Returns the `result` for a request. Returning `undefined` is how a
 * notification handler says "nothing to send back"; for a request it is
 * serialised as `{}`, since JSON-RPC has no void result.
 */
export type MethodHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

interface ParsedMessage {
  readonly id: RpcId | undefined;
  readonly method: string;
  readonly params: unknown;
}

/**
 * Reads until `input` ends. Messages are dispatched as they arrive rather than
 * one at a time: a long `api_call` must not stall the host's `ping`, and since
 * every response is written as a single line, replies may interleave safely —
 * that is what the `id` is for.
 */
export async function serve(
  input: Readable,
  output: Writable,
  handle: MethodHandler,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const inFlight = new Set<Promise<void>>();

  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  for await (const line of lines) {
    if (line.trim() === "") continue;

    const parsed = parse(line);
    if (parsed instanceof RpcError) {
      // A message we could not parse has no id to answer with, so the error
      // carries a null one — the only place the spec allows that.
      send({ jsonrpc: "2.0", id: null, error: { code: parsed.code, message: parsed.message } });
      continue;
    }

    const task = dispatch(parsed, handle, send);
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }

  await Promise.all(inFlight);
}

async function dispatch(
  message: ParsedMessage,
  handle: MethodHandler,
  send: (message: unknown) => void,
): Promise<void> {
  const { id, method, params } = message;

  try {
    const result = await handle(method, params);
    // A notification gets no reply, however it went. That is not an oversight:
    // a host that sent one is not listening for an answer.
    if (id !== undefined) send({ jsonrpc: "2.0", id, result: result ?? {} });
  } catch (error) {
    if (id === undefined) return;
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: error instanceof RpcError ? error.code : INTERNAL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function parse(line: string): ParsedMessage | RpcError {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return new RpcError(PARSE_ERROR, "Parse error");
  }

  // Batches were removed from MCP in the 2025-06-18 revision; supporting them
  // would mean carrying a correlation buffer for a shape no host sends.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return new RpcError(INVALID_REQUEST, "Invalid Request");
  }

  const { jsonrpc, id, method, params } = value as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return new RpcError(INVALID_REQUEST, "Invalid Request");
  }

  return {
    id: typeof id === "string" || typeof id === "number" ? id : undefined,
    method,
    params,
  };
}
