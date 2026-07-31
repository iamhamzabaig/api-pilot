import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, redactError } from "../../src/core/redact/redactor.js";

describe("Redactor", () => {
  it("removes the raw secret", () => {
    const redactor = new Redactor();
    redactor.add("sk_live_abcdef123456");
    expect(redactor.redact("Authorization: Bearer sk_live_abcdef123456")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  // A password redacted only in its raw form still leaks through the Basic
  // auth blob, which is what actually travels on the wire.
  it("removes the base64 form", () => {
    const redactor = new Redactor();
    redactor.add("hunter2hunter2");
    const encoded = Buffer.from("hunter2hunter2", "utf8").toString("base64");
    expect(redactor.redact(`blob=${encoded}`)).toBe(`blob=${REDACTED}`);
  });

  it("removes the percent-encoded form", () => {
    const redactor = new Redactor();
    redactor.add("a b/c+d=e");
    expect(redactor.redact(`?key=${encodeURIComponent("a b/c+d=e")}`)).toContain(REDACTED);
  });

  it("redacts longest-first so an overlap leaves no tail", () => {
    const redactor = new Redactor();
    redactor.add("token123");
    redactor.add("token123456789");
    expect(redactor.redact("token123456789")).toBe(REDACTED);
  });

  it("ignores values too short to be credentials", () => {
    const redactor = new Redactor();
    redactor.add("ab");
    expect(redactor.redact("abcabc")).toBe("abcabc");
  });

  it("walks nested structures, keys included", () => {
    const redactor = new Redactor();
    redactor.add("s3cret-value");
    const out = redactor.redactDeep({
      list: ["prefix s3cret-value suffix"],
      nested: { "s3cret-value": 1 },
      untouched: 42,
    });
    expect(JSON.stringify(out)).not.toContain("s3cret-value");
    expect((out as { untouched: number }).untouched).toBe(42);
  });

  it("scrubs messages, stacks, and causes of thrown errors", () => {
    const redactor = new Redactor();
    redactor.add("leaky-token-value");
    const error = new Error("failed calling https://x/?key=leaky-token-value", {
      cause: new Error("inner leaky-token-value"),
    });

    redactError(error, redactor);

    expect(error.message).not.toContain("leaky-token-value");
    expect(error.stack).not.toContain("leaky-token-value");
    expect((error.cause as Error).message).not.toContain("leaky-token-value");
  });
});
