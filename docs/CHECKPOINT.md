# Checkpoint — 2026-08-03

Resume point for API Pilot. Read this first, then `docs/BLUEPRINT.md` §19–20 for the
roadmap and `docs/adr/` for the decisions that are already locked.

---

## 1. Where things stand

**Milestones M0–M6 complete. M7 is code-complete; what remains needs a human.**

| | Milestone | State |
|---|---|---|
| M0 | Foundations — repo, tooling, CI, ADR-0001/0002, license, docs | done |
| M1 | Execution core — `request` + `exec` + `store` | done |
| M2 | Digest + Inspect — **the context-economy bet** | done, measured |
| M3 | Environments, secrets, redaction, policy gate, auth | done, canary suite green |
| M4 | Spec discovery — load, index, search, describe — **the search bet** | done, measured |
| M5 | CLI — seven commands, `--json`, cold-start gate | done, measured |
| M6 | MCP server (6 tools) | done, measured — one criterion open, see §6 |
| M7 | v0.1 release | **code done; 4 human-gated items, see §11** |

**The next action is not code.** Everything M7 can build is built. What is left is
creating the GitHub remote, verifying the server in two real MCP hosts, three
external testers, and four more real public specs — the checklist is
`docs/RELEASING.md`, and §11 below says why each one resisted automation.

**The engine has now been run against a live third-party API** — a 490-operation
ASP.NET CRM, end to end, redaction and production gate included. §12 records what
held and the two findings it produced.

### Verification state at checkpoint

All gates green on Windows / Node 24.18:

