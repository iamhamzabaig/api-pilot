import { parseArgs } from "node:util";
import { emit } from "../output.js";

/**
 * Starts the MCP server on stdio and stays there until the host closes stdin.
 *
 * No `--json`: stdout *is* the machine output here, and it carries JSON-RPC
 * frames only. Anything else written to it corrupts the stream.
 */

const HELP = `Usage:
  api-pilot mcp [options]

Runs the MCP server over stdio. Hosts (Claude Code, Claude Desktop, Cursor,
Zed) start this themselves — you rarely run it by hand.

Options:
      --dir <path>   workspace directory to search upward from (default: cwd)
  -h, --help         show this help

Six tools are exposed: api_search, api_describe, api_call, api_inspect,
api_history, api_env. The count does not change with the size or number of
loaded specs. See docs/guides/mcp-setup.md for host configuration.
`;

export async function mcp(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    emit(false, undefined, () => HELP);
    return;
  }

  const { runMcpServer } = await import("../../mcp/server.js");
  await runMcpServer(values.dir === undefined ? {} : { dir: values.dir });
}
