# Contributing to API Pilot

Thanks for considering it. This document is short on purpose — the parts that matter are the constraints, not the ceremony.

## Before you write code

Read [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md), at minimum §8 (Out of Scope) and §14 (Coding Standards). Two rules cause most rejected PRs:

1. **Scope is a contract.** GUI features, hosted services, team sync, and SDK codegen are permanently out of scope. A PR that adds surface area needs an ADR saying what it displaces.
2. **Dependencies are capped at 12 direct production packages.** A new one requires a PR section justifying it against the ladder: standard library → an existing dependency → twenty lines of our own code.

For anything larger than a bugfix, open an issue first. It is cheaper for both of us than a rejected PR.

## Setup

Requires Node ≥ 22 and pnpm.

```sh
corepack enable pnpm
pnpm install
pnpm test
```

## Before you open a PR

```sh
pnpm run check      # biome lint + format (use `pnpm run format` to autofix)
pnpm run typecheck
pnpm test
pnpm run build
pnpm run example    # the documented commands, against a local service
```

CI runs all of it across Linux, macOS, and Windows on Node 22 and 24. There is no warnings-only mode. It also re-runs the suite with egress blocked, because "no test reaches the internet" is meant to be checked rather than asserted.

Two generated artifacts are staleness-gated, so re-run them if you touched what they read:

```sh
pnpm run docs       # docs/cli.md, from the CLI's own --help
pnpm run cost       # the token-cost table in README.md
```

### Changesets

If your change alters anything a user or a model can observe — the public API in `src/index.ts`, a CLI flag, an MCP tool definition, an output format, or a bug's behaviour — run `pnpm changeset` and commit the file it writes. Tests, comments, refactors and docs do not need one. See [`.changeset/README.md`](.changeset/README.md).

## Standards worth repeating

- TypeScript `strict`. `any` is banned; use `unknown` and narrow at the boundary.
- ESM only. No default exports.
- No speculative abstraction: one implementation means no interface, no factory, no config knob.
- Comments explain **why**. Deliberate shortcuts get a `// TODO(scale):` comment naming both the ceiling and the upgrade path.
- Every bugfix ships with a regression test in the same PR.
- Do not mock our own modules. Only the network boundary gets a test double.

### Two invariants that are not negotiable

They exist because their failure mode is silent:

- **Nothing leaves the process without passing the redactor.** A leaked credential is the worst bug this project can have.
- **Nothing returns a full response body** except an explicit `inspect` call with a stated budget. Blowing up a user's context window is the second worst.

## Commits and branches

- Trunk-based. Branch from `main`, keep it short-lived, and target a merge within a few days.
- Branch names: `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`.
- **PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)** — the title becomes the squashed commit and drives the changelog.
- Squash merge only.

## Reviews

Expect direct technical feedback, including on design. Push back if you disagree and bring reasoning — that is the point of review. Be decent to people; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
