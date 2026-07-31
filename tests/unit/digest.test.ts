import { describe, expect, it } from "vitest";
import { DEFAULT_DIGEST_MAX_BYTES, digest } from "../../src/core/digest/digest.js";
import type { HttpResponse } from "../../src/core/exec/execute.js";
import { CORPUS, largeUserList } from "../golden/corpus.js";

function jsonResponse(value: unknown): HttpResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status: 200,
    statusText: "OK",
    headers: [{ name: "content-type", value: "application/json" }],
    body,
    bodyTruncated: false,
    url: "https://api.example.test/x",
    redirects: [],
    method: "GET",
    durationMs: 10,
    attempts: 1,
  };
}

describe("the headline case", () => {
  const response = jsonResponse(largeUserList());
  const result = digest(response, { handle: "r_headline01" });

  it("is over 1 MB of body", () => {
    expect(response.body.byteLength).toBeGreaterThan(1_000_000);
  });

  it("digests to under 2 KB", () => {
    expect(result.textBytes).toBeLessThanOrEqual(DEFAULT_DIGEST_MAX_BYTES);
  });

  it("still conveys the element count", () => {
    expect(result.text).toContain("[7000]");
  });

  it("still conveys the element shape", () => {
    for (const field of ["id", "name", "email", "active", "tags", "meta"]) {
      expect(result.text).toContain(field);
    }
    expect(result.text).toContain("number");
    expect(result.text).toContain("boolean");
  });

  it("still shows a concrete sample", () => {
    expect(result.text).toContain("sample");
    expect(result.text).toContain("user1@example.test");
  });

  it("tells the reader how to drill in", () => {
    expect(result.text).toContain("r_headline01");
  });

  // The ADR-0002 claim, measured in bytes rather than tokens. Tokenizing would
  // need a model-specific dependency; for text this dense the ratio is close
  // enough that a 500x margin settles it either way.
  it("costs a fraction of a percent of the raw body", () => {
    expect(result.textBytes / response.body.byteLength).toBeLessThan(0.0025);
  });
});

describe("budget enforcement", () => {
  it("honours a custom maxBytes", () => {
    for (const maxBytes of [64, 128, 256, 512, 1024, 4096]) {
      for (const entry of CORPUS) {
        const result = digest(entry.response, { maxBytes });
        expect(result.textBytes, `${entry.name} at maxBytes=${maxBytes}`).toBeLessThanOrEqual(
          maxBytes,
        );
      }
    }
  });

  it("degrades detail rather than failing on a pathological body", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`field_${i}`, { a: i, b: `value ${i}` }]),
    );
    const result = digest(jsonResponse(wide));
    expect(result.textBytes).toBeLessThanOrEqual(DEFAULT_DIGEST_MAX_BYTES);
    expect(result.text).toContain("more");
  });
});

/**
 * A seeded generator, not a property-testing dependency: the invariant is a
 * simple byte cap, and 400 deterministic shapes exercise it without adding a
 * package or losing reproducibility.
 */
describe("byte cap holds against generated input", () => {
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  // Branching factor and depth are kept small on purpose: the target is the
  // byte cap, and a wide tree only spends heap proving the same invariant.
  function generate(random: () => number, depth: number): unknown {
    const roll = random();
    if (depth > 4 || roll < 0.35) {
      const leaf = random();
      if (leaf < 0.2) return null;
      if (leaf < 0.4) return random() * 1e9;
      if (leaf < 0.6) return random() > 0.5;
      // Long strings and astral-plane characters are the two ways a naive
      // byte-slicing cap breaks.
      return "\u{1F600}é".repeat(1 + Math.floor(random() * 200));
    }
    if (roll < 0.7) {
      return Array.from({ length: Math.floor(random() * 6) }, () => generate(random, depth + 1));
    }
    return Object.fromEntries(
      Array.from({ length: Math.floor(random() * 6) }, (_, i) => [
        `k${i}${"x".repeat(Math.floor(random() * 40))}`,
        generate(random, depth + 1),
      ]),
    );
  }

  it.each([16, 64, 256, 2048])("never exceeds maxBytes=%i", (maxBytes) => {
    const random = makeRandom(maxBytes * 7919);
    for (let i = 0; i < 100; i++) {
      const result = digest(jsonResponse(generate(random, 0)), { maxBytes });
      expect(result.textBytes).toBeLessThanOrEqual(maxBytes);
      // Byte-cap bugs show up as broken code points, not just as length.
      expect(result.text).not.toContain("�");
    }
  });

  it("holds for non-UTF-8 and binary bodies too", () => {
    const random = makeRandom(4242);
    for (let i = 0; i < 100; i++) {
      const bytes = new Uint8Array(Math.floor(random() * 5000));
      for (let b = 0; b < bytes.length; b++) bytes[b] = Math.floor(random() * 256);
      const result = digest(
        {
          status: 200,
          statusText: "OK",
          headers: [{ name: "content-type", value: "application/json" }],
          body: bytes,
          bodyTruncated: false,
          url: "https://api.example.test/x",
          redirects: [],
          method: "GET",
          durationMs: 1,
          attempts: 1,
        },
        { maxBytes: 256 },
      );
      expect(result.textBytes).toBeLessThanOrEqual(256);
    }
  });
});