```
pnpm run check          biome ci .  →  76 files, 0 errors, 0 warnings
pnpm run typecheck      tsc --noEmit → clean
pnpm run build          tsc -p tsconfig.build.json → dist/
pnpm run test:coverage  281 passed (22 files); 94.1% stmts, 88.3% branches
pnpm run bench          cold start p50 63.0 ms, p95 76.2 ms (budget 200 ms)
pnpm run docs:check     docs/cli.md up to date
pnpm run cost:check     README token-cost table up to date
pnpm run example        examples/quickstart — every documented command works
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
| The CLI starts fast enough to replace `curl` (N1) | p95 **76.2 ms**, budget 200 ms |

If either bet had failed, ADR-0002 was wrong and one-tool-per-operation was the
better design. Neither did. **Nothing structurally risky is left.**

M7 added the reproducible version of the first claim: `pnpm run cost` measures
digest-plus-one-inspect against four fixtures and writes the table into the
README, staleness-gated like `docs:check`. It is deliberately unflattering — on a
1 MB list the round-trip costs **0.05%** of the body, and on a 202-byte error
envelope it costs **202%**, because a digest has fixed overhead and loses on
anything already small enough to paste. Stated in the README rather than hidden by
choosing only large fixtures.

---

## 2. Git state

**Still no remote.** Creating it is step 1 of `docs/RELEASING.md` and it blocks
provenance: the attestation comes from the workflow's OIDC identity, so a release
published from a laptop cannot carry one.

`main` carries M0–M5:

```
84f0401 docs: update checkpoint and README for M5
440d3e5 feat(cli): M5 — seven commands over the engine
461b93d feat: project foundations and core engine (M0-M4)
```

Two branches are ahead of it, and the order matters:

```
feat/mcp-server    5fbd9bd  M6 — the MCP server + its checkpoint update
feat/v0.1-release  aa84b2e  M7, branched from the tip of feat/mcp-server
```

`feat/v0.1-release` **contains** M6, so squash-merging both into `main` would
duplicate it. Merge them in order, or squash the pair as one release commit:

```sh
git checkout main && git merge --squash feat/mcp-server && git commit   # M6
git merge --squash feat/v0.1-release && git commit                      # M7
```

M7's three commits are worth keeping distinct in a review — the redaction fix, the
executable example, and the release plumbing are independent changes.

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
Dev: `@biomejs/biome`, `@changesets/cli`, `@types/node`, `@vitest/coverage-v8`,
`typescript`, `vitest`.

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
| 0003 | Lazy `$ref` resolution instead of a dereferencing library; in-house search ranker; **a configured spec URL is its own authorisation, not the host allowlist** (decision 3, M7). Amends BLUEPRINT §12.3. |
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
   text, inspect output *including the stored-run path*, the metadata file on
   disk, or a thrown error's message and stack. Base64 forms checked separately.
   The stored-run path rebuilds its redactor from the record's `environment`, and
   two cases in that suite assert the honest failure: when it cannot be rebuilt,
   `redacted` is false and the canary *is* in the output. An adapter that drops
   that flag reopens the hole.

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
| **Real-world spec validation: one down, four to go.** M4's criterion says five public specs. **One real spec has now been run** — 601 KB, 490 operations, OpenAPI 3.0.1 out of ASP.NET/Swashbuckle — and it loaded, indexed and ranked correctly with zero warnings, over both a local file and its live URL. It covers the two cases the synthetic fixtures cannot: generator output nobody hand-wrote, and near-500-operation scale that is real rather than generated. Four more still wanted, ideally including one 3.1 spec and one with `$ref` into sibling files. Drop them into `tests/fixtures/specs/` as `local-*` — globbed, gitignored, all three extensions. See that directory's README. | ongoing; the corpus grows for free |
| ~~**Loading a spec by URL.**~~ **Closed in M7.** `src/core/spec/remote.ts`, behind a dynamic import so a local-only workspace still runs `search` without the HTTP stack. Protocol gate, same-host redirects only, 16 MB cap, 24-hour cache in `.apipilot/.cache/specs/`, stale-copy fallback when a refresh fails. Why it is *not* gated on the host allowlist is ADR-0003 decision 3. | done |
| **Cold start is gated on an absolute 200 ms p95, not on a >15% regression.** A regression gate needs a committed baseline per OS, and a baseline that drifts upward one accepted commit at a time is worse than no baseline. The bench prints p50/p95 on every run so a creep from 60 ms to 190 ms is visible while still passing. | M7, if the absolute gate proves too loose |
| **`--body` takes text only.** No `@file` shorthand, no streaming upload, no multipart. `--body-file` covers the common case; a binary body is not replayable (see §6). | when a real use case lands |
| ~~**`api_inspect` output does not pass a redactor.**~~ **Closed in M7.** The metadata record now carries `environment`, and `inspectRun()` in `src/core/inspect/inspect-run.ts` rebuilds that environment's redactor before rendering. Both adapters route through it. Two cases cannot rebuild one — a pre-M7 record, and an environment whose secrets no longer resolve — and those return `redacted: false` with a warning rather than refusing, because losing access to a stored response over an unset shell variable is worse. Re-resolving gets *today's* secrets, so a value rotated since the run is still not caught. | done, with the rotation caveat |
| **MCP is stdio only.** No HTTP/SSE transport; that is the case where ADR-0004 says to take the SDK instead. | v1, demand-gated |
| **A digest costs more than the raw body on small responses** — 202% on a 202-byte error envelope, measured by `pnpm run cost`. The obvious fix is to inline the body when it is already under the budget, which is a change to what every model sees on every small response, so it wants its own decision rather than a quiet tweak during release week. | v0.2 |
| ~~CodeQL, Dependabot/Renovate, Changesets, issue/PR templates~~ | done in M7 |
| ~~`.apipilot/` example workspace under `examples/`, executed in CI~~ | done in M7 — `examples/quickstart`, `pnpm run example` |

Closed in M5: the run log, the coverage gate (85% on `src/core`), the
cold-start benchmark, and docs generated from source with a staleness check.

Closed in M7: the stored-run redaction hole, spec loading by URL, the executable
example, the reproducible token-cost table, and the release plumbing —
changesets, a provenance publish workflow, CodeQL, Dependabot, issue and PR
templates.

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
   ├─ inspect/
   │  ├─ json-path.ts           JSONPath subset — no filter expressions, ever
   │  ├─ inspect.ts             capped drill-down; takes a redactor, knows no storage
   │  └─ inspect-run.ts         the stored-run path: rebuilds the run's redactor
   ├─ redact/redactor.ts        THE choke point — raw, base64, percent-encoded forms
   ├─ secrets/resolvers.ts      env + file; the one interface with 3 known impls
   ├─ vars/interpolate.ts       {{var}}; depth-first, never rescans substituted text
   ├─ auth/apply.ts             bearer / basic / apikey, all registered with the redactor
   ├─ policy/policy.ts          host allowlist + production mutation gate + redirect guard
   ├─ run/run.ts                runRequest + replayRun — THE end-to-end request path
   ├─ workspace/{schema,workspace}.ts   .apipilot/ discovery, YAML + Zod, local overrides
   └─ spec/
      ├─ document.ts            load + LAZY $ref, directory-escape guard
      ├─ remote.ts              spec by URL — the one egress event in discovery
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
pnpm run cost                # regenerate the README token table; cost:check to verify
pnpm run example             # examples/quickstart, end to end — needs a build first
pnpm changeset               # write a changeset; release:version consumes them

pnpm exec vitest run -u                  # update goldens — READ THE DIFF
pnpm exec vitest run spec-search         # the search-bet suite
pnpm exec vitest run canary              # the secret-leakage suite
pnpm exec vitest run cli                 # the CLI integration suite
pnpm exec vitest run mcp                 # protocol conformance + the token budget
pnpm exec vitest run spec-remote         # spec-by-URL: cache, staleness, redirects

# The MCP server is a normal process on two pipes. Needs a build first.
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/cli/index.js mcp --dir .

# What CI does for NFR N7, on Linux: the suite, with no route off loopback.
sudo -E env "PATH=$PATH" unshare --net --fork sh -c 'ip link set lo up && exec pnpm test'
```

