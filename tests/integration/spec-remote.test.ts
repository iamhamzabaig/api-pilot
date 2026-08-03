import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiPilotError } from "../../src/core/errors.js";
import { loadRemoteSpec } from "../../src/core/spec/remote.js";
import { SpecIndex } from "../../src/core/spec/spec-index.js";
import { type FixtureServer, startFixtureServer } from "./fixture-server.js";

/**
 * Loading a spec from a URL, which is the one place where *indexing* touches the
 * network. Every case here talks to a loopback fixture server; nothing in this
 * repo may reach the public internet (NFR N7).
 */

let server: FixtureServer;
let cacheDir: string;
let specUrl: string;

beforeEach(async () => {
  server = await startFixtureServer();
  cacheDir = await mkdtemp(join(tmpdir(), "api-pilot-remote-"));
  specUrl = `${server.origin}/spec.yaml`;
});

afterEach(async () => {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
});

function hits(): number {
  return server.requests.filter((request) => request.url === "/spec.yaml").length;
}

describe("loading a spec over HTTP", () => {
  it("indexes operations from a URL", async () => {
    const index = await SpecIndex.fromPaths([specUrl], { cacheDir });

    expect(index.size).toBe(2);
    expect(index.search("remove a widget")[0]?.operation.method).toBe("DELETE");
    expect(index.warnings).toEqual([]);
  });

  it("fetches once and serves the rest from the cache", async () => {
    await SpecIndex.fromPaths([specUrl], { cacheDir });
    await SpecIndex.fromPaths([specUrl], { cacheDir });
    await SpecIndex.fromPaths([specUrl], { cacheDir });

    expect(hits()).toBe(1);
  });

  it("refetches once the cached copy is older than the TTL", async () => {
    await SpecIndex.fromPaths([specUrl], { cacheDir });

    const cached = join(cacheDir, "specs", (await readdir(join(cacheDir, "specs")))[0] as string);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(cached, twoDaysAgo, twoDaysAgo);

    await SpecIndex.fromPaths([specUrl], { cacheDir });
    expect(hits()).toBe(2);
  });

  it("falls back to a stale copy when the fetch fails, and says so", async () => {
    await SpecIndex.fromPaths([specUrl], { cacheDir });

    const cached = join(cacheDir, "specs", (await readdir(join(cacheDir, "specs")))[0] as string);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(cached, twoDaysAgo, twoDaysAgo);
    await server.close();

    const index = await SpecIndex.fromPaths([specUrl], { cacheDir });

    // A spec is a description, not state: a day-old description still answers
    // "which endpoint deletes a widget", and going offline should not break it.
    expect(index.size).toBe(2);
    expect(index.warnings.join("\n")).toContain("Using a cached copy");
  });

  it("fails with no cached copy to fall back to", async () => {
    await server.close();

    const error = (await loadRemoteSpec(specUrl, { cacheDir }).catch(
      (e: unknown) => e,
    )) as ApiPilotError;

    expect(error.code).toBe("NETWORK");
  });

  it("works without a cache directory, refetching every time", async () => {
    await SpecIndex.fromPaths([specUrl]);
    await SpecIndex.fromPaths([specUrl]);

    expect(hits()).toBe(2);
  });

  it("refuses a redirect that leaves the configured host", async () => {
    // Same port, different hostname — a configured spec URL authorises that
    // host, not wherever its Location header points.
    const target = `http://localhost:${new URL(server.origin).port}/spec.yaml`;
    const error = (await loadRemoteSpec(
      `${server.origin}/redirect-to?url=${encodeURIComponent(target)}`,
      { cacheDir },
    ).catch((e: unknown) => e)) as ApiPilotError;

    expect(error.code).toBe("POLICY_BLOCKED");
  });

  it("refuses a protocol that is not http or https", async () => {
    const error = (await loadRemoteSpec("ftp://example.com/openapi.yaml").catch(
      (e: unknown) => e,
    )) as ApiPilotError;

    expect(error.code).toBe("POLICY_BLOCKED");
  });

  it("reports a fetch that returned an error status", async () => {
    const error = (await loadRemoteSpec(`${server.origin}/status/404`, { cacheDir }).catch(
      (e: unknown) => e,
    )) as ApiPilotError;

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("404");
  });

  it("indexes a local path and a URL in the same workspace list", async () => {
    const index = await SpecIndex.fromPaths(["tests/fixtures/specs/billing.yaml", specUrl], {
      cacheDir,
    });

    expect(index.search("list widgets")[0]?.operation.id).toBe("listWidgets");
    expect(index.search("list customers")[0]?.operation.id).toBe("listCustomers");
  });
});
