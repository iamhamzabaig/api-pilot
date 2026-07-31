import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/cli/commands/env.js";
import { call, replay } from "../../src/cli/commands/run.js";
import { describe as describeCommand, search } from "../../src/cli/commands/spec.js";
import { history, inspect } from "../../src/cli/commands/store.js";
import { type FixtureServer, startFixtureServer } from "./fixture-server.js";

/**
 * The commands are driven in-process rather than by spawning the built CLI:
 * these assert command behaviour, and paying a process spawn per case would
 * make the suite slow enough that people stop running it. The spawn path —
 * dispatch, exit codes, cold start — is covered by `cold-start.test.ts` and the
 * CI smoke step.
 *
 * The server is real (NFR N7 forbids reaching the network, not the loopback).
 */

let server: FixtureServer;
let root: string;
const SECRET = "sk-live-canary-9f3a7d21";

/** Captures what a command wrote, since every command writes straight to stdout. */
async function capture(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

async function captureJson<T = Record<string, unknown>>(run: () => Promise<void>): Promise<T> {
  return JSON.parse(await capture(run)) as T;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

beforeEach(async () => {
  server = await startFixtureServer();
  root = await mkdtemp(join(tmpdir(), "api-pilot-cli-"));
  await mkdir(join(root, ".apipilot"), { recursive: true });

  process.env.API_PILOT_TEST_TOKEN = SECRET;

  await writeFile(
    join(root, ".apipilot", "environments.yaml"),
    [
      "version: 1",
      "default: local",
      "specs:",
      "  - billing.yaml",
      "environments:",
      "  local:",
      "    classification: safe",
      `    baseUrl: ${server.origin}`,
      "    variables:",
      "      who: world",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: YAML secret-reference syntax, not a JS template.
      "      apiToken: ${env:API_PILOT_TEST_TOKEN}",
      "    auth:",
      "      type: bearer",
      '      token: "{{apiToken}}"',
      "  prod:",
      "    classification: production",
      `    baseUrl: ${server.origin}`,
      "",
    ].join("\n"),
    "utf8",
  );

  // The spec fixture is copied in so the workspace's `specs:` list resolves.
  const spec = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(process.cwd(), "tests", "fixtures", "specs", "billing.yaml"), "utf8"),
  );
  await writeFile(join(root, "billing.yaml"), spec, "utf8");
});

