import { capBytes, decodeBody, formatBytes } from "../body.js";
import { ApiPilotError } from "../errors.js";
import type { HeaderPair } from "../exec/execute.js";
import type { Redactor } from "../redact/redactor.js";
import { queryPath } from "./json-path.js";

/**
 * The drill-down half of the bet. A digest tells a model what a response is;
 * inspect answers one specific question about it, still under a budget.
 *
 * Every path out of here is capped. There is deliberately no "give me the
 * whole body" mode without a byte budget — the store holds the full bytes for
 * code to read, not for a context window to swallow.
 */

export const DEFAULT_INSPECT_MAX_BYTES = 8192;

const TRUNCATION_MARKER = "\n… output truncated";

export interface InspectTarget {
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
}

export interface InspectOptions {
  /** JSONPath subset — see `parsePath`. Mutually exclusive with `range`. */
  readonly path?: string;
  /** Raw byte window, for binary bodies or targeted slices. */
  readonly range?: { readonly offset: number; readonly length: number };
  /** Return response headers instead of body content. */
  readonly headers?: boolean;
  readonly maxBytes?: number;
  /** Scrubs secrets an API reflected back at us. See `DigestOptions.redactor`. */
  readonly redactor?: Pick<Redactor, "redact">;
}

export interface InspectResult {
  readonly kind: "json" | "text" | "headers" | "bytes";
  readonly text: string;
  readonly truncated: boolean;
  /** Number of values the path matched. Absent unless `path` was used. */
  readonly matchCount?: number;
}

export function inspect(target: InspectTarget, options: InspectOptions = {}): InspectResult {
  const maxBytes = options.maxBytes ?? DEFAULT_INSPECT_MAX_BYTES;

  if (options.path !== undefined && options.range !== undefined) {
    throw new ApiPilotError("INVALID_REQUEST", "Use either `path` or `range`, not both.");
  }

  const result = (() => {
    if (options.headers === true) return renderHeaders(target.headers, maxBytes);
    if (options.range !== undefined) return renderRange(target.body, options.range, maxBytes);
    if (options.path !== undefined) return renderPath(target, options.path, maxBytes);
    return renderWholeBody(target, maxBytes);
  })();

  return redactResult(result, options.redactor, maxBytes);
}

/** Applied once at the exit, so no render path can forget it. */
function redactResult(
  result: InspectResult,
  redactor: Pick<Redactor, "redact"> | undefined,
  maxBytes: number,
): InspectResult {
  if (redactor === undefined) return result;
  const redacted = redactor.redact(result.text);
  const capped = capBytes(redacted, maxBytes, TRUNCATION_MARKER);
  return { ...result, text: capped, truncated: result.truncated || capped !== redacted };
}

function renderHeaders(headers: readonly HeaderPair[], maxBytes: number): InspectResult {
  const text = headers.map((h) => `${h.name}: ${h.value}`).join("\n");
  return finish("headers", text, maxBytes);
}

function renderRange(
  body: Uint8Array,
  range: { readonly offset: number; readonly length: number },
  maxBytes: number,
): InspectResult {
  if (!Number.isInteger(range.offset) || range.offset < 0) {
    throw new ApiPilotError("INVALID_REQUEST", `Range offset must be a non-negative integer.`);
  }
  if (!Number.isInteger(range.length) || range.length <= 0) {
    throw new ApiPilotError("INVALID_REQUEST", `Range length must be a positive integer.`);
  }

  const slice = body.subarray(range.offset, range.offset + Math.min(range.length, maxBytes));
  const decoded = decodeBody(slice, "text/plain");
  const text =
    decoded.kind === "text"
      ? decoded.text
      : // A window into a binary body, or one that cuts a multi-byte character
        // in half, is only meaningful as hex.
        `${Buffer.from(slice).toString("hex")}\n(${formatBytes(slice.byteLength)} of ${formatBytes(body.byteLength)} as hex)`;

  return finish("bytes", text, maxBytes);
}

function renderPath(target: InspectTarget, path: string, maxBytes: number): InspectResult {
  const decoded = decodeBody(target.body, findContentType(target.headers));
  if (decoded.kind !== "json") {
    throw new ApiPilotError(
      "INVALID_REQUEST",
      `Cannot query a ${decoded.kind} body with a path expression.`,
      { hint: "Use `range` for a byte window, or omit both to see the body." },
    );
  }

  const matches = queryPath(decoded.value, path);
  if (matches.length === 0) {
    return { kind: "json", text: `No matches for ${path}`, truncated: false, matchCount: 0 };
  }

  const payload = matches.length === 1 ? matches[0] : matches;
  const text = JSON.stringify(payload, null, 2) ?? String(payload);
  const capped = capBytes(text, maxBytes, TRUNCATION_MARKER);

  return {
    kind: "json",
    text: capped,
    truncated: capped !== text,
    matchCount: matches.length,
  };
}

function renderWholeBody(target: InspectTarget, maxBytes: number): InspectResult {
  const decoded = decodeBody(target.body, findContentType(target.headers));
  switch (decoded.kind) {
    case "empty":
      return { kind: "text", text: "(empty body)", truncated: false };
    case "binary":
      return renderRange(target.body, { offset: 0, length: maxBytes }, maxBytes);
    case "text":
      return finish("text", decoded.text, maxBytes);
    case "json":
      return finish("json", JSON.stringify(decoded.value, null, 2) ?? "", maxBytes);
  }
}

function finish(kind: InspectResult["kind"], text: string, maxBytes: number): InspectResult {
  const capped = capBytes(text, maxBytes, TRUNCATION_MARKER);
  return { kind, text: capped, truncated: capped !== text };
}

function findContentType(headers: readonly HeaderPair[]): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
}
