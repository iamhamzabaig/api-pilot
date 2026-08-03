# Checkpoint — 2026-08-03

Resume point for API Pilot. Read this first, then `docs/BLUEPRINT.md` §19–20 for the
roadmap and `docs/adr/` for the decisions that are already locked.

---

## 1. Where things stand

**Milestones M0–M6 complete. M7 remains.**

| | Milestone | State |
|---|---|---|
| M0 | Foundations — repo, tooling, CI, ADR-0001/0002, license, docs | done |
| M1 | Execution core — `request` + `exec` + `store` | done |
| M2 | Digest + Inspect — **the context-economy bet** | done, measured |
| M3 | Environments, secrets, redaction, policy gate, auth | done, canary suite green |
| M4 | Spec discovery — load, index, search, describe — **the search bet** | done, measured |
| M5 | CLI — seven commands, `--json`, cold-start gate | done, measured |
| M6 | MCP server (6 tools) | done, measured — one criterion open, see §6 |
| M7 | v0.1 release | **next** |

### Verification state at checkpoint

All gates green on Windows / Node 24.18:

```
pnpm run check          biome ci .  →  68 files, 0 errors, 0 warnings
pnpm run typecheck      tsc --noEmit → clean
pnpm run build          tsc -p tsconfig.build.json → dist/
pnpm run test:coverage  269 passed (21 files); 93.7% stmts, 88.0% branches
pnpm run bench          cold start p95 69–124 ms (budget 200 ms) — see the note below
pnpm run docs:check     docs/cli.md up to date
node dist/cli/index.js --version → 0.0.0
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/cli/index.js mcp → 6 tools
```

Build runs **before** test in CI now: the cold-start bench and the docs
staleness check both measure `dist/`, and would skip silently otherwise.

**The bench still measures the machine as much as the tool.** Four consecutive runs
during M6 read p95 69, 117, 124 and **681** ms — the 681 ms run was immediately
after a coverage run and would have failed the 200 ms gate. Nothing on the
`--version` path changed in M6 (`tests/unit/cli-structure.test.ts` proves the import
graph is unchanged), so a red bench on a loaded machine is noise: re-run it idle
before believing it. Isolating it under its own config fixed the systematic case in
M5, not the transient one. If CI flakes on this, that is the trigger for the
regression-gate rework already noted in §7.

### Both product bets are measured, not asserted

| Claim | Measured |
|---|---|
| A 1 MB JSON response fits a 2 KB digest | 1,051,814 B → **373 B** (0.035%) |
| A 1,000-operation spec stays interactive | index **24 ms**, search **0.44 ms** |
| A 1,000-operation spec adds zero MCP tools | 6 tools, byte-identical serialization |
| The whole tool surface fits a context budget (N3) | **~822 tokens**, budget 1,500 |
| The CLI starts fast enough to replace `curl` (N1) | p95 **69.1 ms**, budget 200 ms |

If either bet had failed, ADR-0002 was wrong and one-tool-per-operation was the
better design. Neither did. **Nothing structurally risky is left** — M7 is
release engineering.

---

## 2. Git state

Three commits on `main`, no remote configured. **M6 is uncommitted in the working
tree** at the time of writing:

```
84f0401 docs: update checkpoint and README for M5
440d3e5 feat(cli): M5 — seven commands over the engine
461b93d feat: project foundations and core engine (M0-M4)
```

M0–M4 went in as one commit rather than five: `src/index.ts` re-exports every
module, so per-milestone commits would not have typechecked, and history that
does not build is not history.

---

## 3. Environment

- Node **24.18.0** local; `engines` floor is **>=22**
- pnpm **11.18.0** via corepack (`corepack enable pnpm` if it is missing)
- pnpm 11 reads `allowBuilds` from `pnpm-workspace.yaml`, **not** `onlyBuiltDependencies`
  in `package.json` — esbuild's postinstall is allowed there
- Caveman statusline is configured in `C:\Users\M4 Tech\.claude\settings.json`

### Dependencies

**Production: 2 of a 12 cap** (NFR N10) — `yaml`, `zod`.
Dev: `@biomejs/biome`, `@types/node`, `typescript`, `vitest`.

Three dependencies were considered and deliberately not taken. Do not add them
without reading the reasoning first:

- `@apidevtools/json-schema-ref-parser` — ADR-0003, decision 1
- a search library (`minisearch`/`lunr`) — ADR-0003, decision 2
- a JSONPath library — `src/core/inspect/json-path.ts` header comment: filter
  expressions are an eval surface we refuse to open to a model querying
  attacker-influenceable bodies
