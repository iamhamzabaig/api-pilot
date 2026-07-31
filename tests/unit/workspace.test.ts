import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiPilotError } from "../../src/core/errors.js";
import { WORKSPACE_DIRNAME, Workspace } from "../../src/core/workspace/workspace.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "api-pilot-ws-"));
  await mkdir(join(root, WORKSPACE_DIRNAME), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeEnvironments(yaml: string, filename = "environments.yaml"): Promise<void> {
  await writeFile(join(root, WORKSPACE_DIRNAME, filename), yaml, "utf8");
}

/** Fails loudly if the promise resolves, so a passing test cannot be a no-op. */
async function caught(promise: Promise<unknown>): Promise<ApiPilotError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection, got a value");
    },
    (error: unknown) => error as ApiPilotError,
  );
}

const BASIC = `
default: local
environments:
  local:
    baseUrl: http://localhost:3000
    variables:
      apiVersion: v1
  prod:
    classification: production
    baseUrl: https://api.example.com
    allowedHosts: ["api.example.com", ".cdn.example.com"]
`;

describe("Workspace", () => {
  it("loads environments and honours the declared default", async () => {
    await writeEnvironments(BASIC);
    const workspace = await Workspace.load(root);

    expect(workspace.environmentNames).toEqual(["local", "prod"]);
    expect(workspace.defaultEnvironmentName).toBe("local");
  });

  it("finds the workspace from a nested directory", async () => {
    await writeEnvironments(BASIC);
    const nested = join(root, "src", "deep");
    await mkdir(nested, { recursive: true });

    const workspace = await Workspace.find(nested);
    expect(workspace.environmentNames).toContain("prod");
  });

  it("derives allowedHosts from baseUrl when none are declared", async () => {
    await writeEnvironments(BASIC);
    const { environment } = await (await Workspace.load(root)).resolveEnvironment("local");
    expect(environment.allowedHosts).toEqual(["localhost"]);
  });

  it("keeps an explicit allowedHosts list", async () => {
    await writeEnvironments(BASIC);
    const { environment } = await (await Workspace.load(root)).resolveEnvironment("prod");
    expect(environment.allowedHosts).toEqual(["api.example.com", ".cdn.example.com"]);
    expect(environment.classification).toBe("production");
  });

  it("merges the gitignored local overrides key-wise", async () => {
    await writeEnvironments(BASIC);
    await writeEnvironments(
      `
default: prod
environments:
  local:
    variables:
      apiVersion: v2
      extra: added
`,
      "environments.local.yaml",
    );

    const workspace = await Workspace.load(root);
    expect(workspace.defaultEnvironmentName).toBe("prod");

    const { environment } = await workspace.resolveEnvironment("local");
    expect(environment.variables.get("apiVersion")).toBe("v2");
    expect(environment.variables.get("extra")).toBe("added");
    // The override touched variables only; the rest of the environment stands.
    expect(environment.baseUrl).toBe("http://localhost:3000");
  });

  it("resolves env-var secret references and marks them secret", async () => {
    process.env.API_PILOT_TEST_TOKEN = "resolved-secret-value";
    await writeEnvironments(`
environments:
  local:
    baseUrl: http://localhost:3000
    variables:
      token: \${env:API_PILOT_TEST_TOKEN}
      public: plain
`);

    const { environment, redactor } = await (await Workspace.load(root)).resolveEnvironment();

    expect(environment.variables.get("token")).toBe("resolved-secret-value");
    expect(environment.secretNames).toEqual(["token"]);
    expect(redactor.redact("resolved-secret-value")).not.toContain("resolved-secret-value");
    delete process.env.API_PILOT_TEST_TOKEN;
  });

  it("resolves file secret references relative to the workspace root", async () => {
    await writeFile(join(root, "token.txt"), "file-secret-value\n", "utf8");
    await writeEnvironments(`
environments:
  local:
    baseUrl: http://localhost:3000
    variables:
      token: \${file:./token.txt}
`);

    const { environment } = await (await Workspace.load(root)).resolveEnvironment();
    // Trailing newlines in secret files are never intended.
    expect(environment.variables.get("token")).toBe("file-secret-value");
  });

  it("reports a missing environment variable rather than sending an empty header", async () => {
    delete process.env.API_PILOT_DEFINITELY_UNSET;
    await writeEnvironments(`
environments:
  local:
    baseUrl: http://localhost:3000
    variables:
      token: \${env:API_PILOT_DEFINITELY_UNSET}
`);

    const error = await caught((await Workspace.load(root)).resolveEnvironment());
    expect(error.code).toBe("SECRET_UNRESOLVED");
  });

  // M3 acceptance: a credential written literally into the committed file has
  // to be loud, because the damage is done the moment it is pushed.
  it("warns when a credential-shaped variable holds a literal value", async () => {
    await writeEnvironments(`
environments:
  local:
    baseUrl: http://localhost:3000
    variables:
      apiToken: sk_live_oops_this_is_committed
      pageSize: "25"
`);

    const workspace = await Workspace.load(root);
    expect(workspace.warnings).toHaveLength(1);
    expect(workspace.warnings[0]).toContain("apiToken");
    expect(workspace.warnings[0]).toContain("${env:");
  });

  it("does not warn about a literal in the gitignored local file", async () => {
    await writeEnvironments(BASIC);
    await writeEnvironments(
      `
environments:
  local:
    variables:
      apiToken: local-only-literal
`,
      "environments.local.yaml",
    );

    expect((await Workspace.load(root)).warnings).toEqual([]);
  });

  it("rejects a malformed environments file with a useful message", async () => {
    await writeEnvironments(`
environments:
  local:
    classification: nonsense
`);

    const error = await caught(Workspace.load(root));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.hint).toContain("classification");
  });

  it("names the environments that exist when one is missing", async () => {
    await writeEnvironments(BASIC);
    const error = await caught((await Workspace.load(root)).resolveEnvironment("staging"));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("local");
  });
});
