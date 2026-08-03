import { describe, expect, it } from "vitest";
import { SpecIndex } from "../../src/core/spec/spec-index.js";
import { TOOLS } from "../../src/mcp/tools.js";

/**
 * The tool surface is the one thing every session pays for before the model has
 * done anything, so it is snapshotted like any other model-facing output.
 *
 * Two separate claims live here:
 *
 * 1. **NFR N3** — all six definitions serialize to ≤ 1,500 tokens.
 * 2. **ADR-0002** — that number does not move when a 1,000-operation spec is
 *    loaded. This is the measurable claim the whole design rests on, and it is
 *    the one a spec-to-tools generator cannot make.
 *
 * A diff in the snapshot is a change to what every model sees. Read it.
 */

/**
 * Four bytes per token. There is no tokenizer in this repo and adding one to
 * count its own tool descriptions would be a poor trade — the ratio is
 * conservative for JSON, which is punctuation-dense and tokenizes worse than
 * prose, so the estimate errs high. Precision is not what this gate needs; a
 * doubling of the surface is.
 */
const BYTES_PER_TOKEN = 4;
const TOKEN_BUDGET = 1500;

function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / BYTES_PER_TOKEN);
}

describe("the MCP tool surface", () => {
  it("is exactly the six tools of ADR-0002", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "api_search",
      "api_describe",
      "api_call",
      "api_inspect",
      "api_history",
      "api_env",
    ]);
  });

  it("fits the 1,500-token budget (NFR N3)", () => {
    const tokens = estimateTokens(TOOLS);
    expect(tokens, `tool surface is ~${tokens} tokens`).toBeLessThanOrEqual(TOKEN_BUDGET);
  });

  it("costs nothing extra when a 1,000-operation spec is loaded", () => {
    const before = JSON.stringify(TOOLS);

    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      paths[`/v1/thing${i}`] = {
        get: {
          operationId: `getThing${i}`,
          summary: `Retrieves thing ${i}.`,
          responses: { "200": { description: "ok" } },
        },
      };
    }
    const index = SpecIndex.fromDocuments([
      { value: { openapi: "3.0.3", info: { title: "Huge", version: "1" }, paths }, id: "huge" },
    ]);

    expect(index.size).toBe(1000);
    expect(JSON.stringify(TOOLS)).toBe(before);
    expect(TOOLS).toHaveLength(6);
  });

  it("matches its golden serialization", () => {
    expect(TOOLS).toMatchSnapshot();
  });
});