- `undici` — not needed until custom CA / proxy / mTLS lands; global `fetch`
  covers everything through M4

---

## 4. Decisions already locked — do not relitigate

| ADR | Decision |
|---|---|
| 0001 | TypeScript on Node 22+, ESM only. Contains an **explicit revisit trigger** for a Go port so nobody rewrites on vibes. |
| 0002 | **Fixed six-tool MCP surface.** `api_search`, `api_describe`, `api_call`, `api_inspect`, `api_history`, `api_env`. A seventh tool requires a new ADR naming what it displaces. |
| 0003 | Lazy `$ref` resolution instead of a dereferencing library; in-house search ranker. Amends BLUEPRINT §12.3. |
| 0004 | **Hand-rolled JSON-RPC over stdio**, not `@modelcontextprotocol/sdk`. Amends BLUEPRINT §12.6. stdio only; a remote transport revisits this. |

Two open questions from BLUEPRINT §21 were **resolved by the user on 2026-07-31**:

- **Q3 — production mutation confirmation:** host approval UI **plus** a required
  `confirm: true` argument. Implemented in `src/core/policy/policy.ts`.
- **Q4 — history location:** gitignored `.apipilot/.cache/`. Not committed.

Questions 1, 2, 5, 6, 7 in §21 are still open but none of them block M6–M7.

---

## 5. Invariants that must not regress

These have silent failure modes. Each has a test that is the real specification.

1. **Nothing leaves the process without passing the redactor.**
   `tests/integration/canary.test.ts` injects six unique canaries through every
   config path that can carry a credential, sends real requests, and asserts each
   canary reached the wire *and* appears in none of: the request summary, digest
   text, inspect output, the metadata file on disk, or a thrown error's message
   and stack. Base64 forms checked separately.

2. **No output exceeds its byte budget.** `capBytes` is the structural backstop.
   Digest ≤ 2 KB default, describe ≤ 1 KB, inspect ≤ 8 KB. A seeded generator in
   `tests/unit/digest.test.ts` runs 400 documents × 4 budgets against it.

3. **No unbounded body read anywhere.** `src/core/inspect/inspect.ts` has no
   "give me everything" mode by design.

4. **The MCP tool surface stays at six, inside 1,500 tokens.**
   `tests/golden/mcp-tools.test.ts` snapshots the serialized definitions, asserts
   the six names of ADR-0002, and asserts the serialization is byte-identical
   after a 1,000-operation spec is indexed. A diff there is a change to what
   every model sees in every session.

9. **stdout under `api-pilot mcp` carries JSON-RPC frames and nothing else.**
   One stray `console.log` anywhere below `runMcpServer` corrupts the stream and
   the host disconnects. Diagnostics go to stderr.

10. **A response body cannot escape its fence.** `fence()` escapes both tags
    before wrapping, so a body containing `</untrusted-api-response>` cannot
    continue outside the marked region. Tested in
    `tests/integration/mcp.test.ts`.

5. **Search ranking is tuned, not proven.** The constants in
   `src/core/spec/search.ts` (`SATURATION`, `DRIFT_PENALTY`, intent bonuses) are
   exactly the kind of thing that silently degrades.
   `tests/unit/spec-search.test.ts` asserts specific natural-language queries land
   on specific operations. **Treat a change there as a product change, not a
   flaky test.**

6. **Golden snapshots are the spec of what a model sees.** `tests/golden/`.
   Never accept a diff with `-u` without reading it.

7. **`--version` must import almost nothing.** `tests/unit/cli-structure.test.ts`
   asserts `src/cli/index.ts` statically imports exactly `./output.js` and reaches
   its commands through `await import(...)`. A static core import there would load
   the HTTP stack, the spec index and the store on every invocation — and the p95
   measurement would only notice after the budget was already gone.

8. **Only http and https reach the network.** `assertProtocolAllowed`, applied to
   the request and to every redirect hop.

---

## 6. M6 as built, and what M7 inherits

**Acceptance criteria from BLUEPRINT §20:**

| Criterion | State |
|---|---|
| Adapter < 500 LOC | 488 code lines across `src/mcp/` + `src/cli/commands/mcp.ts` |
| Serialized tool definitions ≤ 1,500 tokens, golden-file gated | ~822, `tests/golden/mcp-tools.test.ts` |
| Protocol conformance suite green | 26 cases, `tests/integration/mcp.test.ts` |
| Response bodies fenced as untrusted | `fence()`, both tags escaped |
| A 500-operation spec adds zero tools | asserted at 1,000 operations |
| Setup guides for 4 hosts | `docs/guides/mcp-setup.md` |
| **Verified working in Claude Code and one other host** | **not done — needs a human at a host** |

