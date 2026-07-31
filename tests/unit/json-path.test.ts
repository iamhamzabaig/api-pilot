import { describe, expect, it } from "vitest";
import { ApiPilotError } from "../../src/core/errors.js";
import { parsePath, queryPath } from "../../src/core/inspect/json-path.js";

const doc = {
  data: {
    items: [
      { id: 1, name: "alpha", tags: ["x", "y"] },
      { id: 2, name: "beta", tags: [] },
      { id: 3, name: "gamma", tags: ["z"], nested: { id: 99 } },
    ],
    cursor: null,
  },
  "odd key": 7,
  errors: [{ message: "boom" }],
};

describe("queryPath", () => {
  it("walks object keys from the root", () => {
    expect(queryPath(doc, "$.data.cursor")).toEqual([null]);
  });

  it("accepts a leading bare key", () => {
    expect(queryPath(doc, "data.items[0].name")).toEqual(["alpha"]);
  });

  it("indexes arrays, including from the end", () => {
    expect(queryPath(doc, "$.data.items[0].id")).toEqual([1]);
    expect(queryPath(doc, "$.data.items[-1].id")).toEqual([3]);
  });

  it("expands a wildcard over an array", () => {
    expect(queryPath(doc, "$.data.items[*].name")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("expands a wildcard over object values", () => {
    expect(queryPath({ a: 1, b: 2 }, "$.*")).toEqual([1, 2]);
  });

  it("slices arrays end-exclusively", () => {
    expect(queryPath(doc, "$.data.items[0:2].id")).toEqual([1, 2]);
    expect(queryPath(doc, "$.data.items[1:].id")).toEqual([2, 3]);
  });

  it("reads bracketed and quoted keys", () => {
    expect(queryPath(doc, "$['odd key']")).toEqual([7]);
  });

  it("descends recursively", () => {
    expect(queryPath(doc, "$..id")).toEqual([1, 2, 3, 99]);
    expect(queryPath(doc, "$..message")).toEqual(["boom"]);
  });

  it("returns nothing rather than throwing on a miss", () => {
    expect(queryPath(doc, "$.nope.deeper")).toEqual([]);
    expect(queryPath(doc, "$.data.items[99]")).toEqual([]);
  });

  it("does not confuse a key on an array with an index", () => {
    expect(queryPath(doc, "$.data.items.name")).toEqual([]);
  });

  it("flattens nested collections in document order", () => {
    expect(queryPath(doc, "$.data.items[*].tags[*]")).toEqual(["x", "y", "z"]);
  });
});

describe("parsePath", () => {
  it("rejects syntax it does not support", () => {
    // Filter expressions are the reason this parser exists instead of a
    // dependency; they must fail loudly rather than be silently ignored.
    for (const bad of ["$.items[?(@.id > 1)]", "$.items[", "$.", "$..", "$.items[a]", "$#"]) {
      const error = (() => {
        try {
          parsePath(bad);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(error, `expected ${bad} to fail`).toBeInstanceOf(ApiPilotError);
      expect((error as ApiPilotError).code).toBe("INVALID_REQUEST");
    }
  });

  it("parses the supported segment kinds", () => {
    expect(parsePath("$.a[0][*][1:5]..b")).toEqual([
      { kind: "key", name: "a" },
      { kind: "index", index: 0 },
      { kind: "wildcard" },
      { kind: "slice", start: 1, end: 5 },
      { kind: "descend", name: "b" },
    ]);
  });
});
