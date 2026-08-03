# MCP setup

API Pilot exposes six tools over MCP — `api_search`, `api_describe`, `api_call`,
`api_inspect`, `api_history`, `api_env` — and that count does not change with the
size or number of OpenAPI specs you load (ADR-0002).

The server speaks stdio. Hosts start it themselves; you rarely run `api-pilot mcp`
by hand.

---

## 1. Prerequisites

**Node ≥ 22**, and a workspace for the server to read:

```
your-project/
└─ .apipilot/
   ├─ environments.yaml         # committed: specs, base URLs, allowlists, secret references
   └─ environments.local.yaml   # gitignored: local overrides
```

A minimal `environments.yaml`:

```yaml
version: 1
default: dev
specs:
  - ./openapi.yaml
environments:
  dev:
    classification: safe
    baseUrl: http://localhost:8080
    variables:
      apiToken: ${env:MY_API_TOKEN}
    auth:
      type: bearer
      token: "{{apiToken}}"
```

Secrets are **references**, never literals — `${env:...}` and `${file:...}` are
resolved at call time and registered with the redactor, so their values cannot come
back through a digest, an inspect result, or an error message.

Verify the workspace before wiring up a host:

```sh
npx api-pilot env          # lists environments
npx api-pilot search "list invoices"
```

---

## 2. Where the server looks for `.apipilot/`

By default it walks up from its **working directory**, the way `git` finds `.git`.
Hosts differ in what working directory they give a server, so pass `--dir` whenever
the answer is not obviously your project root:

```
api-pilot mcp --dir /absolute/path/to/your-project
```

---

## 3. Host configuration

Replace `/absolute/path/to/your-project` throughout. Until API Pilot is published to
npm, use the local form instead of `npx`:

```json
{ "command": "node", "args": ["/absolute/path/to/api-pilot/dist/cli/index.js", "mcp"] }
```

### Claude Code

Project-scoped, checked into the repo as `.mcp.json`:

```json
{
  "mcpServers": {
    "api-pilot": {
      "command": "npx",
      "args": ["-y", "api-pilot", "mcp"]
    }
  }
}
```

No `--dir` needed here: Claude Code starts servers in the project directory. Or add
it from the command line:

```sh
claude mcp add api-pilot -- npx -y api-pilot mcp
```

Check it with `/mcp` inside a session.

### Claude Desktop

`claude_desktop_config.json` — on macOS
`~/Library/Application Support/Claude/`, on Windows `%APPDATA%\Claude\`:

```json
{
  "mcpServers": {
    "api-pilot": {
      "command": "npx",
      "args": ["-y", "api-pilot", "mcp", "--dir", "/absolute/path/to/your-project"]
    }
  }
}
```

`--dir` is required: the desktop app has no project directory to inherit. Restart
the app after editing; the tools appear under the connectors icon.

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "api-pilot": {
      "command": "npx",
      "args": ["-y", "api-pilot", "mcp", "--dir", "/absolute/path/to/your-project"]
    }
  }
}
```

Then Settings → MCP, and confirm `api-pilot` is listed with six tools.

### Zed

`settings.json` (`cmd`/`ctrl` + `,`):

```json
{
  "context_servers": {
    "api-pilot": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "api-pilot", "mcp", "--dir", "/absolute/path/to/your-project"],
      "env": {}
    }
  }
}
```

---

## 4. What the model sees

The intended sequence is **search → describe → call → inspect**:

| Step | Tool | What comes back |
|---|---|---|
| find the endpoint | `api_search` | ranked operations, ~1 line each |
| read its contract | `api_describe` | params, body schema, responses, under 1 KB |
| run it | `api_call` | a digest (≤ 2 KB) and a **handle** — never the full body |
| dig in | `api_inspect` | one bounded answer about the stored response |

The full response is written to `.apipilot/.cache/` and stays there. That is the
context-economy bet: a 1 MB JSON response reaches the model as a 373-byte digest,
and anything more specific is asked for by path.

Response text is wrapped in `<untrusted-api-response>` … `</untrusted-api-response>`.
It is data from a remote service, not instructions, and a body that tries to close
the fence itself has its tags escaped.

---

## 5. Safety

- **Host allowlist.** A request to a host the environment does not list is refused
  with `POLICY_BLOCKED`. Only `http` and `https` ever reach the network.
- **Production mutations need `confirm: true`.** A `POST`/`PUT`/`PATCH`/`DELETE`
  against an environment classified `production` fails with `CONFIRMATION_REQUIRED`
  until the model passes the argument — which the host shows you in the approval
  dialog. The gate survives hosts that auto-approve tool calls.
- **Secrets never leave the process.** `api_env` returns variable *names*; a
  secret-backed value reads as `[redacted]`.

Classify anything that can charge a customer or delete data as `production`:

```yaml
  prod:
    classification: production
    baseUrl: https://api.example.com
    allowedHosts: ["api.example.com"]
```

---

## 6. Troubleshooting

**The host shows the server as failed, or "unexpected token" in its logs.**
stdout carries JSON-RPC frames and nothing else. If you have wrapped the command in
a shell script that echoes anything, that echo is the corruption. Diagnostics belong
on stderr.

**`No .apipilot/ directory found`.**
The working directory the host used is not inside your project. Pass `--dir` with an
absolute path.

**`No specs are configured for this workspace`.**
`api_search` and `api_describe` need a `specs:` list in `environments.yaml`. Paths
resolve relative to the workspace root. `api_call` works without any spec.

**`SECRET_UNRESOLVED`.**
The server inherits the environment of the process that started it, which for a
desktop app is not your shell. Set the variable in the host's own `env` block, or
use a `${file:...}` reference instead.

**Verify by hand.** The server is a normal process on two pipes:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx api-pilot mcp --dir .
```

That prints one line: six tools.
