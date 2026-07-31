import { describe, expect, it } from "vitest";
import { version } from "../../src/version.js";

describe("version", () => {
  // Guards the relative path in src/version.ts: it must keep resolving package.json
  // from both src/ and dist/. Silent breakage here ships a CLI that crashes on start.
  it("resolves a semver string from package.json", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
