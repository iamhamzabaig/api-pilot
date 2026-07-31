import { capBytes } from "../body.js";
import { renderShape } from "../digest/shape.js";
import type { LoadedSpec } from "./document.js";
import type { OperationParameter, OperationRecord } from "./operations.js";
import { type SchemaShapeLimits, schemaToShape } from "./schema-shape.js";

/**
 * Renders one operation for a model to act on.
 *
 * Budgeted for the same reason the response digest is: dumping a dereferenced
 * OpenAPI operation is how you spend 8 KB explaining a two-field request. If
 * `describe` is not disciplined it re-creates the problem ADR-0002 exists to
 * avoid, one operation at a time.
 */

export const DEFAULT_DESCRIBE_MAX_BYTES = 1024;

const TRUNCATION_MARKER = "\n… description truncated";

export interface DescribeOptions {
  readonly maxBytes?: number;
  readonly limits?: SchemaShapeLimits;
}

interface DetailLevel {
  readonly body: SchemaShapeLimits;
  readonly responses: SchemaShapeLimits;
}

/**
 * Tried richest-first, like the response digest's detail levels — but the two
 * halves degrade at different rates on purpose.
 *
 * The request body is what a caller needs in order to construct the call; the
 * response is something they will see in full the moment they make it. So the
 * response schema gives up detail first, and the body keeps its fidelity until
 * there is no budget left at all.
 */
const LEVELS: readonly DetailLevel[] = [
  { body: { maxDepth: 4, maxFields: 16 }, responses: { maxDepth: 4, maxFields: 16 } },
  { body: { maxDepth: 4, maxFields: 16 }, responses: { maxDepth: 3, maxFields: 10 } },
  { body: { maxDepth: 4, maxFields: 16 }, responses: { maxDepth: 2, maxFields: 8 } },
  { body: { maxDepth: 3, maxFields: 12 }, responses: { maxDepth: 1, maxFields: 6 } },
  { body: { maxDepth: 2, maxFields: 8 }, responses: { maxDepth: 1, maxFields: 4 } },
  { body: { maxDepth: 1, maxFields: 4 }, responses: { maxDepth: 1, maxFields: 3 } },
];

export function describeOperation(
  operation: OperationRecord,
  spec: LoadedSpec,
  options: DescribeOptions = {},
): string {
  const maxBytes = options.maxBytes ?? DEFAULT_DESCRIBE_MAX_BYTES;
  const levels =
    options.limits === undefined ? LEVELS : [{ body: options.limits, responses: options.limits }];

  let text = "";
  for (const level of levels) {
    text = render(operation, spec, level);
    if (Buffer.byteLength(text, "utf8") <= maxBytes) break;
  }
  return capBytes(text, maxBytes, TRUNCATION_MARKER);
}

function render(operation: OperationRecord, spec: LoadedSpec, level: DetailLevel): string {
  const lines: string[] = [`${operation.method} ${operation.path}`];

  if (operation.summary !== undefined) lines.push(operation.summary);

  const facts: string[] = [`id: ${operation.id}`];
  if (operation.tags.length > 0) facts.push(`tags: ${operation.tags.join(", ")}`);
  if (operation.security.length > 0) facts.push(`auth: ${operation.security.join(", ")}`);
  if (operation.deprecated) facts.push("DEPRECATED");
  lines.push(facts.join(" · "));

  for (const location of ["path", "query", "header"] as const) {
    const block = renderParameters(operation.parameters, location, spec, level.body);
    if (block !== undefined) lines.push("", block);
  }

  if (operation.body !== undefined) {
    const shape = renderShape(schemaToShape(operation.body.schema, spec, level.body));
    const required = operation.body.required ? "required" : "optional";
    lines.push("", `body (${operation.body.contentType}, ${required}):`, indent(shape));
  }

  const responses = renderResponses(operation, spec, level.responses);
  if (responses !== undefined) lines.push("", responses);

  return lines.join("\n");
}

function renderParameters(
  parameters: readonly OperationParameter[],
  location: OperationParameter["in"],
  spec: LoadedSpec,
  limits: SchemaShapeLimits,
): string | undefined {
  const matching = parameters.filter((parameter) => parameter.in === location);
  if (matching.length === 0) return undefined;

  const rows = matching.map((parameter) => {
    const type = renderShape(
      schemaToShape(parameter.schema, spec, { ...limits, maxDepth: 1 }),
      "",
      {
        inline: true,
      },
    );
    const flag = parameter.required ? " required" : "";
    const note =
      parameter.description === undefined ? "" : ` — ${firstSentence(parameter.description)}`;
    return `  ${parameter.name}: ${type}${flag}${note}`;
  });

  return [`${location}:`, ...rows].join("\n");
}

function renderResponses(
  operation: OperationRecord,
  spec: LoadedSpec,
  limits: SchemaShapeLimits,
): string | undefined {
  if (operation.responses.length === 0) return undefined;

  // A model needs the success shape to plan its next call; the error statuses
  // matter only as a list of what can go wrong.
  const success = operation.responses.filter((response) => response.status.startsWith("2"));
  const others = operation.responses.filter((response) => !response.status.startsWith("2"));

  const lines = ["responses:"];
  for (const response of success) {
    // Rendered at zero indent and shifted afterwards, so the closing brace
    // lines up with the opening one.
    const shape = renderShape(schemaToShape(response.schema, spec, limits));
    lines.push(`  ${response.status} ${response.contentType ?? ""}`.trimEnd());
    if (shape !== "…" && shape !== "{}") lines.push(indent(shape, "    "));
  }
  if (others.length > 0) {
    lines.push(`  others: ${others.map((response) => response.status).join(", ")}`);
  }
  return lines.join("\n");
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** Descriptions in real specs run to paragraphs; one sentence is the useful part. */
function firstSentence(text: string): string {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  const stop = collapsed.indexOf(". ");
  const sentence = stop === -1 ? collapsed : collapsed.slice(0, stop + 1);
  return sentence.length > 120 ? `${sentence.slice(0, 117)}…` : sentence;
}
