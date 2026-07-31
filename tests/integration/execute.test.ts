import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiPilotError } from "../../src/core/errors.js";
import { execute } from "../../src/core/exec/execute.js";
import type { RetryPolicy } from "../../src/core/request/types.js";
import { type FixtureServer, findClosedPort, startFixtureServer } from "./fixture-server.js";

/** Keeps retry tests fast without disabling the code path under test. */
const FAST_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 };
const NO_RETRY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

let server: FixtureServer;
let other: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
  other = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
  await other.close();
});

describe("status handling", () => {
  it("returns a 2xx response with body and headers", async () => {
    const res = await execute({ method: "GET", url: `${server.origin}/ok` });

    expect(res.status).toBe(200);
    expect(res.attempts).toBe(1);
    expect(res.redirects).toEqual([]);
    expect(JSON.parse(text(res.body))).toEqual({ ok: true, name: "api-pilot" });
    expect(res.headers.find((h) => h.name === "content-type")?.value).toBe("application/json");
  });

  it("returns 4xx as a response rather than throwing", async () => {
    const res = await execute({ method: "GET", url: `${server.origin}/status/404` });
    expect(res.status).toBe(404);
  });

  it("returns 5xx as a response rather than throwing", async () => {
    const res = await execute({
      method: "GET",
      url: `${server.origin}/status/500`,
      retry: NO_RETRY,
    });
    expect(res.status).toBe(500);
  });

  it("preserves repeated set-cookie headers instead of folding them", async () => {
    const res = await execute({ method: "GET", url: `${server.origin}/set-cookies` });
    const cookies = res.headers.filter((h) => h.name === "set-cookie").map((h) => h.value);
    expect(cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});

describe("failure modes", () => {
  it("raises TIMEOUT when the per-attempt budget is exceeded", async () => {
    const error = await execute({
      method: "GET",
      url: `${server.origin}/slow?ms=1000`,
      timeoutMs: 50,
      retry: NO_RETRY,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiPilotError);
    expect((error as ApiPilotError).code).toBe("TIMEOUT");
  });

  it("raises NETWORK when the connection is refused", async () => {
    const port = await findClosedPort();

    const error = await execute({
      method: "GET",
      url: `http://127.0.0.1:${port}/ok`,
      retry: NO_RETRY,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiPilotError);
    expect((error as ApiPilotError).code).toBe("NETWORK");
    // The useful detail lives in fetch's `cause`, not its own message.
    expect((error as ApiPilotError).message).not.toContain("fetch failed");
  });

  it("rejects a non-http protocol before opening a socket", async () => {
    const error = await execute({ method: "GET", url: "file:///etc/passwd" }).catch(
      (e: unknown) => e,
    );
    expect((error as ApiPilotError).code).toBe("INVALID_REQUEST");
  });

  it("raises ABORTED when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = execute(
      { method: "GET", url: `${server.origin}/slow?ms=1000`, retry: NO_RETRY },
      { signal: controller.signal },
    ).catch((e: unknown) => e);

    controller.abort();
    expect(((await pending) as ApiPilotError).code).toBe("ABORTED");
  });
});

describe("redirects", () => {
  it("follows a chain and reports every hop", async () => {
    const res = await execute({ method: "GET", url: `${server.origin}/redirect/3` });

    expect(res.status).toBe(200);
    expect(res.url).toBe(`${server.origin}/ok`);
    expect(res.redirects).toEqual([
      `${server.origin}/redirect/3`,
      `${server.origin}/redirect/2`,
      `${server.origin}/redirect/1`,
    ]);
  });

  it("raises TOO_MANY_REDIRECTS on a loop", async () => {
    const error = await execute({
      method: "GET",
      url: `${server.origin}/redirect-loop`,
      maxRedirects: 3,
    }).catch((e: unknown) => e);

    expect((error as ApiPilotError).code).toBe("TOO_MANY_REDIRECTS");
  });

  it("drops Authorization when a redirect crosses origins", async () => {
    const target = encodeURIComponent(`${other.origin}/echo`);
    const res = await execute({
      method: "GET",
      url: `${server.origin}/redirect-to?url=${target}`,
      headers: { authorization: "Bearer super-secret" },
    });

    expect(JSON.parse(text(res.body)).authorization).toBeNull();
  });

  it("keeps Authorization on a same-origin redirect", async () => {
    const target = encodeURIComponent(`${server.origin}/echo`);
    const res = await execute({
      method: "GET",
      url: `${server.origin}/redirect-to?url=${target}`,
      headers: { authorization: "Bearer super-secret" },
    });

    expect(JSON.parse(text(res.body)).authorization).toBe("Bearer super-secret");
  });

  it("rewrites POST to GET and drops the body on a 303", async () => {
    const target = encodeURIComponent(`${server.origin}/echo`);
    const res = await execute({
      method: "POST",
      url: `${server.origin}/redirect-to?url=${target}&status=303`,
      body: { kind: "json", value: { a: 1 } },
    });

    const echoed = JSON.parse(text(res.body));
    expect(echoed.method).toBe("GET");
    expect(echoed.body).toBe("");
    expect(echoed.contentType).toBeNull();
    expect(res.method).toBe("GET");
  });

  it("preserves method and body on a 307", async () => {
    const target = encodeURIComponent(`${server.origin}/echo`);
    const res = await execute({
      method: "POST",
      url: `${server.origin}/redirect-to?url=${target}&status=307`,
      body: { kind: "json", value: { a: 1 } },
    });

    const echoed = JSON.parse(text(res.body));
    expect(echoed.method).toBe("POST");
    expect(JSON.parse(echoed.body)).toEqual({ a: 1 });
  });
});

describe("bodies", () => {
  it("reads a 5 MB response intact", async () => {
    const bytes = 5 * 1024 * 1024;
    const res = await execute({ method: "GET", url: `${server.origin}/big?bytes=${bytes}` });

    expect(res.body.byteLength).toBe(bytes);
    expect(res.bodyTruncated).toBe(false);
  });

  it("truncates at maxResponseBytes and flags it", async () => {
    const res = await execute({
      method: "GET",
      url: `${server.origin}/big?bytes=${1024 * 1024}`,
      maxResponseBytes: 4096,
    });

    expect(res.body.byteLength).toBe(4096);
    expect(res.bodyTruncated).toBe(true);
  });

  it("sends a JSON body with the derived content type", async () => {
    const res = await execute({
      method: "POST",
      url: `${server.origin}/echo`,
      body: { kind: "json", value: { hello: "world" } },
    });

    const echoed = JSON.parse(text(res.body));
    expect(echoed.contentType).toBe("application/json");
    expect(JSON.parse(echoed.body)).toEqual({ hello: "world" });
  });

  it("lets an explicit content-type header override the derived one", async () => {
    const res = await execute({
      method: "POST",
      url: `${server.origin}/echo`,
      headers: { "Content-Type": "application/vnd.custom+json" },
      body: { kind: "json", value: { hello: "world" } },
    });

    expect(JSON.parse(text(res.body)).contentType).toBe("application/vnd.custom+json");
  });

  it("returns an empty body for a 204", async () => {
    const res = await execute({ method: "GET", url: `${server.origin}/status/204` });
    expect(res.status).toBe(204);
    expect(res.body.byteLength).toBe(0);
  });
});

describe("retries", () => {
  it("retries an idempotent request through a transient 503", async () => {
    const res = await execute({
      method: "GET",
      url: `${server.origin}/flaky?key=get&failures=2`,
      retry: FAST_RETRY,
    });

    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
  });

  it("gives up after maxAttempts and returns the last response", async () => {
    const res = await execute({
      method: "GET",
      url: `${server.origin}/flaky?key=exhausted&failures=99`,
      retry: FAST_RETRY,
    });

    expect(res.status).toBe(503);
    expect(res.attempts).toBe(3);
  });

  it("never retries a non-idempotent request", async () => {
    const res = await execute({
      method: "POST",
      url: `${server.origin}/flaky?key=post&failures=2`,
      retry: FAST_RETRY,
    });

    expect(res.status).toBe(503);
    expect(res.attempts).toBe(1);
  });

  it("retries a network failure, not just a bad status", async () => {
    const hits = () => server.requests.filter((r) => r.url === "/reset").length;
    const before = hits();

    const error = await execute({
      method: "GET",
      url: `${server.origin}/reset`,
      retry: FAST_RETRY,
    }).catch((e: unknown) => e);

    expect((error as ApiPilotError).code).toBe("NETWORK");
    expect(hits() - before).toBe(FAST_RETRY.maxAttempts);
  });
});