That last one cannot be closed from a test run. It is the first thing to do in M7,
and it is the criterion most likely to find something: the fixture that only a real
host produces is an odd `initialize` payload or a working directory you did not
expect.

**Decisions M6 made:**

- **The transport is ours** (ADR-0004). `src/mcp/protocol.ts` is JSON-RPC framing
  over a `Readable`/`Writable` pair, which is also why the conformance suite drives
  real streams rather than calling handlers.
- **`src/core/views.ts` is new.** The `--json` payloads and the MCP tool results
  were the same objects written twice, which is exactly the condition BLUEPRINT §11
  says means the core API is wrong — the adapter came in at 543 LOC, over its 500
  budget, and every line over was a copy. Both adapters now project through the
  same functions. Add a field there, not in one adapter.
- **Errors that are the model's problem come back as results**, with `isError` and
  a `{code, message, hint}` payload. Errors that are the *host's* problem — unknown
  method, unknown tool, malformed frame — are JSON-RPC errors. A model that asks
  for a blocked host should read why and try another; it should not see a transport
  failure.
- **`api_history` takes `action: "list" | "replay"`.** Inferring replay from the
  presence of a handle would make a filter argument fire a request.
- **The workspace is re-read on every tool call.** No cached `SpecIndex`: indexing
  1,000 operations costs 24 ms, and a stale index across a long session is worse
  than paying that.

### What M5 decided that M6 kept

- **There is no `src/core/history/`,** despite BLUEPRINT §11 listing one. A run
  *is* a metadata record, so the run log is `ResponseStore.list()`. Handles are
  time-prefixed base36, so a limited query reads only the records it returns
  rather than scanning the store.
- **`core/run/run.ts` is the single end-to-end request path.** `api_call` and
  `api_history action=replay` both land there, so the policy gate, the redactor and
  the store see the same sequence whichever adapter called.
- **Replay stores the pre-interpolation intent**, not the resolved request, so
  replaying into another environment resolves that environment's variables and
  credentials. The intent lives inside the metadata record, which puts it inside
  the redaction boundary for free. A binary body is dropped, flagged
  `bodyOmitted`, and replay refuses with a clear error.
- **Spec paths live in `.apipilot/environments.yaml` under `specs:`**, not in the
  separate `config.yaml` BLUEPRINT §17 describes. One array did not justify a
  second file, a second schema and a second loader. Revisit if that file grows
  anything else.
- **The policy gate now checks protocol** — http/https only, on the request and
  on every redirect hop. It previously checked only the host, so `file:`,
  `data:`, and a Windows `C:\...` path (scheme `c:`, empty hostname) reached the
  host check and were reported as the baffling `Host  is not allowed`.

---

## 7. Known gaps, carried forward deliberately

Each was a conscious call, not an oversight. Listed so none of them quietly
becomes "done".

| Gap | Where it belongs |
|---|---|
| **No real-world spec validation.** M4's criterion "loads 5 real-world public specs" is **not met** — CI cannot touch the network and Stripe's spec is 6 MB. Five synthetic fixtures encode real failure modes instead; the ≥500-op case is generated. Closable with no code change: drop a downloaded spec into `tests/fixtures/specs/` (it is globbed; `local-*.yaml` is gitignored). See that directory's README. **Worth doing manually before v0.1 — expect it to find parser gaps.** | before M7 |
| **Loading a spec by URL.** BLUEPRINT §6.1 tags it MVP; it was pencilled in for M6 and **was not built**. It is not part of the MCP adapter — it belongs in `spec/document.ts`, and it turns loading into an egress event that has to go through the policy gate and needs a cache under `.apipilot/.cache/specs/`. Doing it inside M6 would have meant a network path landing in the same commit as a new protocol surface. | M7 |
| **Cold start is gated on an absolute 200 ms p95, not on a >15% regression.** A regression gate needs a committed baseline per OS, and a baseline that drifts upward one accepted commit at a time is worse than no baseline. The bench prints p50/p95 on every run so a creep from 60 ms to 190 ms is visible while still passing. | M7, if the absolute gate proves too loose |
| **`--body` takes text only.** No `@file` shorthand, no streaming upload, no multipart. `--body-file` covers the common case; a binary body is not replayable (see §6). | when a real use case lands |
| **`api_inspect` output does not pass a redactor**, matching the CLI's `inspect`. Both read a stored run, and a stored run does not record which environment produced it, so there is no redactor to seed. A credential a service echoes into its own response body is scrubbed from the *digest* (which is built while the environment is still resolved) but not from a later inspect. Closing it means recording the environment name in the metadata record. | M7 — it is the one hole left in invariant 1 |
| **MCP is stdio only.** No HTTP/SSE transport; that is the case where ADR-0004 says to take the SDK instead. | v1, demand-gated |
| CodeQL, Dependabot/Renovate, Changesets, issue/PR templates | M7 |
| `.apipilot/` example workspace under `examples/`, executed in CI | M7 |

