import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

describe("ResponseStore intent", () => {
  it("stores the pre-interpolation intent so a run can be replayed", async () => {
    const meta = await store.put(response("{}"), summary, {
      intent: {
        method: "POST",
        url: "/things/{{id}}",
        headers: { "X-Trace": "{{trace}}" },
        body: { kind: "json", value: { plan: "{{plan}}" } },
      },
    });

    const reloaded = await store.get(meta.handle);
    expect(reloaded.intent?.url).toBe("/things/{{id}}");
    expect(reloaded.intent?.body).toEqual({ kind: "json", value: { plan: "{{plan}}" } });
  });

  it("omits a binary body rather than serializing it, and says so", async () => {
    const meta = await store.put(response("{}"), summary, {
      intent: {
        method: "PUT",
        url: "/upload",
        body: { kind: "bytes", content: new Uint8Array([1, 2, 3]) },
      },
    });

    const reloaded = await store.get(meta.handle);
    expect(reloaded.intent?.body).toBeUndefined();
    expect(reloaded.intent?.bodyOmitted).toBe(true);
    expect(reloaded.intent?.url).toBe("/upload");
  });

  // The intent is a file we write, so it is inside the redaction boundary with
  // the rest of the record — a caller may hardcode a credential rather than
  // reference one.
  it("redacts a hardcoded secret in the intent", async () => {
    const redactor = {
      redactDeep: <T>(v: T): T =>
        JSON.parse(JSON.stringify(v).replaceAll("sk-live-abcd1234", "[redacted]")) as T,
    };

    const meta = await store.put(response("{}"), summary, {
      redactor,
      intent: { method: "GET", url: "/things?key=sk-live-abcd1234" },
    });

    const reloaded = await store.get(meta.handle);
    expect(JSON.stringify(reloaded)).not.toContain("sk-live-abcd1234");
    expect(reloaded.intent?.url).toBe("/things?key=[redacted]");
  });

  it("leaves intent absent when none was supplied", async () => {
    const meta = await store.put(response("{}"), summary);
    expect((await store.get(meta.handle)).intent).toBeUndefined();
  });
});

describe("ResponseStore.list", () => {
  it("is empty before anything has run", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("returns runs newest first", async () => {
    const first = await store.put(response("one"), summary);
    const second = await store.put(response("two"), summary);
    const third = await store.put(response("three"), summary);

    const handles = (await store.list()).map((m) => m.handle);
    expect(handles).toEqual([third.handle, second.handle, first.handle]);
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i++) await store.put(response(`b${i}`), summary);
    expect(await store.list({ limit: 2 })).toHaveLength(2);
    expect(await store.list({ limit: 0 })).toEqual([]);
  });

  it("filters by method, status and url substring", async () => {
    await store.put(response("a"), { method: "GET", url: "https://x.test/users" });
    await store.put(response("b", { status: 404 }), {
      method: "POST",
      url: "https://x.test/orders",
    });

    expect(await store.list({ method: "post" })).toHaveLength(1);
    expect(await store.list({ status: 404 })).toHaveLength(1);
    expect((await store.list({ urlContains: "/users" }))[0]?.request.method).toBe("GET");
    expect(await store.list({ method: "GET", status: 404 })).toEqual([]);
  });

  // One unreadable file must not take the whole run log down with it.
  it("skips corrupt and foreign files", async () => {
    const good = await store.put(response("ok"), summary);
    await writeFile(join(root, "meta", "r_corrupt99.json"), "{ not json", "utf8");
    await writeFile(join(root, "meta", "notes.txt"), "ignore me", "utf8");

    const listed = await store.list();
    expect(listed.map((m) => m.handle)).toEqual([good.handle]);
  });
});
