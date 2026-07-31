# ADR-0002: A fixed six-tool MCP surface; specs are searchable data, not tools

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Lead Architect
- **Relates to:** ADR-0001

## Context

The obvious way to expose an API to an AI assistant over MCP is to generate one tool per OpenAPI operation. Several existing projects do exactly this, and for a 10-endpoint toy spec it works well and requires zero configuration.

It does not survive real specs. Every tool definition — name, description, and full JSON Schema for parameters and body — is loaded into the model's context before the model does anything at all.

| Spec | Operations | Tools generated | Rough context cost |
|---|---|---|---|
| Toy service | 10 | 10 | ~2 KB |
| Typical internal service | 80 | 80 | ~16 KB |
| Stripe / GitHub-class public API | 400–600 | 400–600 | 80 KB+ |

At the top of that table, the tool definitions alone can exceed the entire usable context budget of the session. Tool-selection accuracy also degrades badly as the tool count grows: the model is choosing from hundreds of near-identical options.

This is not a tuning problem. It is structural: the approach makes context cost proportional to API size, which is exactly backwards for our primary user.

## Options considered

### A. One MCP tool per operation (the incumbent approach)
Zero configuration, immediately legible. Context cost scales linearly with spec size and collapses on real APIs. Also gives us no place to put environments, secret resolution, digesting, or history — each generated tool is an island.

### B. One tool per operation, filtered by a user-supplied allowlist
Fixes the context cost only if the user does the curation work up front, which defeats discovery — you cannot search for an endpoint you already had to know about to allowlist.

### C. A fixed, small tool surface; the spec becomes searchable data
The model gets a constant handful of tools and *searches* the spec through them. Context cost is O(1) in spec size. Discovery becomes a first-class operation instead of a side effect of tool registration.

## Decision

**Option C.** API Pilot exposes exactly six MCP tools, regardless of how many specs are loaded or how large they are:

| Tool | Purpose |
|---|---|
| `api_search` | find operations across loaded specs by keyword |
| `api_describe` | full detail for one operation: params, schemas, examples, auth |
| `api_call` | execute a request; returns a digest and a handle, never a raw body |
| `api_inspect` | query a stored response by handle (JSONPath, headers, slice) |
| `api_history` | list and replay previous runs |
| `api_env` | list environments and variable *names* — never secret values |

**Adding a seventh tool requires a new ADR** that names what it displaces. This constraint is the point, not an inconvenience.

Budget: all six serialized tool definitions must fit in ≤ 1,500 tokens (NFR N3), gated by a golden-file test in CI.

## Consequences

**Accepted:**
- Search quality becomes load-bearing. If `api_search` cannot reliably surface the right operation from a natural-language query, the whole design fails and Option A would have been better. This is the project's single largest technical risk and is why milestone M4 exists as a discrete, separately-verified stage.
- One extra round trip. The model typically does `api_search` → `api_describe` → `api_call` where Option A would do a single call. We are trading three small calls for not paying 80 KB up front. On any spec above roughly 30 operations this is a large net win; below that, Option A is cheaper. We accept being slightly worse on toy specs to be dramatically better on real ones.
- `api_describe` output must itself be budgeted (target < 1 KB for a complex operation). A tool that dumps a raw dereferenced schema reintroduces the problem it was built to solve.
- Because all execution funnels through one `api_call`, we get natural single points for environments, secret resolution, the policy gate, redaction, and history. Option A had nowhere to put any of these. This is a real secondary benefit, not a rationalization.

**Rejected explicitly:**
Dynamic tool registration (registering operation-specific tools on demand mid-session). It reintroduces unbounded context growth through the back door and depends on MCP client behavior we do not control.

**Measurable claim this creates:**
Loading a 500-operation spec must add **zero** tools and **zero** tokens to the tool surface. This is a milestone M6 acceptance criterion and belongs in the README as the headline differentiator.
