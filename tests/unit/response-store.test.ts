import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiPilotError } from "../../src/core/errors.js";
import type { HttpResponse } from "../../src/core/exec/execute.js";
import { ResponseStore } from "../../src/core/store/response-store.js";

let root: string;
let store: ResponseStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "api-pilot-store-"));
  store = new ResponseStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function response(body: string, overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: [{ name: "content-type", value: "application/json" }],
    body: new TextEncoder().encode(body),
    bodyTruncated: false,
    url: "https://example.test/things",
    redirects: [],
    method: "GET",
    durationMs: 12.5,
    attempts: 1,
    ...overrides,
  };
}

const summary = { method: "GET", url: "https://example.test/things" };

describe("ResponseStore", () => {
  it("round-trips a response through a handle", async () => {
    const meta = await store.put(response('{"a":1}'), summary);

    expect(meta.handle).toMatch(/^r_[0-9a-z]+$/);
    expect(meta.bodyBytes).toBe(7);

    const reloaded = await store.get(meta.handle);
    expect(reloaded).toEqual(meta);

    const body = await store.readBody(meta.handle);
    expect(new TextDecoder().decode(body)).toBe('{"a":1}');
  });

  it("issues distinct handles but stores identical bodies once", async () => {
    const first = await store.put(response("same"), summary);
    const second = await store.put(response("same"), summary);

    expect(first.handle).not.toBe(second.handle);
    expect(first.bodySha256).toBe(second.bodySha256);

    const shard = first.bodySha256.slice(0, 2);
    const objects = await readdir(join(root, "objects", shard));
    expect(objects).toEqual([first.bodySha256]);
  });

  it("keeps distinct bodies separate", async () => {
    const first = await store.put(response("one"), summary);
    const second = await store.put(response("two"), summary);

    expect(first.bodySha256).not.toBe(second.bodySha256);
    expect(new TextDecoder().decode(await store.readBody(second.handle))).toBe("two");
  });

  it("persists the redirect chain and truncation flag", async () => {
    const meta = await store.put(
      response("x", { bodyTruncated: true, redirects: ["https://a.test/", "https://b.test/"] }),
      summary,
    );

    const reloaded = await store.get(meta.handle);
    expect(reloaded.bodyTruncated).toBe(true);
    expect(reloaded.redirects).toEqual(["https://a.test/", "https://b.test/"]);
  });

  // A model can echo back a handle it invented. The regex is the only thing
  // between that and reading an arbitrary file off disk.
  it.each([
    "../../../etc/passwd",
    "r_../../secrets",
    "r_ok/../../escape",
    "not-a-handle",
    "r_UPPERCASE",
    "",
  ])("rejects the unsafe handle %j", async (handle) => {
    const error = await store.get(handle).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiPilotError);
    expect((error as ApiPilotError).code).toBe("INVALID_REQUEST");
  });

  it("raises NOT_FOUND for a well-formed handle that does not exist", async () => {
    const error = await store.get("r_deadbeef1").catch((e: unknown) => e);
    expect((error as ApiPilotError).code).toBe("NOT_FOUND");
  });
});
