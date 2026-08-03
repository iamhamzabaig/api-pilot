# API Pilot

**AI-native API execution engine.** Lets Claude Code, Cursor, Codex, and any MCP-compatible assistant discover, execute, and debug HTTP APIs from your terminal — without flooding the context window and without ever showing the model your credentials.

> **Status: pre-alpha (v0.0.0), not yet published to npm.** Milestones M0–M6 are complete —
> execution, response digesting, environments and redaction, spec search, eight CLI commands,
> and the MCP server. M7 (release) remains, so you run it from a clone rather than `npx`.
> See the [roadmap](docs/BLUEPRINT.md#19-roadmap).

## Why not just `curl`?

`curl` is already installed and already works. API Pilot only earns its place by beating it on four things an agent loop actually struggles with:

| | `curl` in an agent loop | API Pilot |
|---|---|---|
| **Context cost** | a 200 KB JSON response is ~50k tokens pasted into the session | a budgeted digest (shape, sizes, sample) plus a handle you can query |
| **Credentials** | the token ends up in the transcript and shell history | resolved at the HTTP boundary; the model never sees the value |
| **Discovery** | the agent guesses paths or reads the whole spec | search across indexed OpenAPI operations |
| **Reproducibility** | nothing persists | every run logged, replayable, and diffable |

## Why not a spec-to-MCP generator?

Generating one MCP tool per OpenAPI operation is the common approach. On a 500-operation API it produces 500 tool definitions and burns 80 KB of context before the model does anything.

API Pilot exposes **six tools, always** — `api_search`, `api_describe`, `api_call`, `api_inspect`, `api_history`, `api_env` — and treats the spec as searchable data instead. Loading a 1,000-operation spec adds zero tools; the whole surface serializes to ~820 tokens, and a golden test fails if that moves. See [ADR-0002](docs/adr/0002-fixed-mcp-tool-surface.md).

## The MCP server

```json
{
  "mcpServers": {
    "api-pilot": { "command": "npx", "args": ["-y", "api-pilot", "mcp"] }
  }
}
```

Setup for Claude Code, Claude Desktop, Cursor and Zed: **[docs/guides/mcp-setup.md](docs/guides/mcp-setup.md)**.

The model searches, describes, then calls. `api_call` returns a digest and a handle,
never a body; response text arrives fenced as `<untrusted-api-response>`; a mutating
call against a `production` environment is refused until the model passes
`confirm: true`, which the host shows you before it runs.

The transport is ~130 lines of JSON-RPC over stdio rather than the MCP SDK — see
[ADR-0004](docs/adr/0004-hand-rolled-mcp-stdio-transport.md) for what that buys and
what it costs. Production dependencies: **two**.

## The CLI

Eight commands over the engine, each with `--json` except `mcp`. Full reference: **[docs/cli.md](docs/cli.md)** (generated from the CLI itself).

```sh
api-pilot search cancel a subscription   # find an operation across your specs
api-pilot describe cancelSubscription    # its parameters, body, and responses
api-pilot call GET /v1/invoices          # execute; prints a digest, not the body
api-pilot inspect r_m8x2k9qp --path data[0].id
api-pilot history                        # every run, newest first
api-pilot replay r_m8x2k9qp --env staging
api-pilot env local                      # resolved config; secrets stay [redacted]
api-pilot mcp                            # the MCP server, on stdio
```

A response is stored whole and summarised into a budgeted digest, so a 1 MB
payload costs a few hundred bytes of context and the bytes stay queryable
through `inspect`. `replay` re-runs the recorded *intent* — the un-substituted
URL, headers and body — which is why replaying into another environment
resolves that environment's variables and credentials.

Configuration is one file, `.apipilot/environments.yaml`:

```yaml
version: 1
default: local
specs:
  - openapi/billing.yaml
environments:
  local:
    baseUrl: http://localhost:3000
    variables:
      apiToken: ${env:DEV_TOKEN}    # a reference; the value is never rendered
    auth:
      type: bearer
      token: "{{apiToken}}"
  prod:
    classification: production      # mutations here require --confirm
    baseUrl: https://api.example.com
```

## Design

- **[Architecture blueprint](docs/BLUEPRINT.md)** — vision, competitive analysis, requirements, module breakdown, roadmap, milestones
- **[ADR-0001](docs/adr/0001-language-and-stack.md)** — TypeScript on Node 22+, and the explicit trigger for revisiting it
- **[ADR-0002](docs/adr/0002-fixed-mcp-tool-surface.md)** — the fixed six-tool surface, and the risk it takes on
- **[ADR-0003](docs/adr/0003-lazy-ref-resolution-and-in-house-search.md)** — lazy `$ref` resolution and an in-house search ranker
- **[ADR-0004](docs/adr/0004-hand-rolled-mcp-stdio-transport.md)** — a hand-rolled stdio transport instead of the MCP SDK

Everything lives in plain files in your repo: OpenAPI specs, `.http` requests, and a YAML environment file that holds secret *references*, never secret values. No account, no cloud, no telemetry.

## Development

Requires Node ≥ 22 and pnpm (`corepack enable pnpm`).

```sh
pnpm install
pnpm test             # vitest
pnpm run test:coverage # with the 85% gate on src/core
pnpm run check        # biome lint + format
pnpm typecheck        # tsc --noEmit
pnpm run build        # tsc -> dist/
pnpm run bench        # cold-start budget, < 200 ms p95 (NFR N1)
pnpm run docs         # regenerate docs/cli.md from the CLI's own --help
```

`pnpm run bench` runs under its own config because it is timing-sensitive:
sharing cores with the main suite's workers roughly triples the measurement.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The short version: the scope boundaries in [§8 of the blueprint](docs/BLUEPRINT.md#8-out-of-scope) are a contract, and new dependencies need justification.

Security issues: see [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.

## License

[Apache-2.0](LICENSE)
