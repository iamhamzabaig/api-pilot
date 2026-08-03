# ADR-0004: Hand-rolled JSON-RPC over stdio instead of the MCP SDK

- **Status:** Accepted
- **Date:** 2026-08-03
- **Deciders:** Lead Architect
- **Amends:** BLUEPRINT §12.6 (the "MCP → `@modelcontextprotocol/sdk`" row)
- **Relates to:** ADR-0002

## Context

BLUEPRINT §12.6 picked `@modelcontextprotocol/sdk` for the MCP layer on the grounds
that it is canonical and isolated to one adapter. Both remain true. What changed
between that decision and M6 is that we now know exactly how much of the SDK we
would use, and what it costs to have it.

API Pilot ships a **stdio** server. That is newline-delimited JSON-RPC 2.0 over two
pipes, and the surface we implement is five methods: `initialize`, `ping`,
`tools/list`, `tools/call`, and ignoring notifications.

The SDK at the time of writing declares these runtime dependencies:

```
ajv, ajv-formats, content-type, cors, cross-spawn, eventsource,
eventsource-parser, express, express-rate-limit, hono, @hono/node-server,
jose, json-schema-typed, pkce-challenge, raw-body, zod, zod-to-json-schema
```

Two HTTP server frameworks, a CORS middleware, a JOSE implementation and an OAuth
PKCE helper — all for the HTTP/SSE transports and their auth flows, none of which a
stdio server touches. NFR N10 caps production dependencies at 12; we are at 2.

This project has already declined four dependencies on narrower grounds:
`@apidevtools/json-schema-ref-parser` (ADR-0003), a search library (ADR-0003), a
JSONPath library (an eval surface), and `undici` (global `fetch` suffices). A tool
whose headline claim is that it keeps credentials away from a model is a poor place
to add seventeen transitive packages for functionality it does not use.

## Options considered

### A. `@modelcontextprotocol/sdk`
Upstream absorbs protocol churn (risk §9.5, rated Medium). Dependency 3 of 12
directly, ~17 transitively. Tool schemas go through the SDK's zod integration, which
means the exact bytes of the advertised tool surface — the thing NFR N3 budgets at
1,500 tokens — are decided by a library rather than by us.

### B. Hand-rolled stdio transport
~90 lines of framing plus ~60 of method dispatch. Zero new dependencies. Full
control over the serialized tool definitions, which the N3 golden test needs anyway.
We own conformance, and we own keeping up with the spec.

### C. SDK now, replace later if the weight hurts
The worst of both: the dependency lands in the lockfile and in every install, and the
replacement work still has to happen, only later and with less attention on it.

## Decision

**Option B.** `src/mcp/protocol.ts` implements JSON-RPC 2.0 framing over a
`Readable`/`Writable` pair; `src/mcp/server.ts` dispatches the five methods.

Scope limits, so this does not quietly grow into a framework:

- **stdio only.** An HTTP or SSE transport is where the SDK earns its weight —
  sessions, CORS, OAuth, resumability. If we ship a remote transport, this ADR is
  revisited rather than extended.
- **No batching.** Removed from MCP in the 2025-06-18 revision.
- **Capabilities are `{ tools: {} }`.** No resources, no prompts, no sampling. Each
  would be a new ADR, and ADR-0002 already governs the tool count.

**Revisit trigger:** if a spec revision adds something to the *tools* flow that costs
more than roughly a day to follow, or if we ship a non-stdio transport, take the SDK
and delete `protocol.ts`. Conformance is pinned by `tests/integration/mcp.test.ts`,
which drives the server over real streams, so the swap is checkable rather than
hopeful.

## Consequences

**Accepted:**
- We track the MCP spec ourselves. `SUPPORTED_PROTOCOL_VERSIONS` in `server.ts` is
  the list to update, and version negotiation already handles a host asking for
  something we do not know.
- A framing bug is ours. This is why the conformance suite asserts the unglamorous
  cases — a notification must never be answered, a parse error is answered with a
  null id, a non-2.0 frame is rejected — rather than only the happy path.
- Production dependencies stay at **2 of 12**. `zod` now has a third use (config
  parsing, CLI validation, and MCP tool JSON Schema via `z.toJSONSchema`), which is
  what BLUEPRINT §12.4 predicted would justify it.

**Rejected explicitly:**
Vendoring the SDK's stdio transport. Copied code carries the maintenance without the
upstream fixes, and it would be larger than what we wrote.

**Measurable claim this creates:**
The serialized tool surface is ~820 tokens against the 1,500 of NFR N3, and it is
produced by code in this repository, so the budget is defended by a golden test that
fails on any change to what a model sees.
