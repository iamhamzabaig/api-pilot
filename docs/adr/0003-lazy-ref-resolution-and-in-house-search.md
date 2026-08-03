# ADR-0003: How the spec module loads, resolves and ranks

- **Status:** Accepted
- **Date:** 2026-07-31, extended 2026-08-03
- **Deciders:** Lead Architect
- **Amends:** the tooling choices in BLUEPRINT §12.3, and the dependency budget reasoning in ADR-0001
- **Decisions:** (1) lazy `$ref` resolution, (2) an in-house ranker, (3) a configured spec URL is its own authorisation

## Context

Milestone M4 had to turn OpenAPI documents into something searchable and
describable. The blueprint pencilled in `@apidevtools/json-schema-ref-parser`
for `$ref` handling and left the search implementation open. Building it
surfaced two decisions worth recording, because both went against the
default of "take the obvious dependency". A third was added in M7, when the
module gained the ability to load a spec over HTTP and therefore had to answer
what authorises that fetch.

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

## Decision 3: a spec URL is authorised by being configured, not by the allowlist

*Added 2026-08-03 (M7), when loading a spec from a URL was built.*

`specs:` may now hold an `http(s)://` URL, which makes **indexing an egress
event** — the first one that is not a request the user asked for. The obvious
guard is the per-environment host allowlist that every request passes. We do not
use it, for a structural reason: the allowlist is per-environment, specs are
per-workspace, and `search` deliberately never resolves an environment. Gating
spec loading on the allowlist would mean resolving secrets before you can ask
"which endpoint cancels a subscription", which is both a worse failure mode
(one unset variable and discovery stops) and a wider blast radius.

What authorises the fetch instead is that a human wrote the URL into a committed
config file. That is the same reasoning that lets `specs:` name arbitrary local
paths.

Three guards remain, and they are the ones that cover what configuration cannot:

1. **The protocol gate** — `assertProtocolAllowed`, the same function every
   request goes through. http and https only, so `file:` and `data:` do not
   become a read primitive through the spec list.
2. **Same-host redirects only.** A `Location` header is written by the remote
   server, and the configured URL authorises *that host*, not wherever it
   forwards to. This is the guard the allowlist would otherwise have provided.
3. **A 16 MB cap**, enforced by the executor, so an endless response cannot fill
   the cache directory.

**Consequences:**

- A fetched spec lands in `.apipilot/.cache/specs/<hash of url>.yaml` with a
  fixed 24-hour TTL. No `--refresh` flag: deleting the file is the escape hatch,
  and a flag can be added when someone is genuinely working against an hourly
  spec.
- **A failed refresh falls back to the stale copy** and reports it through the
  spec warnings channel. A spec is a description, not state; a day-old
  description still answers the question, and going offline should not break
  discovery.
- A remote spec cannot follow a `$ref` into a sibling file — it is loaded through
  `fromValue`, which warns on external refs. Fetching a spec's neighbours would
  mean deriving new URLs from document contents, which is exactly the "URLs found
  in data are never followed" line in SECURITY.md T2.
- The fetch path lives in `src/core/spec/remote.ts` behind a **dynamic import**,
  so a workspace of local specs still runs `search` without loading the HTTP
  stack. That is the same lazy-loading discipline the CLI commands use, applied
  one layer down.
