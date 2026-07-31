# API Pilot

**AI-native API execution engine.** Lets Claude Code, Cursor, Codex, and any MCP-compatible assistant discover, execute, and debug HTTP APIs from your terminal — without flooding the context window and without ever showing the model your credentials.

> **Status: pre-alpha (v0.0.0).** The architecture is settled; the engine is not built yet.
> Milestone M0 (project foundations) is complete. See the [roadmap](docs/BLUEPRINT.md#19-roadmap).
> Nothing below the "Design" heading is working software yet — it is the specification we are building against.

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

API Pilot exposes **six tools, always** — `api_search`, `api_describe`, `api_call`, `api_inspect`, `api_history`, `api_env` — and treats the spec as searchable data instead. Loading a 500-operation spec adds zero tools. See [ADR-0002](docs/adr/0002-fixed-mcp-tool-surface.md).

## Design

- **[Architecture blueprint](docs/BLUEPRINT.md)** — vision, competitive analysis, requirements, module breakdown, roadmap, milestones
- **[ADR-0001](docs/adr/0001-language-and-stack.md)** — TypeScript on Node 22+, and the explicit trigger for revisiting it
- **[ADR-0002](docs/adr/0002-fixed-mcp-tool-surface.md)** — the fixed six-tool surface, and the risk it takes on

Everything lives in plain files in your repo: OpenAPI specs, `.http` requests, and a YAML environment file that holds secret *references*, never secret values. No account, no cloud, no telemetry.

## Development

Requires Node ≥ 22 and pnpm (`corepack enable pnpm`).

```sh
pnpm install
pnpm test        # vitest
pnpm run check   # biome lint + format
pnpm typecheck   # tsc --noEmit
pnpm run build   # tsc -> dist/
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The short version: the scope boundaries in [§8 of the blueprint](docs/BLUEPRINT.md#8-out-of-scope) are a contract, and new dependencies need justification.

Security issues: see [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.

## License

[Apache-2.0](LICENSE)