afterEach(async () => {
  process.env.API_PILOT_TEST_TOKEN = undefined;
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("api-pilot env", () => {
  it("lists environments and marks the default", async () => {
    const out = await capture(() => env(["--dir", root]));
    expect(out).toContain("* local");
    expect(out).toContain("  prod");
  });

  it("resolves one environment without printing its secret", async () => {
    const out = await capture(() => env(["local", "--dir", root]));
    expect(out).toContain("classification: safe");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(SECRET);
  });

  it("keeps the secret out of --json too", async () => {
    const payload = await captureJson(() => env(["local", "--dir", root, "--json"]));
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  // Resolving reads secrets; listing must not, or one missing env var hides
  // every environment from you.
  it("lists even when a secret cannot be resolved", async () => {
    process.env.API_PILOT_TEST_TOKEN = undefined;
    const out = await capture(() => env(["--dir", root]));
    expect(out).toContain("* local");
  });
});

describe("api-pilot search / describe", () => {
  it("ranks a natural-language query", async () => {
    const payload = await captureJson<{ hits: { id: string }[] }>(() =>
      search(["list", "invoices", "--dir", root, "--limit", "3", "--json"]),
    );
    expect(payload.hits[0]?.id).toBe("listInvoices");
  });

  it("describes an operation within its budget", async () => {
    const out = await capture(() => describeCommand(["listInvoices", "--dir", root]));
    expect(out).toContain("GET /v1/invoices");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024 + 1);
  });

  it("reports an unknown operation id", async () => {
    const error = await describeCommand(["nope", "--dir", root]).catch((e: unknown) => e);
    expect(codeOf(error)).toBe("NOT_FOUND");
  });

  it("needs a query", async () => {
    expect(codeOf(await search(["--dir", root]).catch((e: unknown) => e))).toBe("INVALID_REQUEST");
  });
});

describe("api-pilot call", () => {
  it("executes, interpolates variables, and returns a handle", async () => {
    const payload = await captureJson<{ handle: string; status: number; url: string }>(() =>
      call(["GET", "/echo?greet={{who}}", "--dir", root, "--json"]),
    );

    expect(payload.status).toBe(200);
    expect(payload.handle).toMatch(/^r_/);
    expect(payload.url).toContain("greet=world");
    expect(server.requests[0]?.url).toContain("greet=world");
  });

  it("sends the credential but never prints it", async () => {
    const out = await capture(() => call(["GET", "/echo", "--dir", root, "--json"]));

    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(out).not.toContain(SECRET);
  });

  it("sends a body and a header", async () => {
    await capture(() =>
      call([
        "POST",
        "/echo",
        "--body",
        '{"amount":100}',
        "--content-type",
        "application/json",
        "-H",
        "X-Trace: abc",
        "--dir",
        root,
        "--json",
      ]),
    );

    expect(server.requests[0]?.body).toBe('{"amount":100}');
    expect(server.requests[0]?.headers["x-trace"]).toBe("abc");
  });

  it("refuses a mutating call against production until confirmed", async () => {
    const blocked = await call(["POST", "/echo", "--env", "prod", "--dir", root]).catch(
      (e: unknown) => e,
    );
    expect(codeOf(blocked)).toBe("CONFIRMATION_REQUIRED");

    const allowed = await captureJson<{ status: number }>(() =>
      call(["POST", "/echo", "--env", "prod", "--confirm", "--dir", root, "--json"]),
    );
    expect(allowed.status).toBe(200);
  });

  it("rejects a malformed header", async () => {
    const error = await call(["GET", "/ok", "-H", "nocolon", "--dir", root]).catch(
      (e: unknown) => e,
    );
    expect(codeOf(error)).toBe("INVALID_REQUEST");
  });

  it("needs a method and a URL", async () => {
    expect(codeOf(await call(["GET", "--dir", root]).catch((e: unknown) => e))).toBe(
      "INVALID_REQUEST",
    );
  });
});

describe("api-pilot history / inspect / replay", () => {
  it("records runs newest first and honours filters", async () => {
    await capture(() => call(["GET", "/ok", "--dir", root, "--json"]));
    await capture(() => call(["POST", "/echo", "--body", "x", "--dir", root, "--json"]));

    const all = await captureJson<{ runs: { method: string }[] }>(() =>
      history(["--dir", root, "--json"]),
    );
    expect(all.runs.map((r) => r.method)).toEqual(["POST", "GET"]);

    const posts = await captureJson<{ runs: unknown[] }>(() =>
      history(["--dir", root, "--method", "POST", "--json"]),
    );
    expect(posts.runs).toHaveLength(1);
  });

  it("inspects a stored response by path, range and headers", async () => {
    const { handle } = await captureJson<{ handle: string }>(() =>
      call(["GET", "/ok", "--dir", root, "--json"]),
    );

    const byPath = await captureJson<{ text: string; matchCount: number }>(() =>
      inspect([handle, "--path", "name", "--dir", root, "--json"]),
    );
    expect(byPath.text).toContain("api-pilot");
    expect(byPath.matchCount).toBe(1);

    const byRange = await captureJson<{ text: string }>(() =>
      inspect([handle, "--range", "0:4", "--dir", root, "--json"]),
    );
    expect(byRange.text).toHaveLength(4);

    const headers = await captureJson<{ kind: string }>(() =>
      inspect([handle, "--headers", "--dir", root, "--json"]),
    );
    expect(headers.kind).toBe("headers");
  });

  it("rejects a malformed range and an unknown handle", async () => {
    expect(
      codeOf(await inspect(["r_deadbeef1", "--range", "nope", "--dir", root]).catch((e) => e)),
    ).toBe("INVALID_REQUEST");
    expect(codeOf(await inspect(["r_deadbeef1", "--dir", root]).catch((e) => e))).toBe("NOT_FOUND");
  });

  it("replays a recorded call, body and all", async () => {
    const first = await captureJson<{ handle: string }>(() =>
      call(["POST", "/echo", "--body", '{"amount":100}', "--dir", root, "--json"]),
    );

    const again = await captureJson<{ handle: string; status: number }>(() =>
      replay([first.handle, "--dir", root, "--json"]),
    );

    expect(again.handle).not.toBe(first.handle);
    expect(again.status).toBe(200);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.body).toBe('{"amount":100}');
    expect(server.requests[1]?.method).toBe("POST");
  });

  // The stored intent is the template, so another environment re-resolves it.
  it("replays against a different environment, and the gate still applies", async () => {
    const { handle } = await captureJson<{ handle: string }>(() =>
      call(["POST", "/echo", "--body", "x", "--dir", root, "--json"]),
    );

    const blocked = await replay([handle, "--env", "prod", "--dir", root]).catch((e: unknown) => e);
    expect(codeOf(blocked)).toBe("CONFIRMATION_REQUIRED");

    const allowed = await captureJson<{ environment: string }>(() =>
      replay([handle, "--env", "prod", "--confirm", "--dir", root, "--json"]),
    );
    expect(allowed.environment).toBe("prod");
  });

  it("reports a run that has no replayable intent", async () => {
    const error = await replay(["r_deadbeef1", "--dir", root]).catch((e: unknown) => e);
    expect(codeOf(error)).toBe("NOT_FOUND");
  });
});

describe("--json is available on every command", () => {
  it("parses as JSON for each of the seven", async () => {
    const { handle } = await captureJson<{ handle: string }>(() =>
      call(["GET", "/ok", "--dir", root, "--json"]),
    );

    const invocations: [string, () => Promise<void>][] = [
      ["search", () => search(["invoices", "--dir", root, "--json"])],
      ["describe", () => describeCommand(["listInvoices", "--dir", root, "--json"])],
      ["call", () => call(["GET", "/ok", "--dir", root, "--json"])],
      ["replay", () => replay([handle, "--dir", root, "--json"])],
      ["inspect", () => inspect([handle, "--dir", root, "--json"])],
      ["history", () => history(["--dir", root, "--json"])],
      ["env", () => env(["--dir", root, "--json"])],
    ];

    for (const [name, run] of invocations) {
      const out = await capture(run);
      expect(() => JSON.parse(out), `${name} --json`).not.toThrow();
    }
  });
});
