import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SpecIndex } from "../../src/core/spec/spec-index.js";

const SPECS = fileURLToPath(new URL("../fixtures/specs/", import.meta.url));

describe("loading", () => {
  /**
   * Every YAML file in tests/fixtures/specs is loaded. Dropping a real
   * downloaded spec into that directory makes it part of this corpus with no
   * code change — which is how a large public spec gets validated without
   * committing megabytes or letting CI touch the network.
   */
  it("loads every fixture spec without throwing", async () => {
    const files = (await readdir(SPECS)).filter((file) => file.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const index = await SpecIndex.fromPaths([`${SPECS}${file}`]);
      expect(index.operations.length, file).toBeGreaterThanOrEqual(0);
    }
  });

  it("indexes operations with their method, path, tags, and auth", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}billing.yaml`]);
    const operation = index.get("updateSubscription");

    expect(operation.method).toBe("PATCH");
    expect(operation.path).toBe("/v1/subscriptions/{subscription}");
    expect(operation.tags).toEqual(["Subscriptions"]);
    expect(operation.security).toEqual(["bearerAuth (http: bearer)"]);
    expect(operation.body?.contentType).toBe("application/json");
  });

  it("merges path-level parameters into each operation", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}billing.yaml`]);
    const names = index.get("retrieveSubscription").parameters.map((p) => p.name);
    expect(names).toContain("subscription");
  });

  it("resolves a $ref to a shared parameter component", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}billing.yaml`]);
    const limit = index.get("listCustomers").parameters.find((p) => p.name === "limit");
    expect(limit?.in).toBe("query");
    expect(limit?.description).toContain("limit on the number of objects");
  });

  it("follows a $ref into a sibling file", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}split-main.yaml`]);
    const operation = index.get("retrieveOrder");

    expect(operation.parameters[0]?.name).toBe("order");
    expect(index.describe("retrieveOrder")).toContain("total");
  });
});

describe("broken specs", () => {
  it("indexes what it can and warns about the rest", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}broken.yaml`]);

    // The two usable operations survive despite everything around them.
    const ids = index.operations.map((operation) => operation.id);
    expect(ids).toContain("duplicated");
    expect(ids).toContain("get_widgets");

    const warnings = index.warnings.join("\n");
    expect(warnings).toContain("/broken");
    expect(warnings).toContain("duplicate operationId");
  });

  it("synthesises an id when operationId is missing", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}broken.yaml`]);
    expect(() => index.get("get_widgets")).not.toThrow();
  });

  it("keeps both operations when an operationId is duplicated", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}broken.yaml`]);
    expect(index.operations.filter((o) => o.id.startsWith("duplicated"))).toHaveLength(2);
  });

  it("skips malformed parameters and keeps the valid ones", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}broken.yaml`]);
    const duplicated = index.operations.find(
      (o) => o.id.startsWith("duplicated") && o.path === "/gadgets",
    );
    expect(duplicated?.parameters.map((p) => p.name)).toEqual(["valid"]);
  });

  it("renders a dangling $ref as the missing component's name", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}broken.yaml`]);
    expect(index.describe("get_widgets")).toContain("DoesNotExist");
    expect(index.warnings.join("\n")).toContain("DoesNotExist");
  });

  // A spec is user-supplied data. Without this guard, `$ref` is a file-read
  // primitive pointed anywhere on disk.
  it("refuses a $ref that escapes the spec directory", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}broken.yaml`]);
    expect(index.warnings.join("\n")).toContain("escapes the spec directory");
  });
});

describe("circular schemas", () => {
  it("renders a self-referential schema by name instead of recursing", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}circular.yaml`]);
    const described = index.describe("getCommentThread");

    expect(described).toContain("Comment");
    expect(described).toContain("replies");
  });

  it("survives mutual recursion between two schemas", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}circular.yaml`]);
    expect(() => index.describe("getCommentThread")).not.toThrow();
    expect(() => index.describe("createTree")).not.toThrow();
  });

  it("reads an OpenAPI 3.1 nullable type union", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}circular.yaml`]);
    expect(index.describe("getCommentThread")).toContain("null");
  });
});

describe("multiple specs", () => {
  it("searches across every loaded spec at once", async () => {
    const index = await SpecIndex.fromPaths([`${SPECS}billing.yaml`, `${SPECS}split-main.yaml`]);

    expect(index.search("retrieve an order", 3)[0]?.operation.id).toBe("retrieveOrder");
    expect(index.search("update a subscription", 3)[0]?.operation.id).toBe("updateSubscription");
  });
});
