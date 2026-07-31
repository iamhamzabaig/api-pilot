import { describe, expect, it } from "vitest";
import { inferShape, renderShape, type ShapeLimits } from "../../src/core/digest/shape.js";

const LIMITS: ShapeLimits = { maxDepth: 6, maxFields: 20, maxArraySamples: 10 };

const render = (value: unknown, limits: ShapeLimits = LIMITS) =>
  renderShape(inferShape(value, limits));

describe("inferShape", () => {
  it("names primitives", () => {
    expect(render(1)).toBe("number");
    expect(render("a")).toBe("string");
    expect(render(true)).toBe("boolean");
    expect(render(null)).toBe("null");
  });

  it("annotates array length", () => {
    expect(render([1, 2, 3])).toBe("number[3]");
    expect(render([])).toBe("unknown[0]");
  });

  it("inlines small objects and blocks large ones", () => {
    expect(render({ a: 1, b: "x" })).toBe("{ a: number; b: string }");
    expect(render({ a: 1, b: "x", c: true })).toBe("{\n  a: number\n  b: string\n  c: boolean\n}");
  });

  it("marks a key missing from some elements as optional", () => {
    expect(render([{ id: 1, extra: "x" }, { id: 2 }])).toContain("extra?: string");
  });

  it("merges differing element types into a union", () => {
    // Parenthesised, or the length would appear to belong to `boolean` alone.
    expect(render([1, "a", true])).toBe("(number | string | boolean)[3]");
  });

  it("reports a length range for nested arrays of differing size", () => {
    expect(render([{ tags: ["a", "b"] }, { tags: [] }, { tags: ["c"] }])).toContain(
      "tags: string[0..2]",
    );
  });

  it("puts the count first when the element type spans lines", () => {
    const out = render([
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 2, c: 3 },
    ]);
    expect(out.startsWith("array[2] of {")).toBe(true);
  });

  it("elides past maxDepth instead of recursing forever", () => {
    let nested: unknown = { leaf: 1 };
    for (let i = 0; i < 50; i++) nested = { child: nested };
    const out = render(nested, { ...LIMITS, maxDepth: 3 });
    expect(out).toContain("…");
    expect(out.split("\n").length).toBeLessThan(12);
  });

  it("counts the fields it dropped", () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, i]));
    expect(render(wide, { ...LIMITS, maxFields: 5 })).toContain("+25 more");
  });

  it("only samples maxArraySamples elements", () => {
    // The 500th element is never inspected, so its extra key must not appear.
    const items = Array.from({ length: 501 }, (_, i) =>
      i === 500 ? { id: i, surprise: true } : { id: i },
    );
    const out = render(items, { ...LIMITS, maxArraySamples: 3 });
    expect(out).toContain("[501]");
    expect(out).not.toContain("surprise");
  });
});
