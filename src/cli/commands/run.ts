import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ApiPilotError } from "../../core/errors.js";
import type { RequestBody } from "../../core/request/types.js";
import { type RunResult, replayRun, runRequest } from "../../core/run/run.js";
import { Workspace } from "../../core/workspace/workspace.js";
import { parseNumber } from "../args.js";
import { emit } from "../output.js";

/**
 * The two commands that put bytes on the wire. Both funnel into `core/run`, so
 * the policy gate, the redactor and the store see the same sequence either way.
 */

const CALL_HELP = `Usage:
  api-pilot call <METHOD> <url> [options]

Executes one request and prints a digest of the response. The URL may be
absolute, or relative to the environment's baseUrl, and may contain {{vars}}.

Options:
  -H, --header <k: v>    request header (repeatable)
      --body <text>      request body
      --body-file <path> request body read from a file
      --content-type <t> Content-Type for the body
  -e, --env <name>       environment to use (default: the workspace default)
      --confirm          approve a mutating call against a production environment
      --max-bytes <n>    digest budget (default: 2048)
      --dir <path>       directory to search upward from (default: cwd)
      --json             machine-readable output
  -h, --help             show this help

The full response body is stored, not printed. Use the handle with
\`api-pilot inspect\` to query it.
`;

const REPLAY_HELP = `Usage:
  api-pilot replay <handle> [options]

Re-runs a recorded call. What is replayed is the original *intent* — the
un-substituted URL, headers and body — so replaying against another
environment resolves that environment's variables and credentials.

Options:
  -e, --env <name>     environment to run against (default: the workspace default)
      --confirm        approve a mutating call against a production environment
      --max-bytes <n>  digest budget (default: 2048)
      --dir <path>     directory to search upward from (default: cwd)
      --json           machine-readable output
  -h, --help           show this help
`;

export async function call(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      header: { type: "string", short: "H", multiple: true },
      body: { type: "string" },
      "body-file": { type: "string" },
      "content-type": { type: "string" },
      env: { type: "string", short: "e" },
      confirm: { type: "boolean", default: false },
      "max-bytes": { type: "string" },
      dir: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    emit(false, undefined, () => CALL_HELP);
    return;
  }

  const [method, url] = positionals;
  if (method === undefined || url === undefined) {
    throw new ApiPilotError("INVALID_REQUEST", "call needs a method and a URL", {
      hint: "For example: api-pilot call GET /users",
    });
  }

  if (values.body !== undefined && values["body-file"] !== undefined) {
    throw new ApiPilotError("INVALID_REQUEST", "Use either --body or --body-file, not both.");
  }

  const workspace = await Workspace.find(values.dir);
  const body = await readBody(values.body, values["body-file"], values["content-type"]);

  const result = await runRequest(
    {
      method,
      url,
      headers: parseHeaders(values.header ?? []),
      ...(body === undefined ? {} : { body }),
    },
    workspace,
    {
      ...(values.env === undefined ? {} : { environment: values.env }),
      confirmed: values.confirm === true,
      ...(values["max-bytes"] === undefined
        ? {}
        : { digestMaxBytes: parseNumber(values["max-bytes"], "--max-bytes") }),
    },
  );

  render(result, values.json === true);
}

export async function replay(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      env: { type: "string", short: "e" },
      confirm: { type: "boolean", default: false },
      "max-bytes": { type: "string" },
      dir: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    emit(false, undefined, () => REPLAY_HELP);
    return;
  }

  const handle = positionals[0];
  if (handle === undefined) {
    throw new ApiPilotError("INVALID_REQUEST", "replay needs a response handle", {
      hint: "Run `api-pilot history` to see the handles that still exist.",
    });
  }

  const workspace = await Workspace.find(values.dir);
  const result = await replayRun(handle, workspace, {
    ...(values.env === undefined ? {} : { environment: values.env }),
    confirmed: values.confirm === true,
    ...(values["max-bytes"] === undefined
      ? {}
      : { digestMaxBytes: parseNumber(values["max-bytes"], "--max-bytes") }),
  });

  render(result, values.json === true);
}

function render(result: RunResult, asJson: boolean): void {
  emit(
    asJson,
    {
      handle: result.meta.handle,
      environment: result.environmentName,
      status: result.meta.status,
      statusText: result.meta.statusText,
      url: result.meta.request.url,
      method: result.meta.request.method,
      durationMs: result.meta.durationMs,
      attempts: result.meta.attempts,
      bodyBytes: result.meta.bodyBytes,
      bodyTruncated: result.meta.bodyTruncated,
      redirects: result.meta.redirects,
      digest: result.digest.text,
    },
    () => result.digest.text,
  );
}

/** `-H "Name: value"`, the curl spelling, because that is what fingers already type. */
function parseHeaders(raw: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of raw) {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new ApiPilotError("INVALID_REQUEST", `Malformed header: "${entry}"`, {
        hint: 'Headers look like -H "Accept: application/json".',
      });
    }
    headers[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return headers;
}

async function readBody(
  inline: string | undefined,
  file: string | undefined,
  contentType: string | undefined,
): Promise<RequestBody | undefined> {
  const content =
    inline ??
    (file === undefined
      ? undefined
      : await readFile(file, "utf8").catch((cause: unknown) => {
          throw new ApiPilotError("INVALID_REQUEST", `Could not read --body-file ${file}`, {
            cause,
          });
        }));

  if (content === undefined) return undefined;
  return { kind: "text", content, ...(contentType === undefined ? {} : { contentType }) };
}
