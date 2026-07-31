import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { stem, tokenise } from "../../src/core/spec/search.js";
import { SpecIndex } from "../../src/core/spec/spec-index.js";

/**
 * The ADR-0002 bet, stated as tests.
 *
 * If search cannot turn a natural-language question into the right operation,
 * generating one MCP tool per operation was the better design and the whole
 * fixed-tool-surface argument collapses. These are the queries that decide it.
 *
 * The corpus is deliberately adversarial: eight operations mention
 * "subscription", so ranking — not matching — is what has to work.
 */

const SPECS = fileURLToPath(new URL("../fixtures/specs/", import.meta.url));

let index: SpecIndex;

beforeAll(async () => {
  index = await SpecIndex.fromPaths([`${SPECS}billing.yaml`]);
});

const top = (query: string): string => index.search(query, 5)[0]?.operation.id ?? "(no hits)";

describe("natural-language queries land on the right operation", () => {
  it.each([
    ["update a subscription", "updateSubscription"],
    ["how do I change a subscription's price?", "updateSubscription"],
    ["cancel a subscription", "cancelSubscription"],
    ["create a subscription for a customer", "createSubscription"],
    ["list all customers", "listCustomers"],
    ["retrieve a single customer", "retrieveCustomer"],
    ["delete a customer", "deleteCustomer"],
    ["pay an invoice", "payInvoice"],
    ["create a draft invoice", "createInvoice"],
    ["what endpoint lists subscription items?", "listSubscriptionItems"],
  ])("%j -> %s", (query, expected) => {
    expect(top(query)).toBe(expected);
  });

  it("finds an operation by its exact id", () => {
    expect(top("updateSubscription")).toBe("updateSubscription");
  });

  // A bare path is a question about a route, not about a method — asserting a
  // particular verb here would be testing a coin flip.
  it("finds the right route from a bare path", () => {
    expect(index.search("/v1/invoices", 1)[0]?.operation.path).toBe("/v1/invoices");
  });
});

describe("ranking behaviour", () => {
  it("separates list from retrieve-one for the same resource", () => {
    expect(top("list subscriptions")).toBe("listSubscriptions");
    expect(top("get one subscription by id")).toBe("retrieveSubscription");
  });

  // Method intent is the single most valuable signal, and the one a generic
  // text index has no way to express.
  it("uses the verb to choose between operations on the same path", () => {
    const ranked = index.search("subscription", 10).map((hit) => hit.operation.id);
    expect(ranked).toContain("updateSubscription");
    expect(ranked).toContain("cancelSubscription");

    // The same noun with different verbs must reorder the same candidates.
    expect(top("remove a subscription")).toBe("cancelSubscription");
    expect(top("modify a subscription")).toBe("updateSubscription");
  });

  it("ranks a deprecated operation below an equally good alternative", () => {
    const hits = index.search("refund a charge", 5);
    expect(hits[0]?.operation.id).toBe("refundCharge");
    // Still findable — just penalised.
    expect(hits[0]?.operation.deprecated).toBe(true);
  });

  it("returns nothing for a query with no relationship to the spec", () => {
    expect(index.search("kubernetes pod autoscaler", 5)).toEqual([]);
  });

  it("respects the result limit", () => {
    expect(index.search("subscription", 3)).toHaveLength(3);
  });
});

describe("tokenisation", () => {
  it("splits camelCase so generated ids match prose", () => {
    expect(tokenise("getUserById")).toEqual(["get", "user", "by", "id"]);
  });

  it("splits paths on their separators", () => {
    expect(tokenise("/v1/subscription_schedules/{id}")).toEqual([
      "v1",
      "subscription",
      "schedul",
      "id",
    ]);
  });

  it("collapses the inflections that matter and no more", () => {
    for (const word of ["update", "updates", "updating", "updated"]) {
      expect(stem(word), word).toBe("updat");
    }
    expect(stem("subscriptions")).toBe(stem("subscription"));
    expect(stem("policies")).toBe(stem("policy"));
    // Over-stemming would merge unrelated resources; these must stay distinct.
    expect(stem("charge")).not.toBe(stem("change"));
    expect(stem("invoice")).not.toBe(stem("invite"));
  });
});
