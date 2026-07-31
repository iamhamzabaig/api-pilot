#!/usr/bin/env node
import { EXIT_ERROR, EXIT_USAGE, write, writeError } from "./output.js";

/**
 * Dispatch only. Every command is behind a dynamic import so that the work of
 * loading a module is paid for by the command that needs it: `--version` must
 * not load the HTTP stack, and `search` must not load the executor (NFR N1,
 * cold start < 200 ms).
 *
 * `node:util.parseArgs` does the parsing. A CLI framework is the single most
 * expensive thing that could be added here — see ADR-0001's consequences.
 */

const HELP = `api-pilot — AI-native API execution engine

Usage:
  api-pilot <command> [options]

Commands:
  search <query>        find operations across the indexed specs
  describe <id>         show one operation: parameters, body, responses
  call <method> <url>   execute a request and print a digest of the response
  replay <handle>       re-run a recorded call, optionally in another environment
  inspect <handle>      query a stored response: path, byte range, or headers
  history               list recorded runs, newest first
  env                   list environments, or show one resolved

Options:
  -h, --help            show this help, or a command's help
  -v, --version         print the version

Every command accepts --json for machine-readable output.
Run \`api-pilot <command> --help\` for a command's own options.
`;

async function dispatch(command: string, argv: readonly string[]): Promise<void> {
  switch (command) {
    case "search":
      return (await import("./commands/spec.js")).search(argv);
    case "describe":
      return (await import("./commands/spec.js")).describe(argv);
    case "call":
      return (await import("./commands/run.js")).call(argv);
    case "replay":
      return (await import("./commands/run.js")).replay(argv);
    case "history":
      return (await import("./commands/store.js")).history(argv);
    case "inspect":
      return (await import("./commands/store.js")).inspect(argv);
    case "env":
      return (await import("./commands/env.js")).env(argv);
    default:
      writeError(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = EXIT_USAGE;
      return;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  // Handled before anything else is imported: this path must stay cheap.
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    write(HELP);
    return;
  }
  if (first === "--version" || first === "-v") {
    write((await import("../version.js")).version);
    return;
  }

  await dispatch(first, argv.slice(1));
}

main().catch((error: unknown) => {
  renderFailure(error, process.argv.includes("--json"));
  process.exitCode = EXIT_ERROR;
});

/**
 * Duck-typed rather than an `instanceof ApiPilotError` check, because importing
 * the error class statically would load it on the `--version` path too. The
 * `code`/`hint` shape is stable by contract — see `core/errors.ts`.
 */
function renderFailure(error: unknown, asJson: boolean): void {
  if (error !== null && typeof error === "object" && "message" in error) {
    const { code, message, hint } = error as {
      code?: unknown;
      message?: unknown;
      hint?: unknown;
    };
    if (asJson) {
      writeError(JSON.stringify({ error: { code, message: String(message), hint } }, null, 2));
      return;
    }
    const label = typeof code === "string" ? `${code}: ` : "";
    writeError(`error: ${label}${String(message)}`);
    if (typeof hint === "string" && hint !== "") writeError(`hint: ${hint}`);
    return;
  }
  writeError(
    asJson
      ? JSON.stringify({ error: { message: String(error) } }, null, 2)
      : `error: ${String(error)}`,
  );
}
