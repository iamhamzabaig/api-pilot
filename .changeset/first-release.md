---
"api-pilot": minor
---

First release: v0.1.0.

**Six MCP tools, fixed.** `api_search`, `api_describe`, `api_call`, `api_inspect`,
`api_history`, `api_env`. A 1,000-operation spec adds zero tools and moves the
serialized surface by zero bytes; the whole thing costs ~820 tokens against a
1,500 budget, golden-file gated (ADR-0002).

**Eight CLI commands** over the same core — `search`, `describe`, `call`,
`inspect`, `history`, `replay`, `env`, `mcp` — each with `--json`, and a cold
start held under a 200 ms p95 by a CI-gated benchmark.

**Responses are digested, not pasted.** A 1 MB JSON array becomes a ~380 byte
digest plus a handle; `inspect` queries the stored bytes under a budget. There is
no full-body dump mode, by design.

**Credentials never leave the process.** Configuration holds secret *references*,
values resolve at the HTTP boundary, and every path out passes a redactor seeded
for that run. A canary suite injects unique tokens through every configuration
path and asserts they reached the wire and appear in no output stream, including
a later `inspect` of a stored response.

**Guardrails that are on by default.** Per-environment host allowlist, http/https
only on the request and every redirect hop, and a mutating call against a
`production` environment refused until it is explicitly confirmed. Response
bodies reach a model fenced as untrusted data.

Two production dependencies: `yaml` and `zod`.
