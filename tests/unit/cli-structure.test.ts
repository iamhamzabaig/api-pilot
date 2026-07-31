import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cold-start budget (NFR N1) is measured in `tests/bench/`. These are the
 * mechanism that produces it, asserted directly because they are cheap and
 * cannot flake: a static import of core in the dispatch file would load the
 * HTTP stack, the spec index and the store on every invocation including
 * `--version`, and the p95 measurement would only notice once the budget was
 * already gone.
 */

async function source(...segments: string[]): Promise<string> {
  return readFile(join(process.cwd(), ...segments), "utf8");
}

describe("cold start is protected structurally", () => {
  it("dispatches without statically importing core", async () => {
    const text = await source("src", "cli", "index.ts");
    const staticImports = [...text.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map(
      (match) => match[1],
    );

    expect(staticImports).toEqual(["./output.js"]);
    expect(text).toContain('await import("./commands/');
  });

  it("keeps the printing helpers free of core imports", async () => {
    expect(await source("src", "cli", "output.ts")).not.toMatch(/from\s+"\.\.\/core\//);
  });

  // Every command must offer both dialects — the acceptance criterion for M5 is
  // `--json` on all seven, and it is the difference between a tool an agent can
  // drive and one it has to screen-scrape.
  it.each(["spec.ts", "run.ts", "store.ts", "env.ts"])("declares --json in %s", async (file) => {
    expect(await source("src", "cli", "commands", file)).toContain('json: { type: "boolean"');
  });
});
