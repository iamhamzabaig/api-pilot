import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DESCRIBE_MAX_BYTES } from "../../src/core/spec/describe.js";
import { SpecIndex } from "../../src/core/spec/spec-index.js";

/**
 * Golden output for `describe`. Like the response-digest goldens, these are the
 * specification of what a model sees — a change here is a product change.
 */

const SPECS = fileURLToPath(new URL("../fixtures/specs/", import.meta.url));

let index: SpecIndex;

beforeAll(async () => {
  index = await SpecIndex.fromPaths([
    `${SPECS}billing.yaml`,
    `${SPECS}circular.yaml`,
    `${SPECS}split-main.yaml`,
  ]);
});

const CASES = [
  "updateSubscription",
  "listCustomers",
  "createCustomer",
  "retrieveCustomer",
  "payInvoice",
  "createInvoice",
  "getCommentThread",
  "retrieveOrder",
  "refundCharge",
];

describe("describe golden output", () => {
  for (const id of CASES) {
    it(`renders ${id}`, () => {
      expect(index.describe(id)).toMatchSnapshot();
    });
  }

  it("keeps every operation inside the 1 KB budget", () => {
    const oversized = index.operations
      .filter(
        (operation) =>
          Buffer.byteLength(index.describe(operation.id), "utf8") > DEFAULT_DESCRIBE_MAX_BYTES,
      )
      .map((operation) => operation.id);

    expect(oversized).toEqual([]);
  });

  it("includes what a caller needs to actually make the request", () => {
    const described = index.describe("updateSubscription");

    expect(described).toContain("PATCH /v1/subscriptions/{subscription}");
    expect(described).toContain("path:");
    expect(described).toContain("subscription");
    expect(described).toContain("body (application/json, required)");
    expect(described).toContain("auth:");
    expect(described).toContain("responses:");
  });

  it("marks a deprecated operation", () => {
    expect(index.describe("refundCharge")).toContain("DEPRECATED");
  });
});
