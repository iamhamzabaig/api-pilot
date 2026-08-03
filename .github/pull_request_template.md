<!--
Keep this short. The interesting part of a PR is why, not a restatement of the diff.
-->

## What and why

<!-- One paragraph. What changes, and what problem it solves. -->

## Checks

- [ ] `pnpm run check && pnpm run typecheck && pnpm run build && pnpm run test:coverage` pass
- [ ] A **changeset** if this changes anything a user or a model can observe —
      the public API, a CLI flag, an MCP tool definition, an output format
      (`pnpm changeset`; see `.changeset/README.md`)
- [ ] `pnpm run docs` re-run if any `--help` text changed
- [ ] Behaviour is covered by a test that fails without this change

## Things that need a sentence of justification

Tick only what applies, and say why in the section above.

- [ ] **A new production dependency.** Currently 2 against a cap of 12 (NFR N10).
      Three were considered and refused — see `docs/CHECKPOINT.md` §3.
- [ ] **A change to an MCP tool definition.** These serialize into every model's
      context in every session, gated at 1,500 tokens by
      `tests/golden/mcp-tools.test.ts`. A *seventh tool* needs an ADR (ADR-0002).
- [ ] **A change to a golden snapshot.** Read the diff; it is the specification of
      what a model sees. Never accept one with `-u` unread.
- [ ] **A change to `src/core/spec/search.ts` ranking constants.** Treat a moved
      assertion in `spec-search.test.ts` as a product change, not a flaky test.
- [ ] **Anything on a path that can carry a credential.** The canary suite is the
      real specification of the redaction guarantee; extend it rather than
      working around it.
- [ ] **A new static import in `src/cli/index.ts`.** It runs on `--version` and
      would pull the whole engine into a 200 ms cold-start budget.
