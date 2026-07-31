import { capBytes, type DecodedBody, decodeBody, formatBytes } from "../body.js";
import type { HeaderPair, HttpResponse } from "../exec/execute.js";
import type { Redactor } from "../redact/redactor.js";
import { inferShape, renderShape, type ShapeLimits } from "./shape.js";

/**
 * Turns a response into something a model can afford to read.
 *
 * The byte cap is a hard structural guarantee, not a target: render at the
 * richest detail level that fits, and truncate as a backstop if even the
 * poorest does not. Nothing here can exceed `maxBytes` (NFR N2).
 */

export const DEFAULT_DIGEST_MAX_BYTES = 2048;

const TRUNCATION_MARKER = "\n… digest truncated";

export interface DigestOptions {
  readonly maxBytes?: number;
  /** Store handle, so the reader knows what to pass to inspect. */
  readonly handle?: string;
  /**
   * Scrubs secrets an API reflected back at us. Services echo API keys in
   * error messages and `Location` headers more often than they should, and a
   * digest is one of the two paths that reaches a model.
   */
  readonly redactor?: Pick<Redactor, "redact">;
}

export interface Digest {
  /** The budgeted, model-facing rendering. Never exceeds `maxBytes`. */
  readonly text: string;
  readonly textBytes: number;
  readonly status: number;
  readonly bodyKind: DecodedBody["kind"];
  readonly bodyBytes: number;
  readonly contentType: string | undefined;
  readonly handle: string | undefined;
}

interface DetailLevel extends ShapeLimits {
  readonly sampleStringChars: number;
  readonly sampleMaxChars: number;
  readonly textHeadChars: number;
  readonly textTailChars: number;
  readonly maxHeaders: number;
}

/**
 * Tried richest-first. Each step drops detail that costs the most bytes per
 * unit of insight: sample text first, then depth, then field count.
 */
const LEVELS: readonly DetailLevel[] = [
  {
    maxDepth: 6,
    maxFields: 24,
    maxArraySamples: 8,
    sampleStringChars: 80,
    sampleMaxChars: 500,
    textHeadChars: 700,
    textTailChars: 200,
    maxHeaders: 8,
  },
  {
    maxDepth: 4,
    maxFields: 16,
    maxArraySamples: 5,
    sampleStringChars: 40,
    sampleMaxChars: 250,
    textHeadChars: 400,
    textTailChars: 120,
    maxHeaders: 6,
  },
  {
    maxDepth: 3,
    maxFields: 12,
    maxArraySamples: 3,
    sampleStringChars: 24,
    sampleMaxChars: 120,
    textHeadChars: 250,
    textTailChars: 60,
    maxHeaders: 4,
  },
  {
    maxDepth: 2,
    maxFields: 8,
    maxArraySamples: 2,
    sampleStringChars: 0,
    sampleMaxChars: 0,
    textHeadChars: 150,
    textTailChars: 0,
    maxHeaders: 2,
  },
  {
    maxDepth: 1,
    maxFields: 5,
    maxArraySamples: 1,
    sampleStringChars: 0,
    sampleMaxChars: 0,
    textHeadChars: 60,
    textTailChars: 0,
    maxHeaders: 0,
  },
];

/**
 * Response headers worth showing. An allowlist rather than a denylist: an
 * unrecognised header may well carry a token (`x-amz-security-token` and
 * friends), and the safe default is not to render it.
 */
const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "content-type",
  "content-encoding",
  "etag",
  "last-modified",
  "location",
  "retry-after",
  "cache-control",
  "www-authenticate",
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
]);

const HEADER_PREFIX_ALLOWLIST = ["x-ratelimit-", "ratelimit-"];

/** Already shown on the summary line; repeating them is wasted budget. */
const HEADERS_ON_SUMMARY_LINE: ReadonlySet<string> = new Set(["content-type", "content-length"]);

export function digest(response: HttpResponse, options: DigestOptions = {}): Digest {
  const maxBytes = options.maxBytes ?? DEFAULT_DIGEST_MAX_BYTES;
  const contentType = findHeader(response.headers, "content-type");
  const decoded = decodeBody(response.body, contentType);

  let text = "";
  for (const level of LEVELS) {
    text = render(response, decoded, level, options.handle);
    if (options.redactor !== undefined) text = options.redactor.redact(text);
    if (Buffer.byteLength(text, "utf8") <= maxBytes) break;
  }
  // Capping stays last so the byte budget holds whatever redaction did to the
  // length.
  text = capBytes(text, maxBytes, TRUNCATION_MARKER);

  return {
    text,
    textBytes: Buffer.byteLength(text, "utf8"),
    status: response.status,
    bodyKind: decoded.kind,
    bodyBytes: response.body.byteLength,
    contentType,
    handle: options.handle,
  };
}

