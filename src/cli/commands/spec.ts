import { parseArgs } from "node:util";
import { ApiPilotError } from "../../core/errors.js";
import { SpecIndex } from "../../core/spec/spec-index.js";
import { Workspace } from "../../core/workspace/workspace.js";
import { parseNumber } from "../args.js";
import { emit, pad, pluralise } from "../output.js";

/**
 * Discovery. Both commands read specs and touch no network, so neither one
 * loads the executor — which is the whole reason commands are split by their
 * dependency footprint rather than one file per verb.
 */

const SEARCH_HELP = `Usage:
  api-pilot search <query...> [options]

Finds operations across the indexed specs, ranked by relevance. The query is
natural language: "cancel a subscription" works.

Options:
      --limit <n>    how many hits to show (default: 10)
      --spec <path>  spec to search (repeatable; overrides the workspace list)
      --dir <path>   directory to search upward from (default: cwd)
      --json         machine-readable output
  -h, --help         show this help
`;

const DESCRIBE_HELP = `Usage:
  api-pilot describe <operationId> [options]

Shows one operation: its parameters, request body and responses, rendered
within a byte budget.

Options:
      --max-bytes <n>  output budget (default: 1024)
      --spec <path>    spec to read (repeatable; overrides the workspace list)
      --dir <path>     directory to search upward from (default: cwd)
      --json           machine-readable output
  -h, --help           show this help
`;

export async function search(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      limit: { type: "string" },
      spec: { type: "string", multiple: true },
      dir: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    emit(false, undefined, () => SEARCH_HELP);
    return;
  }

  // Joined rather than requiring quotes: `search cancel a subscription` is what
  // people type, and the ranker takes a sentence anyway.
  const query = positionals.join(" ").trim();
  if (query === "") {
    throw new ApiPilotError("INVALID_REQUEST", "search needs a query", {
      hint: 'For example: api-pilot search "cancel a subscription"',
    });
  }

  const index = await openIndex(values.spec, values.dir);
  const limit = values.limit === undefined ? 10 : parseNumber(values.limit, "--limit");
  const hits = index.search(query, limit);

  emit(
    values.json === true,
    {
      query,
      total: index.size,
      hits: hits.map((hit) => ({
        id: hit.operation.id,
        method: hit.operation.method,
        path: hit.operation.path,
        summary: hit.operation.summary,
        deprecated: hit.operation.deprecated,
        specId: hit.operation.specId,
        score: hit.score,
      })),
      warnings: index.warnings,
    },
    () => {
      if (hits.length === 0) {
        return `No operations matched "${query}" (${pluralise(index.size, "operation")} indexed).`;
      }
      const methodWidth = Math.max(...hits.map((h) => h.operation.method.length)) + 2;
      const pathWidth = Math.max(...hits.map((h) => h.operation.path.length)) + 2;
      return hits
        .map((hit) =>
          [
            pad(hit.operation.method, methodWidth),
            pad(hit.operation.path, pathWidth),
            hit.operation.summary ?? hit.operation.id,
            hit.operation.deprecated ? "  (deprecated)" : "",
          ].join(""),
        )
        .join("\n");
    },
  );
}

export async function describe(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      "max-bytes": { type: "string" },
      spec: { type: "string", multiple: true },
      dir: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help === true) {
    emit(false, undefined, () => DESCRIBE_HELP);
    return;
  }

  const id = positionals[0];
  if (id === undefined) {
    throw new ApiPilotError("INVALID_REQUEST", "describe needs an operation id", {
      hint: "Use `api-pilot search` to find one.",
    });
  }

  const index = await openIndex(values.spec, values.dir);
  const text = index.describe(id, {
    ...(values["max-bytes"] === undefined
      ? {}
      : { maxBytes: parseNumber(values["max-bytes"], "--max-bytes") }),
  });

  const operation = index.get(id);
  emit(
    values.json === true,
    {
      id: operation.id,
      method: operation.method,
      path: operation.path,
      summary: operation.summary,
      deprecated: operation.deprecated,
      specId: operation.specId,
      text,
      warnings: index.warnings,
    },
    () => text,
  );
}

/**
 * `--spec` replaces the configured list rather than adding to it — the flag is
 * for looking at a spec the workspace does not know about, and silently
 * searching four other specs at the same time would be a surprise.
 */
async function openIndex(
  specFlags: readonly string[] | undefined,
  dir: string | undefined,
): Promise<SpecIndex> {
  if (specFlags !== undefined && specFlags.length > 0) {
    return SpecIndex.fromPaths(specFlags);
  }

  const workspace = await Workspace.find(dir);
  if (workspace.specPaths.length === 0) {
    throw new ApiPilotError("CONFIG_INVALID", "No specs are configured for this workspace", {
      hint: "Add a `specs:` list to .apipilot/environments.yaml, or pass --spec <path>.",
    });
  }
  return SpecIndex.fromPaths(workspace.specPaths);
}
