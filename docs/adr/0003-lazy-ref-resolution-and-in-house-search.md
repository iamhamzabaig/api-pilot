# ADR-0003: Resolve `$ref` lazily and write the search ranker in-house

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Lead Architect
- **Amends:** the tooling choices in BLUEPRINT §12.3, and the dependency budget reasoning in ADR-0001

## Context

Milestone M4 had to turn OpenAPI documents into something searchable and
describable. The blueprint pencilled in `@apidevtools/json-schema-ref-parser`
for `$ref` handling and left the search implementation open. Building it
surfaced two decisions worth recording, because both went against the
default of "take the obvious dependency".

## Decision 1: lazy `$ref` resolution instead of a dereferencing library

The standard approach materialises a fully dereferenced document up front. We
keep `$ref` as a pointer and follow it on demand, with a visited set.

**Why:**

- **We never need the whole document.** `search` reads operation metadata;
  `describe` renders one operation. Dereferencing a 6 MB public spec to answer
  a question about one endpoint is work whose output is thrown away.
- **A dereferenced document is a cyclic object graph.** `Comment.replies:
  Comment[]` becomes a real cycle in memory, and then every consumer —
  renderer, serialiser, equality check — has to defend against it. Lazy
  pointers push that concern into one place.
- **It produces better output.** A visited `$ref` renders as `Comment` rather
  than being expanded until a depth cap bites. For a recursive schema, the
  component's name *is* the correct description.
- The implementation is roughly 150 lines, most of which is the JSON Pointer
  walk and the directory-escape guard.

**Consequences:**

- External `$ref` files must be discovered and preloaded before rendering,
  because the resolver has to be synchronous for the renderer. `loadSpec` scans
  the document for external refs and loads them eagerly. Remote (`http://`)
  refs are deliberately not followed at all — see below.
- Refs may not escape the spec's directory. A spec is user-supplied data and a
  `$ref` is otherwise a file-read primitive pointed anywhere on disk. Attempts
  become a warning, not a read.
- Loading a spec by URL is **not** implemented, though BLUEPRINT §6.1 tags it
  MVP. Fetching a spec makes loading an egress event, which needs the policy
  gate wired into it first. Tracked as remaining MVP scope, not as done.
- We own the correctness of pointer resolution. Mitigated by fixtures for
  circular, mutually recursive, split-file, and dangling refs.

## Decision 2: an in-house ranker instead of a search library

**Why:** the hard part of API search is not the ranking maths — that is a
standard IDF scheme in about sixty lines — it is domain knowledge that a
general-purpose text index has no way to express:

- `getUserById` is four tokens, not one. Without camelCase splitting,
  natural-language search over generated operationIds does not work at all.
- "update" means PATCH or PUT, and is evidence *against* DELETE. Method intent
  turned out to be the single most valuable signal in the corpus.
- "list" wants a collection route, not `/{id}`.
- An operation that is *about* something the query never mentioned should be
  penalised. `/subscriptions/{id}/items` outscores `/subscriptions` on raw term
  weight for the query "list subscriptions" — it says "subscription" more
  often — while being the wrong answer. A drift penalty over the operation's
  identity tokens fixes this; no off-the-shelf ranker has the notion.

Three of those four were only discovered by watching the ranker fail on
realistic queries. A dependency would have had to be fought at each step.

**Consequences:**

- Production dependencies stay at **2** (`yaml`, `zod`) against a cap of 12.
- Ranking quality is now our problem, and it is tuned against a fixture
  corpus rather than proven in general. The tuning constants
  (`SATURATION`, `DRIFT_PENALTY`, intent bonuses) are exactly the kind of thing
  that silently degrades, so `tests/unit/spec-search.test.ts` asserts specific
  natural-language queries land on specific operations. That suite is the
  regression net; treat a change there as a product change.
- The stemmer is a deliberately small suffix stripper, not Porter. It exists to
  collapse update/updates/updating/updated onto one token. Anything more
  aggressive starts merging unrelated resource names, which is a worse failure
  than missing an inflection.
- If ranking proves inadequate on real specs at scale, the escape hatch is to
  keep the tokeniser and intent layer and swap only the scoring — the two are
  already separate.