function render(
  response: HttpResponse,
  decoded: DecodedBody,
  level: DetailLevel,
  handle: string | undefined,
): string {
  const lines: string[] = [summaryLine(response, decoded)];

  if (handle !== undefined) lines.push(`handle: ${handle}`);

  const headers = interestingHeaders(response.headers, level.maxHeaders);
  if (headers.length > 0) {
    lines.push(headers.map((h) => `${h.name}: ${h.value}`).join(" · "));
  }

  if (response.redirects.length > 0) {
    lines.push(`via ${response.redirects.length} redirect(s), final ${response.url}`);
  }

  const body = renderBody(decoded, level);
  if (body !== undefined) {
    lines.push("", body);
  }

  return lines.join("\n");
}

function summaryLine(response: HttpResponse, decoded: DecodedBody): string {
  const parts = [
    `${response.status} ${response.statusText}`.trim(),
    findHeader(response.headers, "content-type")?.split(";")[0]?.trim() ?? decoded.kind,
    formatBytes(response.body.byteLength),
    `${Math.round(response.durationMs)}ms`,
  ];
  if (response.attempts > 1) parts.push(`${response.attempts} attempts`);
  if (response.bodyTruncated) parts.push("BODY TRUNCATED");
  return parts.join(" · ");
}

function renderBody(decoded: DecodedBody, level: DetailLevel): string | undefined {
  switch (decoded.kind) {
    case "empty":
      return "(empty body)";
    case "binary":
      return "(binary body — not decoded; use inspect with a byte range)";
    case "text":
      return renderText(decoded.text, level);
    case "json":
      return renderJson(decoded.value, level);
  }
}

function renderText(text: string, level: DetailLevel): string {
  if (text.length <= level.textHeadChars + level.textTailChars) return text;

  const head = text.slice(0, level.textHeadChars);
  const tail = level.textTailChars > 0 ? text.slice(-level.textTailChars) : "";
  const elided = text.length - head.length - tail.length;
  return tail === ""
    ? `${head}\n… ${elided} more characters`
    : `${head}\n… ${elided} more characters …\n${tail}`;
}

function renderJson(value: unknown, level: DetailLevel): string {
  const shape = renderShape(inferShape(value, level));
  if (level.sampleMaxChars === 0) return shape;

  const sampled = sampleOf(value);
  const json = JSON.stringify(shrinkForSample(sampled, level, 0));
  if (json === undefined) return shape;

  const label = Array.isArray(value) ? "sample [0]:" : "sample:";
  return `${shape}\n\n${label}\n${capBytes(json, level.sampleMaxChars, "…")}`;
}

/** For a list, one element says more than a truncated view of the whole list. */
function sampleOf(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : value;
}

/**
 * Produces a small stand-in for `value` before stringifying, so the sample is
 * cut structurally rather than chopped mid-token by a byte cap.
 */
function shrinkForSample(value: unknown, level: DetailLevel, depth: number): unknown {
  if (depth > level.maxDepth) return "…";
  if (typeof value === "string") {
    return value.length > level.sampleStringChars
      ? `${value.slice(0, level.sampleStringChars)}…`
      : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const kept = value.slice(0, 1).map((item) => shrinkForSample(item, level, depth + 1));
    return value.length > 1 ? [...kept, `… ${value.length - 1} more`] : kept;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries.slice(0, level.maxFields)) {
      out[key] = shrinkForSample(child, level, depth + 1);
    }
    if (entries.length > level.maxFields) out["…"] = `+${entries.length - level.maxFields} more`;
    return out;
  }
  return value;
}

function interestingHeaders(headers: readonly HeaderPair[], limit: number): HeaderPair[] {
  if (limit <= 0) return [];
  const out: HeaderPair[] = [];
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (HEADERS_ON_SUMMARY_LINE.has(name)) continue;
    const allowed =
      HEADER_ALLOWLIST.has(name) || HEADER_PREFIX_ALLOWLIST.some((p) => name.startsWith(p));
    if (!allowed) continue;
    out.push({ name, value: header.value });
    if (out.length >= limit) break;
  }
  return out;
}

function findHeader(headers: readonly HeaderPair[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}
