import { z } from "zod";
import { ApiPilotError } from "../core/errors.js";
import { inspectRun } from "../core/inspect/inspect-run.js";
import { type RunResult, replayRun, runRequest } from "../core/run/run.js";
import { SpecIndex } from "../core/spec/spec-index.js";
import { ResponseStore } from "../core/store/response-store.js";
import {
  environmentView,
  historyView,
  inspectView,
  operationView,
  runView,
  searchView,
  workspaceView,
} from "../core/views.js";
import { Workspace } from "../core/workspace/workspace.js";

/**
 * The six tools of ADR-0002 and nothing else. A seventh requires a new ADR
 * naming what it displaces — the constraint is the product, not an oversight.
 *
 * Every handler is a few lines over `core`. If one starts growing logic, that
 * logic belongs in core where the CLI gets it too: two implementations of the
 * same sequence is how the redaction and policy guarantees drift apart.
 *
 * Descriptions are terse on purpose. All six definitions share a ≤ 1,500 token
 * budget (NFR N3) that a 500-operation spec must not move, and every word here
 * is paid for in every session before the model does anything at all.
 */

const Search = z.object({
  query: z.string().describe('Natural language, e.g. "cancel a subscription"'),
  limit: z.int().min(1).max(50).optional().describe("Max hits (default 10)"),
});

const Describe = z.object({
  operationId: z.string().describe("Id from api_search"),
  maxBytes: z.int().min(128).max(8192).optional().describe("Output budget (default 1024)"),
});

const Call = z.object({
  method: z.string().describe("GET, POST, …"),
  url: z.string().describe("Absolute, or relative to the environment baseUrl. May use {{vars}}"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  contentType: z.string().optional(),
  environment: z.string().optional().describe("Defaults to the workspace default"),
  confirm: z
    .boolean()
    .optional()
    .describe("Required for a mutating call against a production environment"),
  maxBytes: z.int().min(128).max(16384).optional().describe("Digest budget (default 2048)"),
});

const Inspect = z.object({
  handle: z.string().describe("From api_call or api_history"),
  path: z.string().optional().describe("JSONPath subset, e.g. data.items[0].id"),
  range: z.string().optional().describe("Byte window as offset:length"),
  headers: z.boolean().optional().describe("Return response headers instead of the body"),
  maxBytes: z.int().min(128).max(65536).optional().describe("Output budget (default 8192)"),
});

const History = z.object({
  action: z.enum(["list", "replay"]).optional().describe("Default list"),
  handle: z.string().optional().describe("Required for replay"),
  limit: z.int().min(1).max(100).optional().describe("Default 20"),
  method: z.string().optional(),
  status: z.int().optional(),
  urlContains: z.string().optional(),
  environment: z.string().optional().describe("replay: run against this environment instead"),
  confirm: z.boolean().optional().describe("replay: as api_call"),
});

const Env = z.object({
  name: z.string().optional().describe("Omit to list; give one to resolve it"),
});

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface Tool extends ToolDefinition {
  readonly handler: (args: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  /** Directory to search upward from for `.apipilot/`. Defaults to cwd. */
  readonly dir?: string;
}

export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: true;
}

const TOOL_LIST: readonly Tool[] = [
  {
    name: "api_search",
    description:
      "Find HTTP operations across the loaded OpenAPI specs. The usual sequence is " +
      "api_search, then api_describe, then api_call.",
    inputSchema: jsonSchema(Search),
    async handler(args, context) {
      const { query, limit } = Search.parse(args);
      const index = await openIndex(context);
      return json({
        ...searchView(query, index.size, index.search(query, limit ?? 10)),
        warnings: index.warnings,
      });
    },
  },
  {
    name: "api_describe",
    description:
      "One operation in full: parameters, request body, responses and auth, rendered " +
      "within a byte budget.",
    inputSchema: jsonSchema(Describe),
    async handler(args, context) {
      const { operationId, maxBytes } = Describe.parse(args);
      const index = await openIndex(context);
      return json({
        ...operationView(index.get(operationId)),
        text: index.describe(operationId, maxBytes === undefined ? {} : { maxBytes }),
        warnings: index.warnings,
      });
    },
  },
  {
    name: "api_call",
    description:
      "Execute one HTTP request. Returns a digest of the response and a handle — never " +
      "the full body. Use api_inspect on the handle to drill in.",
    inputSchema: jsonSchema(Call),
    async handler(args, context) {
      const input = Call.parse(args);
      const workspace = await Workspace.find(context.dir);
      return renderRun(
        await runRequest(
          {
            method: input.method,
            url: input.url,
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.body === undefined
              ? {}
              : {
                  body: {
                    kind: "text" as const,
                    content: input.body,
                    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
                  },
                }),
          },
          workspace,
          runOptions(input),
        ),
      );
    },
  },
  {
    name: "api_inspect",
    description:
      "Query one stored response by handle: a JSONPath subset, a byte range, or its " +
      "headers. Output is always capped; there is no full-body dump.",
    inputSchema: jsonSchema(Inspect),
    async handler(args, context) {
      const input = Inspect.parse(args);

      // Flags first, disk second: a mistyped range should report the typo, not
      // whatever the store happens to say about the handle.
      const options = {
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.range === undefined ? {} : { range: parseRange(input.range) }),
        ...(input.headers === true ? { headers: true } : {}),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      };

      const workspace = await Workspace.find(context.dir);
      const result = await inspectRun(input.handle, workspace, options);

      return {
        content: [textContent(stringify(inspectView(result))), textContent(fence(result.text))],
      };
    },
  },
  {
    name: "api_history",
    description: "List recorded runs, newest first, or replay one by handle.",
    inputSchema: jsonSchema(History),
    async handler(args, context) {
      const input = History.parse(args);
      const workspace = await Workspace.find(context.dir);

      if (input.action === "replay") {
        if (input.handle === undefined) {
          throw new ApiPilotError("INVALID_REQUEST", "replay needs a handle", {
            hint: "Call api_history with no action to see the handles that still exist.",
          });
        }
        return renderRun(await replayRun(input.handle, workspace, runOptions(input)));
      }

      const runs = await new ResponseStore(workspace.cacheDir).list({
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.urlContains === undefined ? {} : { urlContains: input.urlContains }),
      });

      return json({ runs: historyView(runs) });
    },
  },
  {
    name: "api_env",
    description:
      "List the declared environments, or resolve one. Secret values are never returned — " +
      "a variable backed by a secret reads as [redacted].",
    inputSchema: jsonSchema(Env),
    async handler(args, context) {
      const { name } = Env.parse(args);
      const workspace = await Workspace.find(context.dir);

      // Listing must not resolve secrets, or one unset variable hides every
      // environment from you.
      if (name === undefined) return json(workspaceView(workspace));

      return json({
        ...environmentView(await workspace.resolveEnvironment(name)),
        warnings: workspace.warnings,
      });
    },
  },
];