`bench` and `docs:check` both read `dist/`. Build first or they measure
nothing — `bench` skips silently when `dist/` is absent, which is why CI
builds before it tests.

---

## 11. M7 as built, and the four things it could not close

**Acceptance criteria from BLUEPRINT §20:**

| Criterion | State |
|---|---|
| README carries a reproducible token-cost comparison | `pnpm run cost`, staleness-gated in CI |
| `examples/` run in CI | `examples/quickstart`, `pnpm run example` |
| SECURITY.md complete | written in M0; the pre-alpha notice comes out at publish |
| Published to npm with provenance | **workflow written, never run — no remote, no token** |
| `npx api-pilot` works clean on all three OSes | **smoke job written; it can only run after a publish** |
| 3 external testers complete the §19 success test | **not started** |
| *(from M6)* verified working in Claude Code and one other host | **not done** |

### What M7 decided

- **The redaction boundary now closes on stored data, not just live data.** The
  metadata record carries `environment`; `inspectRun()` rebuilds that
  environment's redactor. The interesting part is the failure mode: when the
  redactor *cannot* be rebuilt the output is returned unredacted with
  `redacted: false` and a warning, rather than refused. Refusing would mean an
  unset shell variable locks you out of a stored response. Two canary cases assert
  the honest version — flag false, canary present — so an adapter that silently
  drops the flag fails a test rather than leaking.
- **Re-resolving secrets gets today's values.** A credential rotated since the run
  is not caught. The alternative is storing the resolved secrets beside the
  response so they can be matched later, and that file would be the leak.
- **A configured spec URL is its own authorisation** (ADR-0003 decision 3). Not
  the host allowlist: it is per-environment, specs are per-workspace, and gating
  on it would make `search` resolve secrets before it could answer anything.
- **`fromValue` is the remote loader's entry point**, so a fetched spec cannot
  follow a `$ref` into a sibling URL. Deriving new URLs from document contents is
  the thing SECURITY.md T2 says we never do.
- **The token-cost table is unflattering on purpose.** Two of four rows show API
  Pilot costing more than the raw body. Picking only large fixtures would have
  produced a better-looking README and a worse project.
