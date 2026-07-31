# Checkpoint — 2026-07-31

Resume point for API Pilot. Read this first, then `docs/BLUEPRINT.md` §19–20 for the
roadmap and `docs/adr/` for the decisions that are already locked.

---

## 1. Where things stand

**Milestones M0–M4 complete. M5–M7 remain.** That is roughly the first two-thirds
of the ~6-week MVP.

| | Milestone | State |
|---|---|---|
| M0 | Foundations — repo, tooling, CI, ADR-0001/0002, license, docs | done |
| M1 | Execution core — `request` + `exec` + `store` | done |
| M2 | Digest + Inspect — **the context-economy bet** | done, measured |
| M3 | Environments, secrets, redaction, policy gate, auth | done, canary suite green |
| M4 | Spec discovery — load, index, search, describe — **the search bet** | done, measured |
| M5 | CLI | **next** |
| M6 | MCP server (6 tools) | not started |
| M7 | v0.1 release | not started |

### Verification state at checkpoint

All four gates green on Windows / Node 24.18:

```
pnpm run check       biome ci .  →  50 files, 0 errors, 0 warnings
pnpm run typecheck   tsc --noEmit → clean
pnpm test            196 passed (17 files)
pnpm run build       tsc -p tsconfig.build.json → dist/
node dist/cli/index.js --version → 0.0.0
```

### Both product bets are measured, not asserted

| Claim | Measured |
|---|---|
| A 1 MB JSON response fits a 2 KB digest | 1,051,814 B → **373 B** (0.035%) |
| A 1,000-operation spec stays interactive | index **24 ms**, search **0.44 ms** |
| A 1,000-operation spec adds zero MCP tools | 6 tools, unchanged |

If either had failed, ADR-0002 was wrong and one-tool-per-operation was the better
design. Neither did. **Nothing structurally risky is left** — M5–M7 are assembly.

---

## 2. IMPORTANT: nothing is committed

`git init` ran on branch `main`. There are **zero commits**. Every file is untracked.

First action next session, unless you want something else:

```sh
cd D:/Projects/api-pilot
git status --short          # ~60 untracked paths
git add -A
git commit -m "feat: project foundations and core engine (M0-M4)"
```

Or commit per milestone from the module boundaries — the work is cleanly separable:
M0 (config/docs/CI), M1 (`src/core/{errors,request,exec,store}`), M2
(`src/core/{body,digest,inspect}`), M3 (`src/core/{workspace,secrets,redact,vars,policy,auth}`),
M4 (`src/core/spec`).

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

Two open questions from BLUEPRINT §21 were **resolved by the user on 2026-07-31**:

- **Q3 — production mutation confirmation:** host approval UI **plus** a required
  `confirm: true` argument. Implemented in `src/core/policy/policy.ts`.
- **Q4 — history location:** gitignored `.apipilot/.cache/`. Not committed.

Questions 1, 2, 5, 6, 7 in §21 are still open but none of them block M5–M7.

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

4. **The MCP tool surface stays at six.** Enforced socially by ADR-0002 today;
   M6 adds the golden-file token-budget test (≤ 1,500 tokens, NFR N3).

5. **Search ranking is tuned, not proven.** The constants in
   `src/core/spec/search.ts` (`SATURATION`, `DRIFT_PENALTY`, intent bonuses) are
   exactly the kind of thing that silently degrades.
   `tests/unit/spec-search.test.ts` asserts specific natural-language queries land
   on specific operations. **Treat a change there as a product change, not a
   flaky test.**

6. **Golden snapshots are the spec of what a model sees.** `tests/golden/`.
   Never accept a diff with `-u` without reading it.

---

## 6. Next milestone: M5 — CLI

From BLUEPRINT §20. Estimated ~1 week.

**Scope:** a human-facing surface over the finished core. `search`, `describe`,
`call`, `inspect`, `history`, `replay`, `env`. `--json` on every command.

**Acceptance criteria:**
- All seven commands work.
- `--json` on every command.
- **Cold start < 200 ms p95 on all three OSes, gated in CI.** This is the one
  remaining number that could bite — NFR N1.
- Reference docs generated from source, with a CI staleness check.

**Notes for whoever picks this up:**
- `src/cli/index.ts` is still the M0 stub using `node:util.parseArgs`. Keep it
  that way. A CLI framework (oclif/yargs/commander) is a top cause of Node
  startup cost and would put N1 out of reach — see ADR-0001 consequences.
- Lazy-load anything not needed by `--version`. That path must import almost
  nothing.
- `history` is **not built yet** — `src/core/history/` does not exist. It is
  listed under M1's module table in BLUEPRINT §11 but was not in M1's acceptance
  criteria and was not built. M5 needs it, or `history`/`replay` must slip to M6.
  This is the one real surprise waiting in M5. Decide early.

---

## 7. Known gaps, carried forward deliberately

Each was a conscious call, not an oversight. Listed so none of them quietly
becomes "done".

| Gap | Where it belongs |
|---|---|
| **No real-world spec validation.** M4's criterion "loads 5 real-world public specs" is **not met** — CI cannot touch the network and Stripe's spec is 6 MB. Five synthetic fixtures encode real failure modes instead; the ≥500-op case is generated. Closable with no code change: drop a downloaded spec into `tests/fixtures/specs/` (it is globbed; `local-*.yaml` is gitignored). See that directory's README. **Worth doing manually before v0.1 — expect it to find parser gaps.** | before M7 |
| **Loading a spec by URL.** BLUEPRINT §6.1 tags it MVP. Fetching makes loading an egress event and needs the policy gate wired in. | M5 or M6 |
| **`src/core/history/`** — run log, replay. See §6 above. | M5 |
| Coverage gate (`vitest --coverage`, ≥85% on `src/core`) | M5 |
| Cold-start benchmark in CI, failing on >15% regression | M5 |
| Egress-blocked CI job (NFR N7) | M6 |
| CodeQL, Dependabot/Renovate, Changesets, issue/PR templates | M7 |
| `.apipilot/` example workspace under `examples/`, executed in CI | M7 |
| Docs generated from source + staleness check | M5 |

---

## 8. Map of the code

```
src/
├─ index.ts                     public API surface — changes here need a changeset
├─ version.ts                   resolves package.json version (dist/ and src/ same depth)
├─ cli/index.ts                 M0 STUB — --version and --help only
└─ core/
   ├─ errors.ts                 ApiPilotError, one class + stable `code` discriminant
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

---

## 10. Commands

```sh
pnpm install
pnpm test                    # vitest run
pnpm test:watch
pnpm run check               # biome ci  — no warnings-only mode
pnpm run format              # biome check --write
pnpm run typecheck
pnpm run build

pnpm exec vitest run -u                  # update goldens — READ THE DIFF
pnpm exec vitest run spec-search         # the search-bet suite
pnpm exec vitest run canary              # the secret-leakage suite
```
