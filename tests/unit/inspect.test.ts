import { describe, expect, it } from "vitest";
import { ApiPilotError } from "../../src/core/errors.js";
import { DEFAULT_INSPECT_MAX_BYTES, inspect } from "../../src/core/inspect/inspect.js";

const encoder = new TextEncoder();

function target(value: unknown, contentType = "application/json") {
  return {
    headers: [
      { name: "content-type", value: contentType },
      { name: "x-request-id", value: "req-1" },
    ],
    body: typeof value === "string" ? encoder.encode(value) : encoder.encode(JSON.stringify(value)),
  };
}

describe("inspect", () => {
  it("returns a single match unwrapped", () => {
    const result = inspect(target({ a: { b: 42 } }), { path: "$.a.b" });
    expect(result.kind).toBe("json");
    expect(result.matchCount).toBe(1);
    expect(JSON.parse(result.text)).toBe(42);
  });

  it("returns multiple matches as an array", () => {
    const result = inspect(target({ items: [{ id: 1 }, { id: 2 }] }), { path: "$..id" });
    expect(result.matchCount).toBe(2);
    expect(JSON.parse(result.text)).toEqual([1, 2]);
  });

  it("reports an empty match set without throwing", () => {
    const result = inspect(target({ a: 1 }), { path: "$.missing" });
    expect(result.matchCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("returns headers when asked", () => {
    const result = inspect(target({ a: 1 }), { headers: true });
    expect(result.kind).toBe("headers");
    expect(result.text).toContain("x-request-id: req-1");
  });

  it("returns a byte range as text when it decodes", () => {
    const result = inspect(target("hello world", "text/plain"), {
      range: { offset: 6, length: 5 },
    });
    expect(result.kind).toBe("bytes");
    expect(result.text).toBe("world");
  });

  it("falls back to hex for a range that is not valid text", () => {
    // 0xff 0xfe is not a legal UTF-8 sequence in any position. (0xde 0xad,
    // the tempting choice, decodes cleanly to U+07AD.)
    const result = inspect(
      {
        headers: [{ name: "content-type", value: "image/png" }],
        body: new Uint8Array([0xff, 0xfe]),
      },
      { range: { offset: 0, length: 2 } },
    );
    expect(result.text).toContain("fffe");
  });

  it("renders a binary body as hex without a range", () => {
    const result = inspect({
      headers: [{ name: "content-type", value: "image/png" }],
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(result.text).toContain("89504e47");
  });

  it("refuses a path query against a non-JSON body", () => {
    const error = (() => {
      try {
        inspect(target("plain text here", "text/plain"), { path: "$.a" });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect((error as ApiPilotError).code).toBe("INVALID_REQUEST");
  });

  it("refuses path and range together", () => {
    expect(() =>
      inspect(target({ a: 1 }), { path: "$.a", range: { offset: 0, length: 1 } }),
    ).toThrow(ApiPilotError);
  });

  it("rejects a negative or zero-length range", () => {
    expect(() => inspect(target({ a: 1 }), { range: { offset: -1, length: 4 } })).toThrow(
      ApiPilotError,
    );
    expect(() => inspect(target({ a: 1 }), { range: { offset: 0, length: 0 } })).toThrow(
      ApiPilotError,
    );
  });

  // There is no unbounded read anywhere in this module — that is the point.
  it("caps every output mode", () => {
    const huge = {
      items: Array.from({ length: 20000 }, (_, i) => ({ id: i, note: "x".repeat(50) })),
    };
    for (const options of [{}, { path: "$..id" }, { range: { offset: 0, length: 10 ** 7 } }]) {
      const result = inspect(target(huge), { ...options, maxBytes: 512 });
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(512);
    }
  });

  it("defaults to a bounded budget", () => {
    const huge = { items: Array.from({ length: 20000 }, (_, i) => i) };
    const result = inspect(target(huge));
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(DEFAULT_INSPECT_MAX_BYTES);
    expect(result.truncated).toBe(true);
  });
});