- **The version stays at `0.0.0`.** A changeset for 0.1.0 is committed;
  `pnpm run release:version` produces the bump and the changelog when someone is
  actually ready to publish. Bumping now would put a release in the repo that does
  not exist on npm.
- **Publishing is tag-driven, gated on a `release` environment**, and re-runs the
  whole suite on the tagged commit. "CI was green on some ancestor" is not the
  claim a published tarball makes.

### Why the four open items resisted automation

Each one needs a person, and saying which kind of person is the useful part:

1. **The remote and the npm token.** Provenance is an attestation about *where* a
   build happened; it cannot be manufactured locally. Nothing else in M7 unblocks
   until this exists. `docs/RELEASING.md` §"Once, before the first release".
2. **Two real MCP hosts.** The conformance suite drives real streams and covers 26
   cases, and it still cannot produce the fixture a host produces: an unexpected
   `initialize` payload, or a working directory that is not where you assumed.
   This is the criterion most likely to find something.
3. **Three external testers.** The evidence being sought is that someone who did
   not build it can complete the §19 task. No test can stand in for that.
4. **Five real public specs.** CI cannot reach the network by design (NFR N7), and
   Stripe's spec is 6 MB. Download them into `tests/fixtures/specs/` — globbed,
   `local-*.yaml` gitignored — and run the suite. Expect parser gaps; that is the
   point of the exercise, not a reason to skip it.

---

## 12. First real-API run — 2026-08-03

The engine has been driven end to end against a live third-party API, not a
fixture server. Worth recording because it is the first evidence that is not
self-generated, and because it produced two findings.

**The spec:** a CRM on ASP.NET/Swashbuckle. 601 KB, **490 operations**, OpenAPI
3.0.1, plain HTTP on a raw IP with a non-standard port.

**What held:**

- Loaded and indexed with **zero warnings**, from a local file and from its live
  URL. The URL path fetched 601 KB, cached it under `.apipilot/.cache/specs/`, and
  the next search used the cache without a request — `src/core/spec/remote.ts` had
  only ever run against a loopback test server before this.
- Search ranked correctly on queries the API can answer: "login", "register a
  user", "update password", "invoice due", "holidays" each put the right operation
  first. An earlier reading that the ranker had failed was wrong — the failing
  query was "list users" against an API that has no user-list endpoint.
- `describe` stayed compact on operations carrying no documentation at all.
- A real authenticated `GET` returned 200, gzip decoded, 60 bytes rendered as a
  shape plus a sample, and a handle instead of a body.
- `env crm` printed the bearer token as `[redacted]`.
- `PUT` against the `production`-classified environment was refused with
  `CONFIRMATION_REQUIRED` and sent nothing.

**Findings:**

1. **The spec declares no `operationId` and no `summary` — 490 of 490 — and
   nothing says so.** Ids are synthesised from method and path
   (`get_api_City_GetCityList`), which is the right fallback, but the silence is
   not: it is why `describe GetCityList` fails, and why search has only path
   tokens to rank on. This is the norm for Swashbuckle output without XML docs, so
   it will recur. **One aggregate warning per spec** — not 490 — is the fix. Left
   undone deliberately: spec warnings ride along in every `api_search` result, so
   adding one changes what every model sees in every session.
2. **Two of that API's operations take `Password` as a query parameter.** Not our
   bug, but it is the case where a request URL carries a credential, which is
   exactly what `ResponseStore.put`'s redactor exists for. It held, because the
   token came from a secret reference. A password passed inline on the command line
   would not be covered — there is nothing to seed the redactor with.

**Corpus effect:** the file lives at `tests/fixtures/specs/local-*.json`, so it is
part of the load corpus on that machine and gitignored everywhere else. Getting
there needed two fixes — the corpus globbed `*.yaml` only, so a JSON spec was
silently skipped while the test still passed, and `.gitignore` covered only
`local-*.yaml`, so a private API's spec was committable.
