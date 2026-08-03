# Changesets

A changeset is a note about a user-visible change plus the version bump it
deserves. `pnpm changeset` writes one; the release workflow consumes them all,
bumps the version and generates `CHANGELOG.md`.

**Write one when you change what a user or a model can observe:** the public API
in `src/index.ts`, a CLI flag, an MCP tool definition, an output format, or
behaviour anyone could be relying on. That includes a bug fix — the fix is the
thing people need to read about.

**Skip it for** tests, comments, internal refactors, and documentation, none of
which change what the package does.

Before 1.0.0, `minor` is the breaking-change bump and `patch` is everything else.
An MCP tool definition changing shape is a `minor` even though it looks small:
those definitions are the contract every model sees in every session.