/** What `tools/list` serialises. Six, whatever the specs contain (ADR-0002). */
export const TOOLS: readonly ToolDefinition[] = TOOL_LIST.map(
  ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
);

export function hasTool(name: string): boolean {
  return TOOL_LIST.some((tool) => tool.name === name);
}

/**
 * A failing tool comes back as a result with `isError`, not as a JSON-RPC
 * error: the model is meant to read "host not allowed, add it to the
 * environment" and try again, and a transport-level error would be handled by
 * the host instead of reaching it.
 */
export async function callTool(
  name: string,
  args: unknown,
  context: ToolContext = {},
): Promise<ToolResult> {
  const tool = TOOL_LIST.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new ApiPilotError("NOT_FOUND", `No tool named "${name}"`);

  try {
    return await tool.handler(args ?? {}, context);
  } catch (error) {
    return {
      content: [textContent(stringify({ error: describeError(error) }))],
      isError: true,
    };
  }
}

const FENCE_OPEN = "<untrusted-api-response>";
const FENCE_CLOSE = "</untrusted-api-response>";

/**
 * A response body is data written by whoever runs that API, and it is being
 * handed to a model that can call tools. Fencing it says so.
 *
 * The fence is only worth anything if the body cannot close it, so an escaped
 * form of either tag is what goes inside — without this, a response containing
 * the closing tag would smuggle its own text out of the marked region.
 */
export function fence(text: string): string {
  const inner = text.split(FENCE_OPEN).join("&lt;untrusted-api-response&gt;");
  return [
    FENCE_OPEN,
    inner.split(FENCE_CLOSE).join("&lt;/untrusted-api-response&gt;"),
    FENCE_CLOSE,
  ].join("\n");
}

function renderRun(result: RunResult): ToolResult {
  return {
    content: [textContent(stringify(runView(result))), textContent(fence(result.digest.text))],
  };
}

function runOptions(input: {
  environment?: string | undefined;
  confirm?: boolean | undefined;
  maxBytes?: number | undefined;
}) {
  return {
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    confirmed: input.confirm === true,
    ...(input.maxBytes === undefined ? {} : { digestMaxBytes: input.maxBytes }),
  };
}

async function openIndex(context: ToolContext): Promise<SpecIndex> {
  const workspace = await Workspace.find(context.dir);
  if (workspace.specPaths.length === 0) {
    throw new ApiPilotError("CONFIG_INVALID", "No specs are configured for this workspace", {
      hint: "Add a `specs:` list to .apipilot/environments.yaml.",
    });
  }
  return SpecIndex.fromPaths(workspace.specPaths, { cacheDir: workspace.cacheDir });
}

function parseRange(raw: string): { offset: number; length: number } {
  const [offset, length] = raw.split(":");
  if (offset === undefined || length === undefined || length === "") {
    throw new ApiPilotError("INVALID_REQUEST", `range expects offset:length, got "${raw}"`);
  }
  const parsed = { offset: Number(offset), length: Number(length) };
  if (!Number.isFinite(parsed.offset) || !Number.isFinite(parsed.length)) {
    throw new ApiPilotError("INVALID_REQUEST", `range expects two numbers, got "${raw}"`);
  }
  return parsed;
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof z.ZodError) {
    return {
      code: "INVALID_REQUEST",
      message: error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }
  if (error instanceof ApiPilotError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    };
  }
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

/** One schema per tool, serving both the advertised contract and the parse. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}

function json(value: unknown): ToolResult {
  return { content: [textContent(stringify(value))] };
}

function textContent(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
