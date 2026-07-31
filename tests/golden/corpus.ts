import type { HeaderPair, HttpResponse } from "../../src/core/exec/execute.js";

/**
 * The fixed response corpus the digest is judged against.
 *
 * Every field that would otherwise vary — timing, attempt count — is pinned, so
 * a snapshot diff means the digest changed, not that the clock did (NFR N11).
 */

export interface CorpusEntry {
  readonly name: string;
  readonly response: HttpResponse;
}

const encoder = new TextEncoder();

function response(
  contentType: string | undefined,
  body: Uint8Array,
  overrides: Partial<HttpResponse> = {},
): HttpResponse {
  const base: HeaderPair[] = [];
  if (contentType !== undefined) base.push({ name: "content-type", value: contentType });
  base.push({ name: "content-length", value: String(body.byteLength) });

  const { headers: extra, ...rest } = overrides;

  return {
    status: 200,
    statusText: "OK",
    body,
    bodyTruncated: false,
    url: "https://api.example.test/resource",
    redirects: [],
    method: "GET",
    durationMs: 42,
    attempts: 1,
    ...rest,
    headers: [...base, ...(extra ?? [])],
  };
}

function json(value: unknown, overrides: Partial<HttpResponse> = {}): HttpResponse {
  return response("application/json", encoder.encode(JSON.stringify(value)), overrides);
}

/** ~1 MB of realistic list data — the headline case from ADR-0002. */
export function largeUserList(): unknown[] {
  return Array.from({ length: 7000 }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.test`,
    active: i % 3 !== 0,
    tags: i % 2 === 0 ? ["alpha", "beta"] : ["gamma"],
    meta: { created: "2026-01-01T00:00:00Z", score: (i * 7) % 100 },
  }));
}

function deeplyNested(depth: number): unknown {
  let value: unknown = { leaf: true, note: "bottom" };
  for (let i = 0; i < depth; i++) value = { level: depth - i, child: value };
  return value;
}

export const CORPUS: readonly CorpusEntry[] = [
  {
    name: "small-json-object",
    response: json({ id: 42, name: "widget", price: 9.99, inStock: true }),
  },
  {
    name: "large-json-array",
    response: json(largeUserList(), {
      headers: [
        { name: "etag", value: 'W/"abc123"' },
        { name: "x-ratelimit-remaining", value: "4998" },
        { name: "x-secret-token", value: "SHOULD-NOT-APPEAR" },
      ],
    }),
  },
  {
    name: "deeply-nested",
    response: json(deeplyNested(30)),
  },
  {
    name: "mixed-type-array",
    response: json([1, "two", null, { three: 3 }, [4], true]),
  },
  {
    name: "heterogeneous-object-array",
    response: json([
      { id: 1, name: "a", extra: "only-here" },
      { id: 2, name: "b" },
      { id: 3, name: "c", nested: { deep: [1, 2, 3] } },
    ]),
  },
  {
    name: "empty-collections",
    response: json({ items: [], meta: {}, cursor: null }),
  },
  {
    name: "problem-json-error",
    response: response(
      "application/problem+json",
      encoder.encode(
        JSON.stringify({
          type: "https://example.test/probs/out-of-credit",
          title: "You do not have enough credit.",
          status: 403,
          detail: "Your current balance is 30, but that costs 50.",
          instance: "/account/12345/msgs/abc",
        }),
      ),
      { status: 403, statusText: "Forbidden" },
    ),
  },
  {
    name: "wide-object",
    response: json(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field_${i}`, i]))),
  },
  {
    name: "long-text",
    response: response(
      "text/plain; charset=utf-8",
      encoder.encode(
        Array.from({ length: 400 }, (_, i) => `line ${i}: the quick brown fox jumps over it`).join(
          "\n",
        ),
      ),
    ),
  },
  {
    name: "html",
    response: response(
      "text/html; charset=utf-8",
      encoder.encode(
        "<!doctype html><html><head><title>Hi</title></head><body><p>Hi</p></body></html>",
      ),
    ),
  },
  {
    name: "binary-png",
    response: response(
      "image/png",
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0xde, 0xad, 0xbe, 0xef,
      ]),
    ),
  },
  {
    name: "invalid-utf8-labelled-json",
    // A body the server swears is JSON but which is not valid UTF-8 at all.
    response: response(
      "application/json",
      new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
    ),
  },
  {
    name: "no-content",
    response: response(undefined, new Uint8Array(0), { status: 204, statusText: "No Content" }),
  },
  {
    name: "truncated-with-redirects",
    response: json(
      { partial: true, values: [1, 2, 3] },
      {
        bodyTruncated: true,
        attempts: 3,
        redirects: ["https://api.example.test/old", "https://api.example.test/newer"],
        url: "https://api.example.test/resource",
      },
    ),
  },
];
