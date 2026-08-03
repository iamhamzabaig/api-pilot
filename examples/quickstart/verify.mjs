#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Runs the command sequence in this directory's README against the local widget
 * store and checks what comes back.
 *
 * An example nobody executes is a liability: it drifts from the tool, and the
 * first person to find out is a new user following it. This is what CI runs, so
 * a README command that stops working fails the build.
 *
 * It needs a build first (`pnpm run build`) — it drives `dist/cli/index.js`, the
 * same file `npx @hamzu/api-pilot` resolves to.
 */

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const CLI = join(repoRoot, "dist", "cli", "index.js");

const PORT = process.env.WIDGET_PORT ?? "8787";
const TOKEN = "example-token-not-a-real-secret";

/**
 * Every command runs with `--dir`, so the example works from any cwd.
 *
 * `WIDGET_PROD_TOKEN` is set even though nothing calls production: without it
 * the `prod` environment fails at secret resolution, and the confirmation-gate
 * check below would pass for the wrong reason.
 */
async function cli(...args) {
  const { stdout } = await run(process.execPath, [CLI, ...args, "--dir", here], {
    env: {
      ...process.env,
      WIDGET_TOKEN: TOKEN,
      WIDGET_PORT: PORT,
      WIDGET_PROD_TOKEN: "unused-but-resolvable",
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function check(label, condition, detail) {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
    return;
  }
  process.stderr.write(`  FAIL ${label}\n${detail ?? ""}\n`);
  process.exitCode = 1;
}

async function startServer() {
  const child = spawn(process.execPath, [join(here, "server.mjs")], {
    env: { ...process.env, WIDGET_TOKEN: TOKEN, WIDGET_PORT: PORT },
    stdio: ["ignore", "pipe", "inherit"],
  });

  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the widget store exited with ${code}`)));
  });

  return child;
}

const server = await startServer();

try {
  // A fresh run every time: the assertions below are about what this run
  // produced, not about whatever is left in the cache from the last one.
  await rm(join(here, ".apipilot", ".cache"), { recursive: true, force: true });

  process.stdout.write("env\n");
  const env = JSON.parse(await cli("env", "local", "--json"));
  check("the environment resolves", env.name === "local");
  check(
    "the token reads as [redacted], never as its value",
    env.variables.every((v) => !JSON.stringify(v).includes(TOKEN)),
    JSON.stringify(env.variables),
  );

  process.stdout.write("search\n");
  const search = JSON.parse(await cli("search", "remove a widget", "--json"));
  check(
    "a natural-language query finds the right operation",
    search.hits[0]?.id === "deleteWidget",
  );
  check("the spec loaded without warnings", search.warnings.length === 0, `${search.warnings}`);

  process.stdout.write("describe\n");
  const described = JSON.parse(await cli("describe", "createWidget", "--json"));
  check("describe renders the request body", described.text.includes("name"));
  check("describe stays inside its byte budget", Buffer.byteLength(described.text) <= 1024);

  process.stdout.write("call\n");
  const call = JSON.parse(await cli("call", "GET", "/widgets?limit=400", "--json"));
  check("the request authenticated", call.status === 200, JSON.stringify(call));
  check("the body is large", call.bodyBytes > 30_000, `${call.bodyBytes} bytes`);
  check(
    "the digest is a fraction of it",
    Buffer.byteLength(call.digest) < call.bodyBytes / 20,
    `digest ${Buffer.byteLength(call.digest)} B vs body ${call.bodyBytes} B`,
  );

  process.stdout.write("inspect\n");
  const inspected = JSON.parse(await cli("inspect", call.handle, "--path", "data[0].id", "--json"));
  check("drilling in returns the real value", inspected.text.includes("wgt_000001"));
  check("the slice passed a redactor", inspected.redacted === true);

  process.stdout.write("history and replay\n");
  const history = JSON.parse(await cli("history", "--json"));
  check("the run was logged", history.runs[0]?.handle === call.handle);
  check("it records which environment it used", history.runs[0]?.environment === "local");
  const replayed = JSON.parse(await cli("replay", call.handle, "--json"));
  check("replay re-runs it", replayed.status === 200 && replayed.handle !== call.handle);

  process.stdout.write("the production gate\n");
  const refused = await cli(
    "call",
    "DELETE",
    "/widgets/wgt_000001",
    "--env",
    "prod",
    "--json",
  ).then(
    () => undefined,
    (error) => error,
  );
  check(
    "a mutation against production is refused without --confirm",
    refused !== undefined && `${refused.stderr}`.includes("CONFIRMATION_REQUIRED"),
    `${refused?.stderr}`,
  );

  process.stdout.write("mcp\n");
  const tools = await mcpToolsList();
  check("the MCP server advertises exactly six tools", tools.length === 6, tools.join(" "));

  if (process.exitCode === 1) {
    process.stderr.write("\nexamples/quickstart: FAILED\n");
  } else {
    process.stdout.write("\nexamples/quickstart: every documented command works\n");
  }
} finally {
  server.kill();
}

/** One JSON-RPC frame in, one out — the same smoke test the setup guide gives. */
async function mcpToolsList() {
  const child = spawn(process.execPath, [CLI, "mcp", "--dir", here], {
    env: { ...process.env, WIDGET_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "inherit"],
  });

  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);

  let raw = "";
  for await (const chunk of child.stdout) raw += chunk;

  return JSON.parse(raw).result.tools.map((tool) => tool.name);
}
