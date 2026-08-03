# ADR-0001: TypeScript on Node 22+ as the implementation stack

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Lead Architect
- **Supersedes:** —

## Context

API Pilot is an I/O-bound CLI plus an MCP server. Two constraints shape the choice:

1. **Cold start matters.** The CLI is invoked once per request by a human and, indirectly, by an agent loop. NFR N1 sets a 200 ms p95 budget.
2. **Contributor supply matters more.** This is an open-source project whose audience is developers who already use AI coding assistants. The stack must be one they can contribute to on day one.

Secondary constraints: the MCP protocol SDK, OpenAPI/JSON-Schema tooling maturity, and cross-platform distribution including native Windows.

## Options considered

### A. TypeScript on Node 22+, ESM only
- `@modelcontextprotocol/sdk` is first-class and canonical in TypeScript.
- The OpenAPI / JSON-Schema tooling ecosystem is strongest in JavaScript (`$ref` dereferencing especially — a genuinely hard problem we do not want to solve ourselves).
- `npx @hamzu/api-pilot` is a zero-install trial for our exact audience.
- Node 22 is the floor because it gives stable `fetch`/`undici`, `node:test`, `parseArgs`, and Single Executable Applications as a future packaging path.
- **Cost:** ~120–180 ms cold start; no true single binary; dependency-bloat pressure.

### B. Go
- ~10 ms cold start, a genuine static binary, excellent cross-compilation.
- **Cost:** thinner OpenAPI and MCP libraries; a smaller contributor pool in this specific niche; JSON-Schema handling would be substantially more of our own code.

### C. Rust
- Best runtime characteristics of the three.
- **Cost:** slowest iteration, smallest contributor pool, and none of its advantages address our actual bottleneck, which is network latency, not CPU.

## Decision

**Option A — TypeScript on Node 22+, ESM only.**

Runtime performance is not the product's bottleneck; a network round trip dominates every command. Contributor supply and ecosystem maturity are the real constraints, and Option A wins both decisively. The cold-start gap is real but sits inside a budget we can defend with discipline (no heavy CLI framework, lazy module loading, a hard dependency cap).

## Consequences

**Accepted:**
- We must actively defend cold start. No heavy CLI framework (see the rejection of oclif/yargs in the blueprint), lazy-load anything not needed by `--version`, and gate N1 in CI with a benchmark that fails the build on a >15% regression.
- A hard cap of 12 direct production dependencies (NFR N10), enforced in CI. JavaScript's failure mode is dependency sprawl; the cap is the antidote.
- Distribution is npm-first. Homebrew/Scoop/winget wait for v1 and real demand.

**Revisit trigger (explicit, so nobody rewrites on vibes):**
Port the CLI shell to Go *only if* N1 is still missed after optimization, **or** Windows/Node install friction proves to be a measured adoption blocker. Any such port keeps the core behind a stable protocol boundary. Speculative rewrites are forbidden.

**Locked in by this decision:**
ESM only, no CJS dual-build. TypeScript `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Biome over ESLint+Prettier (one tool, one config). Vitest over Jest (ESM-native). pnpm as the package manager.
