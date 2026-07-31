import { describe, expect, it } from "vitest";
import { DEFAULT_DIGEST_MAX_BYTES, digest } from "../../src/core/digest/digest.js";
import { CORPUS } from "./corpus.js";

/**
 * Golden output for the whole corpus. These snapshots are the specification of
 * what a model sees; changing one is a product change and must be reviewed as
 * such, not accepted with `-u` because a test went red.
 */
describe("digest golden corpus", () => {
  for (const entry of CORPUS) {
    it(`renders ${entry.name}`, () => {
      const result = digest(entry.response, { handle: "r_goldenfixed01" });
      expect(result.text).toMatchSnapshot();
    });
  }

  it("keeps every corpus entry inside the default budget", () => {
    const oversized = CORPUS.filter(
      (entry) => digest(entry.response).textBytes > DEFAULT_DIGEST_MAX_BYTES,
    ).map((entry) => entry.name);

    expect(oversized).toEqual([]);
  });

  // The header allowlist is a security control, not cosmetics: an unrecognised
  // header may carry a token, so it must not reach the model by default.
  it("never renders a non-allowlisted header", () => {
    const entry = CORPUS.find((e) => e.name === "large-json-array");
    const result = digest(entry?.response as never);
    expect(result.text).not.toContain("SHOULD-NOT-APPEAR");
    expect(result.text).not.toContain("x-secret-token");
  });
});