Closed in M5: the run log, the coverage gate (85% on `src/core`), the
cold-start benchmark, and docs generated from source with a staleness check.

Closed in M6: the MCP server, the tool-surface token gate, and the egress-blocked
CI job — the suite re-runs inside a network namespace with only loopback up, so
"no test reaches the internet" (NFR N7) is checked rather than asserted.

---

## 8. Map of the code

```
src/
├─ index.ts                     public API surface — changes here need a changeset
├─ version.ts                   resolves package.json version (dist/ and src/ same depth)
├─ cli/
│  ├─ index.ts                 dispatch ONLY; every command behind a dynamic import
│  ├─ output.ts                printing; imports no core, it is on the --version path
│  ├─ args.ts                  shared argument coercion
│  └─ commands/                grouped by dependency footprint, not one file per verb:
│     ├─ spec.ts               search + describe   (loads the spec index, not the executor)
│     ├─ run.ts                call + replay       (loads core/run)
│     ├─ store.ts              history + inspect   (loads the store)
│     ├─ env.ts                env                 (loads the workspace only)
│     └─ mcp.ts                mcp                 (loads the MCP server)
├─ mcp/
│  ├─ protocol.ts              JSON-RPC 2.0 framing over stdio (ADR-0004)
│  ├─ server.ts                initialize / ping / tools/list / tools/call — wiring only
│  └─ tools.ts                 the six tools: zod in, core out, fence on the way back
└─ core/
   ├─ errors.ts                 ApiPilotError, one class + stable `code` discriminant
   ├─ views.ts                  the JSON projections BOTH adapters use — types-only imports
   ├─ body.ts                   decodeBody / formatBytes / capBytes (the byte-budget backstop)
   ├─ request/
   │  ├─ types.ts               HttpRequest, RequestBody, RetryPolicy, IDEMPOTENT_METHODS
   │  └─ prepare.ts             interpolate → auth → policy, in that order
   ├─ exec/execute.ts           the ONLY module doing network I/O; manual redirects
   ├─ store/response-store.ts   content-addressed bodies, per-run metadata
   ├─ digest/{shape,digest}.ts  structural inference + budgeted rendering
   ├─ inspect/{json-path,inspect}.ts   JSONPath subset (no filters) + capped drill-down
   ├─ redact/redactor.ts        THE choke point — raw, base64, percent-encoded forms
   ├─ secrets/resolvers.ts      env + file; the one interface with 3 known impls
   ├─ vars/interpolate.ts       {{var}}; depth-first, never rescans substituted text
   ├─ auth/apply.ts             bearer / basic / apikey, all registered with the redactor
   ├─ policy/policy.ts          host allowlist + production mutation gate + redirect guard
   ├─ run/run.ts                runRequest + replayRun — THE end-to-end request path
   ├─ workspace/{schema,workspace}.ts   .apipilot/ discovery, YAML + Zod, local overrides
   └─ spec/
      ├─ document.ts            load + LAZY $ref, directory-escape guard
      ├─ operations.ts          flatten to operations; never throws, only warns
      ├─ schema-shape.ts        JSON Schema → the same Shape the digest renders
      ├─ search.ts              tokeniser + method intent + IDF + drift penalty
      ├─ describe.ts            budgeted operation rendering
      └─ spec-index.ts          the facade adapters will talk to
```

### Non-obvious things worth knowing

- **`prepareRequest` returns two things.** `request` holds live credentials —
  never digest, store, or log it. `summary` is the redacted twin and the only one
  that may be persisted or shown.
- **Response *bodies* are stored verbatim** in `.apipilot/.cache/objects/`. That is
  the vault and inspect needs the real bytes. Request *metadata* is redacted,
  because that is a file we wrote.
- **Two template syntaxes, on purpose.** `${env:TOKEN}` is a secret reference
  (resolved once, never rendered); `{{token}}` is a variable use. Keeping them
  distinct is what lets the redactor know which values are dangerous to print.
