import { parseArgs } from "node:util";
import { formatBytes } from "../../core/body.js";
import { ApiPilotError } from "../../core/errors.js";
import { inspect as inspectResponse } from "../../core/inspect/inspect.js";
import { ResponseStore } from "../../core/store/response-store.js";
import { historyView } from "../../core/views.js";
import { Workspace } from "../../core/workspace/workspace.js";
import { parseNumber } from "../args.js";
import { emit, pad, pluralise } from "../output.js";

/** The two read-only commands over the local store: what ran, and what came back. */

const HISTORY_HELP = `Usage:
  api-pilot history [options]

Lists recorded runs, newest first.

Options:
      --limit <n>      how many to show (default: 20)
      --method <verb>  only this HTTP method
      --status <code>  only this response status
      --url <text>     only runs whose URL contains this substring
      --dir <path>     directory to search upward from (default: cwd)
      --json           machine-readable output
  -h, --help           show this help
`;

const INSPECT_HELP = `Usage:
  api-pilot inspect <handle> [options]

Queries one stored response. Output is always capped — there is no full-body
dump, by design.

Options:
      --path <expr>    JSONPath subset, e.g. data.items[0].id
      --range <a:b>    byte window, offset:length
      --headers        show response headers instead of the body
      --max-bytes <n>  output budget (default: 8192)
      --dir <path>     directory to search upward from (default: cwd)
      --json           machine-readable output
  -h, --help           show this help

--path and --range are mutually exclusive.
`;

export async function history(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      limit: { type: "string" },
      method: { type: "string" },
      status: { type: "string" },
      url: { type: "string" },
      dir: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    emit(false, undefined, () => HISTORY_HELP);
    return;
  }

  const workspace = await Workspace.find(values.dir);
  const store = new ResponseStore(workspace.cacheDir);

  const runs = await store.list({
    ...(values.limit === undefined ? {} : { limit: parseNumber(values.limit, "--limit") }),
    ...(values.method === undefined ? {} : { method: values.method }),
    ...(values.status === undefined ? {} : { status: parseNumber(values.status, "--status") }),
    ...(values.url === undefined ? {} : { urlContains: values.url }),
  });

  emit(values.json === true, { runs: historyView(runs) }, () => {
    if (runs.length === 0) return "No runs recorded yet.";
    const handleWidth = Math.max(...runs.map((r) => r.handle.length)) + 2;
    return runs
      .map((run) =>
        [
          pad(run.handle, handleWidth),
          pad(String(run.status), 5),
          pad(run.request.method, 7),
          pad(`${Math.round(run.durationMs)} ms`, 9),
          pad(formatBytes(run.bodyBytes), 10),
          run.request.url,
        ].join(""),
      )
      .join("\n");
  });
}

export async function inspect(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      path: { type: "string" },
      range: { type: "string" },
      headers: { type: "boolean", default: false },
      "max-bytes": { type: "string" },
      dir: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    emit(false, undefined, () => INSPECT_HELP);
    return;
  }

  const handle = positionals[0];
  if (handle === undefined) {
    throw new ApiPilotError("INVALID_REQUEST", "inspect needs a response handle", {
      hint: "Run `api-pilot history` to see the handles that still exist.",
    });
  }

  // Flags are validated before any disk access, so a mistyped --range reports
  // the typo rather than whatever the store happens to say about the handle.
  const options = {
    ...(values.path === undefined ? {} : { path: values.path }),
    ...(values.range === undefined ? {} : { range: parseRange(values.range) }),
    ...(values.headers === true ? { headers: true } : {}),
    ...(values["max-bytes"] === undefined
      ? {}
      : { maxBytes: parseNumber(values["max-bytes"], "--max-bytes") }),
  };

  const workspace = await Workspace.find(values.dir);
  const store = new ResponseStore(workspace.cacheDir);
  const meta = await store.get(handle);
  const body = await store.readBody(handle);

  const result = inspectResponse({ headers: meta.headers, body }, options);

  emit(
    values.json === true,
    {
      handle,
      kind: result.kind,
      text: result.text,
      truncated: result.truncated,
      ...(result.matchCount === undefined ? {} : { matchCount: result.matchCount }),
    },
    () =>
      [
        result.text,
        ...(result.matchCount === undefined
          ? []
          : [`\n(${pluralise(result.matchCount, "match")})`]),
        ...(result.truncated ? ["\n(truncated to fit the output budget)"] : []),
      ].join(""),
  );
}

/** `offset:length`, matching the two numbers `InspectOptions.range` wants. */
function parseRange(raw: string): { offset: number; length: number } {
  const [offset, length] = raw.split(":");
  if (offset === undefined || length === undefined || length === "") {
    throw new ApiPilotError("INVALID_REQUEST", `--range expects offset:length, got "${raw}"`, {
      hint: "For example --range 0:512 for the first 512 bytes.",
    });
  }
  return { offset: parseNumber(offset, "--range"), length: parseNumber(length, "--range") };
}
