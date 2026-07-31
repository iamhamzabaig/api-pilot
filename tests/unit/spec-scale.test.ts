import { describe, expect, it } from "vitest";
import { DEFAULT_DESCRIBE_MAX_BYTES } from "../../src/core/spec/describe.js";
import { SpecIndex } from "../../src/core/spec/spec-index.js";

/**
 * Scale is the claim in ADR-0002 that a spec-to-MCP generator cannot make:
 * a 1,000-operation spec must cost the same fixed tool surface as a 10-operation
 * one, and searching it must stay interactive.
 *
 * Thresholds are generous relative to the measured numbers so this fails on a
 * real regression rather than on a busy CI runner.
 */

const RESOURCES = [
  "customer",
  "subscription",
  "invoice",
  "charge",
  "refund",
  "payout",
  "dispute",
  "product",
  "price",
  "coupon",
];

function hugeSpec(operationCount: number): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  let created = 0;

  for (let group = 0; created < operationCount; group++) {
    const resource = `${RESOURCES[group % RESOURCES.length]}_${Math.floor(group / RESOURCES.length)}`;

    paths[`/v1/${resource}s`] = {
      get: {
        operationId: `list${resource}s`,
        summary: `Returns a list of ${resource}s.`,
        tags: [resource],
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: `create${resource}`,
        summary: `Creates a new ${resource}.`,
        tags: [resource],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { id: { type: "string" }, amount: { type: "integer" } },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    };

    paths[`/v1/${resource}s/{id}`] = {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: `retrieve${resource}`,
        summary: `Retrieves an existing ${resource}.`,
        tags: [resource],
        responses: { "200": { description: "ok" } },
      },
      patch: {
        operationId: `update${resource}`,
        summary: `Updates the specified ${resource}.`,
        tags: [resource],
        responses: { "200": { description: "ok" } },
      },
      delete: {
        operationId: `delete${resource}`,
        summary: `Permanently deletes a ${resource}.`,
        tags: [resource],
        responses: { "200": { description: "ok" } },
      },
    };

    created += 5;
  }

  return { openapi: "3.0.3", info: { title: "Huge", version: "1" }, paths };
}

describe("a 1,000-operation spec", () => {
  const document = hugeSpec(1000);

  it("indexes in under a second", () => {
    const started = performance.now();
    const index = SpecIndex.fromDocuments([{ value: document, id: "huge" }]);
    const elapsed = performance.now() - started;

    expect(index.size).toBeGreaterThanOrEqual(1000);
    expect(elapsed, `indexing took ${elapsed.toFixed(0)}ms`).toBeLessThan(1000);
  });

  it("searches in under 50ms", () => {
    const index = SpecIndex.fromDocuments([{ value: document, id: "huge" }]);
    const queries = [
      "update a subscription",
      "list all invoices",
      "delete a coupon",
      "create a new payout",
      "retrieve one dispute",
    ];

    // Warm the JIT so the measurement is of steady-state search, not first-call.
    for (const query of queries) index.search(query, 10);

    const started = performance.now();
    for (const query of queries) index.search(query, 10);
    const perQuery = (performance.now() - started) / queries.length;

    expect(perQuery, `search averaged ${perQuery.toFixed(1)}ms`).toBeLessThan(50);
  });

  it("still ranks the right operation first at this scale", () => {
    const index = SpecIndex.fromDocuments([{ value: document, id: "huge" }]);
    expect(index.search("update a subscription_0", 1)[0]?.operation.id).toBe(
      "updatesubscription_0",
    );
    expect(index.search("delete a coupon_0", 1)[0]?.operation.id).toBe("deletecoupon_0");
  });

  it("keeps describe inside its budget for every operation", () => {
    const index = SpecIndex.fromDocuments([{ value: document, id: "huge" }]);
    const oversized = index.operations.filter(
      (operation) =>
        Buffer.byteLength(index.describe(operation.id), "utf8") > DEFAULT_DESCRIBE_MAX_BYTES,
    );
    expect(oversized.map((operation) => operation.id)).toEqual([]);
  });
});