- **`shape.ts` is shared** between the response digest (M2) and OpenAPI schemas
  (M4). Array lengths are optional because schema-derived shapes have none.
- **`describe` degrades the response schema before the request body** — the body
  is what you need to construct the call; the response you will see anyway.
- **CLI commands are grouped by what they import,** not one file per verb. Lazy
  loading is the mechanism that keeps N1, and it only pays off if the module a
  command pulls in is the module it actually needs.
- **`--spec` replaces the workspace's spec list rather than adding to it.** The
  flag exists to look at a spec the workspace does not know about; silently
  searching four others at the same time would be a surprise.
- **`env` with no argument does not resolve secrets.** Listing must keep working
  when `PROD_TOKEN` is missing from the shell, or one unset variable hides every
  environment from you. Only `env <name>` resolves. `api_env` does the same.
- **One zod schema per MCP tool does two jobs.** It is parsed against the incoming
  arguments *and* serialized to the advertised JSON Schema via `z.toJSONSchema`.
  The alternative — a hand-written schema next to a hand-written validation — is a
  contract that drifts from its enforcement without anything failing.
- **`api_call` returns two content blocks:** the JSON envelope first, the fenced
  digest second. `payload()` in the MCP test suite depends on that order.
- **The MCP server answers `tools/list` before `initialize`.** There is no session
  state to be wrong about, which is what makes the one-line pipe in
  `docs/guides/mcp-setup.md` §6 a usable smoke test.

---

## 9. Bugs the tests caught (so they are not reintroduced)

- `capBytes` emitted its 21-byte truncation marker even when the whole budget was
  16 bytes, breaking the hard cap for any `maxBytes` < 21. Found by the seeded
  generator, not by a hand-written case.
- `expandVariables` returned early when a sweep made no changes, so a cycle
  silently left placeholders unresolved.
- Substituted variable values were rescanned on the next sweep — an injection
  vector where a *secret's contents* could reference other variables. Rewritten as
  depth-first resolution with a visiting set.
- `ResponseStore.put` copied `response.url` off the wire, leaving an
  API-key-in-query in `.cache/meta/*.json`.
- `SpecIndex.warnings` was snapshotted at construction, so a broken `$ref` inside
  a schema — only found when rendered — never surfaced.
- Search: saturation constant made field weights decorative; topic drift let
  `/subscriptions/{id}/items` beat `/subscriptions`; "all" scored as content
  instead of cardinality intent; `stem("modify")` never matched the intent map key
  `"modifi"`.
- The policy gate never checked protocol, so a `file:` or `data:` URL — or a
  Windows `C:\...` path, which parses as scheme `c:` with an empty hostname —
  fell through to the host check and surfaced as `Host  is not allowed`.
- `inspect` read the store before validating its flags, so a mistyped `--range`
  reported whatever the disk said about the handle instead of the typo.
- The cold-start benchmark measured the machine, not the tool: run alongside the
  main suite's workers it read ~295 ms against a 200 ms budget, and ~62 ms alone.
  It now runs under its own config. Its first version also took 15 samples, where
  the nearest-rank p95 index lands on the *maximum* — asserting "no spawn ever
  exceeded 200 ms" rather than NFR N1's actual claim.

---

## 10. Commands

```sh
pnpm install
pnpm test                    # vitest run
pnpm run test:coverage       # with the 85% gate on src/core
pnpm test:watch
pnpm run check               # biome ci  — no warnings-only mode
pnpm run format              # biome check --write
pnpm run typecheck
pnpm run build
pnpm run bench               # cold start, own config — needs a build first
pnpm run docs                # regenerate docs/cli.md; docs:check to verify

pnpm exec vitest run -u                  # update goldens — READ THE DIFF
pnpm exec vitest run spec-search         # the search-bet suite
pnpm exec vitest run canary              # the secret-leakage suite
pnpm exec vitest run cli                 # the CLI integration suite
pnpm exec vitest run mcp                 # protocol conformance + the token budget

# The MCP server is a normal process on two pipes. Needs a build first.
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/cli/index.js mcp --dir .

# What CI does for NFR N7, on Linux: the suite, with no route off loopback.
sudo -E env "PATH=$PATH" unshare --net --fork sh -c 'ip link set lo up && exec pnpm test'
```

`bench` and `docs:check` both read `dist/`. Build first or they measure
nothing — `bench` skips silently when `dist/` is absent, which is why CI
builds before it tests.
