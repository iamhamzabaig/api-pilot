# Releasing

Publishing is tag-driven and runs in CI. This page is the part that cannot be
automated, plus the reasoning for why each step is where it is.

## Once, before the first release

None of this can be done from a clone — it needs the GitHub repository and an
npm account.

1. **Create the GitHub remote and push.** The repository has no remote yet.
   Provenance is produced from the workflow's OIDC identity, so a release
   published from a laptop cannot carry one.

   ```sh
   git remote add origin git@github.com:<owner>/api-pilot.git
   git push -u origin main
   ```

2. **Add the `NPM_TOKEN` secret.** An npm *automation* token with publish scope,
   under Settings → Secrets → Actions. Automation rather than a classic token,
   so it works with 2FA enforced on the account.

3. **Create the `release` environment** (Settings → Environments) and add
   yourself as a required reviewer. Tag pushes then pause for approval before
   anything reaches npm — the one guard against a mistyped tag publishing.

4. **Reserve the name.** `npm view api-pilot` — if it is taken, the package name
   in `package.json` and every `npx api-pilot` reference has to change together.

5. **Turn on private vulnerability reporting** (Settings → Security). SECURITY.md
   tells people to use it.

6. **Protect `main`:** require the `check` and `analyze` jobs, disallow direct
   pushes. BLUEPRINT §15 assumes squash merges onto a protected trunk.

## Every release

1. **Make sure a changeset exists** for everything user-visible since the last
   release. `pnpm changeset` writes one.

2. **Bump and generate the changelog.**

   ```sh
   pnpm run release:version   # consumes .changeset/*.md → package.json + CHANGELOG.md
   ```

   Read the generated `CHANGELOG.md` before committing it. Before 1.0.0, `minor`
   is the breaking bump.

3. **Run the full gate locally.** CI runs all of it again, but finding a failure
   here costs a minute instead of a round trip.

   ```sh
   pnpm run check && pnpm run typecheck && pnpm run build
   pnpm run test:coverage && pnpm run bench
   pnpm run docs:check && pnpm run cost:check && pnpm run example
   ```

   `pnpm run bench` measures the machine as much as the tool — a red result on a
   loaded laptop is noise. Re-run it idle before believing it.

4. **Commit, tag, push.** The tag must match `package.json` exactly; the workflow
   refuses to publish if it does not.

   ```sh
   git commit -am "release: v0.1.0"
   git tag v0.1.0
   git push origin main --follow-tags
   ```

5. **Approve the `release` environment** when the workflow asks. It publishes
   with `--provenance`, then smoke-tests `npx api-pilot@<version>` on Linux,
   macOS and Windows — `--version`, and a `tools/list` frame through the MCP
   server.

6. **Verify the provenance badge** appears on the npm page. If it is missing, the
   publish did not attest, and that is worth understanding before announcing.

## Before v0.1.0 specifically

Three things gate the first release and none of them can be closed by a test run.

- [ ] **Verified working in Claude Code and one other host.** This is the M6
      acceptance criterion still open. `docs/guides/mcp-setup.md` has the
      configuration for four hosts; the fixture only a real host produces is an
      odd `initialize` payload or a working directory you did not expect.
- [ ] **Three external testers complete the §19 success test.** BLUEPRINT §19
      defines it. Their transcripts are the only evidence that the tool works for
      someone who did not build it.
- [ ] **Load five real public specs.** M4's criterion is still unmet: CI cannot
      reach the network, so five synthetic fixtures encode the failure modes
      instead. Download real ones into `tests/fixtures/specs/` (globbed;
      `local-*.yaml` is gitignored) and run the suite. Expect it to find parser
      gaps — that is the point.

Then remove the pre-alpha notice from `SECURITY.md` and the status banner from
`README.md`. Both promise that they come out at v0.1, and leaving them in would
make the next honest thing we write less believable.

## If a release goes wrong

`npm unpublish` is available for 72 hours and is almost always the wrong tool: it
breaks anyone who already installed. Publish a patch instead. For something
actively harmful — a leaked credential in the tarball, a destructive bug — run
`npm deprecate api-pilot@<version> "<reason>"` first, so installs warn while the
fix builds.
