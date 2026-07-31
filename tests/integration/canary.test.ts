import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest } from "../../src/core/digest/digest.js";
import type { ApiPilotError } from "../../src/core/errors.js";
import { execute } from "../../src/core/exec/execute.js";
import { inspect } from "../../src/core/inspect/inspect.js";
import { redirectGuard } from "../../src/core/policy/policy.js";
import { redactError } from "../../src/core/redact/redactor.js";
import { prepareRequest, type RequestIntent } from "../../src/core/request/prepare.js";
import { ResponseStore } from "../../src/core/store/response-store.js";
import { WORKSPACE_DIRNAME, Workspace } from "../../src/core/workspace/workspace.js";
import { type FixtureServer, findClosedPort, startFixtureServer } from "./fixture-server.js";

/**
 * M3 acceptance suite.
 *
 * A unique canary is injected through every configuration path that can carry
 * a credential. The requests are really sent, so the canaries really travel;
 * the assertions are that none of them come back out through anything a human
 * or a model would ever read.
 *
 * A test that passes because nothing works is worthless, so each case also
 * asserts the secret *did* reach the wire.
 */

const CANARY = {
  bearer: "CANARY-bearer-9f3a2b8c7d1e",
  basic: "CANARY-basic-4d7e1a9b3c6f",
  queryKey: "CANARY-query-2b8c4d7e1a9f",
  headerKey: "CANARY-header-6f3a2b8c7d1e",
  path: "CANARY-path-1a9b3c6f4d7e",
  body: "CANARY-body-7d1e9f3a2b8c",
} as const;

const ALL_CANARIES = Object.values(CANARY);

let root: string;
let server: FixtureServer;
let workspace: Workspace;
let store: ResponseStore;

beforeAll(async () => {
  server = await startFixtureServer();
  root = await mkdtemp(join(tmpdir(), "api-pilot-canary-"));
  await mkdir(join(root, WORKSPACE_DIRNAME), { recursive: true });

  process.env.CANARY_BEARER = CANARY.bearer;
  process.env.CANARY_QUERY = CANARY.queryKey;
  process.env.CANARY_HEADER = CANARY.headerKey;
  process.env.CANARY_PATH = CANARY.path;
  process.env.CANARY_BODY = CANARY.body;

  await writeFile(join(root, "basic-password.txt"), `${CANARY.basic}\n`, "utf8");

  await writeFile(
    join(root, WORKSPACE_DIRNAME, "environments.yaml"),
    `
default: bearerEnv
environments:
  bearerEnv:
    baseUrl: ${server.origin}
    allowedHosts: ["127.0.0.1"]
    variables:
      bearerToken: \${env:CANARY_BEARER}
      pathSecret: \${env:CANARY_PATH}
      bodySecret: \${env:CANARY_BODY}
    auth:
      type: bearer
      token: "{{bearerToken}}"

  basicEnv:
    baseUrl: ${server.origin}
    allowedHosts: ["127.0.0.1"]
    variables:
      password: \${file:./basic-password.txt}
    auth:
      type: basic
      username: canary-user
      password: "{{password}}"

  queryKeyEnv:
    baseUrl: ${server.origin}
    allowedHosts: ["127.0.0.1"]
    variables:
      key: \${env:CANARY_QUERY}
    auth:
      type: apikey
      name: api_key
      in: query
      value: "{{key}}"

  headerKeyEnv:
    baseUrl: ${server.origin}
    allowedHosts: ["127.0.0.1"]
    variables:
      key: \${env:CANARY_HEADER}
    auth:
      type: apikey
      name: X-Api-Key
      in: header
      value: "{{key}}"
`,
    "utf8",
  );

  workspace = await Workspace.load(root);
  store = new ResponseStore(join(root, WORKSPACE_DIRNAME, ".cache"));
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env).filter((k) => k.startsWith("CANARY_"))) {
    delete process.env[key];
  }
});

/** Everything a human or a model could see from one call. */
async function callAndCollect(
  environmentName: string,
  intent: RequestIntent,
): Promise<{ streams: string[]; wire: string }> {
  const bundle = await workspace.resolveEnvironment(environmentName);
  const prepared = prepareRequest(intent, bundle);

  const before = server.requests.length;
  const response = await execute(prepared.request, {
    allowRedirectTo: redirectGuard(prepared.environment),
  });
  const wireRequests = server.requests.slice(before);

  const meta = await store.put(response, prepared.summary, { redactor: bundle.redactor });
  const metaOnDisk = await readFile(
    join(root, WORKSPACE_DIRNAME, ".cache", "meta", `${meta.handle}.json`),
    "utf8",
  );

  const { redactor } = bundle;
  return {
    streams: [
      JSON.stringify(prepared.summary),
      digest(response, { handle: meta.handle, redactor }).text,
      inspect(response, { redactor }).text,
      inspect(response, { headers: true, redactor }).text,
      metaOnDisk,
    ],
    wire: JSON.stringify(wireRequests),
  };
}

function expectNoCanaries(streams: readonly string[], label: string): void {
  for (const stream of streams) {
    for (const canary of ALL_CANARIES) {
      expect(stream, `${label}: leaked ${canary}`).not.toContain(canary);
    }
    // The base64 form is the one that slips past a naive raw-string redactor.
    for (const canary of ALL_CANARIES) {
      expect(stream, `${label}: leaked base64 of ${canary}`).not.toContain(
        Buffer.from(canary, "utf8").toString("base64"),
      );
    }
  }
}

describe("canary suite", () => {
  it("keeps a bearer token out of every output, and still sends it", async () => {
    // /echo reflects the Authorization header into the response body, so this
    // also covers a service that hands your own credential back to you.
    const { streams, wire } = await callAndCollect("bearerEnv", { method: "GET", url: "/echo" });

    expect(wire).toContain(CANARY.bearer);
    expectNoCanaries(streams, "bearer");
  });

  it("keeps a file-sourced Basic password out of every output", async () => {
    const { streams, wire } = await callAndCollect("basicEnv", { method: "GET", url: "/echo" });

    const encoded = Buffer.from(`canary-user:${CANARY.basic}`, "utf8").toString("base64");
    expect(wire).toContain(encoded);
    expectNoCanaries(streams, "basic");
    for (const stream of streams) {
      expect(stream, "basic: leaked the combined credential blob").not.toContain(encoded);
    }
  });

  it("keeps an API key in the query string out of every output", async () => {
    const { streams, wire } = await callAndCollect("queryKeyEnv", { method: "GET", url: "/echo" });

    expect(wire).toContain(CANARY.queryKey);
    expectNoCanaries(streams, "apikey-query");
  });

  it("keeps an API key in a header out of every output", async () => {
    const { streams, wire } = await callAndCollect("headerKeyEnv", { method: "GET", url: "/echo" });

    expect(wire).toContain(CANARY.headerKey);
    expectNoCanaries(streams, "apikey-header");
  });

  it("keeps a secret used in the URL path out of every output", async () => {
    const { streams, wire } = await callAndCollect("bearerEnv", {
      method: "GET",
      url: "/echo?tenant={{pathSecret}}",
    });

    expect(wire).toContain(CANARY.path);
    expectNoCanaries(streams, "path");
  });

  it("keeps a secret used in a JSON body out of every output", async () => {
    const { streams, wire } = await callAndCollect("bearerEnv", {
      method: "POST",
      url: "/echo",
      body: { kind: "json", value: { credential: "{{bodySecret}}", note: "hello" } },
    });

    expect(wire).toContain(CANARY.body);
    expectNoCanaries(streams, "body");
  });

  it("keeps secrets out of error messages, stacks, and causes", async () => {
    const bundle = await workspace.resolveEnvironment("queryKeyEnv");
    const port = await findClosedPort();
    const prepared = prepareRequest(
      { method: "GET", url: `http://127.0.0.1:${port}/echo` },
      bundle,
    );

    const error = (await execute({
      ...prepared.request,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }).catch((e: unknown) => e)) as ApiPilotError;

    // The raw message names the failing URL, key and all — that is the leak
    // this guards against.
    expect(error.message).toContain(CANARY.queryKey);

    redactError(error, bundle.redactor);
    expectNoCanaries([error.message, error.stack ?? ""], "error");
  });

  it("leaves no canary anywhere in the stored metadata directory", async () => {
    const metaDir = join(root, WORKSPACE_DIRNAME, ".cache", "meta");
    const files = await readdir(metaDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const contents = await readFile(join(metaDir, file), "utf8");
      expectNoCanaries([contents], `meta/${file}`);
    }
  });
});
