# Releasing

Publishing is tag-driven and runs in CI. This page is the part that cannot be
automated, plus the reasoning for why each step is where it is.

## Once, before the first release

None of this can be done from a clone — it needs the GitHub repository and an
npm account.

1. ~~**Create the GitHub remote and push.**~~ **Done** —
   `https://github.com/iamhamzabaig/api-pilot.git`, all branches pushed. This was
   the prerequisite for everything else: provenance is produced from the workflow's
   OIDC identity, so a release published from a laptop cannot carry one.

2. **Authenticate the publish — and not with a token.** This resisted three
   attempts and the reason is worth writing down.

   With 2FA on the account in `auth-and-writes` mode, `npm publish` from CI ends
   in `EOTP` — it wants a one-time password, and a runner has nobody to type
   one. A granular access token does not change that; only a token with *bypass
   2FA* does, and npm is closing that door: [bypass tokens lose account
   management in August 2026 and direct publishing in January
   2027](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/).

   So the first release of `0.1.0` was published by hand, with an interactive
   OTP, and carries **no provenance attestation** — attestation comes from the
   workflow's OIDC identity and cannot be produced from a laptop.

   Every release after it uses **trusted publishing (OIDC)**, which has no
   standing credential at all. It could not be set up first: npm only accepts
   trusted-publisher configuration for a package that already exists, unlike
   PyPI. Configure it once on the package's npm settings page —

   | Field | Value |
   |---|---|
   | Organization or user | `iamhamzabaig` |
   | Repository | `api-pilot` |
   | Workflow filename | `release.yml` |
   | Environment | `release` |

   — all case-sensitive and exact. The workflow already has the `id-token:
   write` permission OIDC needs. Once it is configured, delete the `NPM_TOKEN`
   secret and the `NODE_AUTH_TOKEN` block from `release.yml`; leaving a
   long-lived publish credential in place after it stops being load-bearing is
   the whole thing OIDC exists to avoid.

3. **Create the `release` environment** (Settings → Environments) and add
   yourself as a required reviewer. Tag pushes then pause for approval before
   anything reaches npm — the one guard against a mistyped tag publishing.

4. ~~**Reserve the name.**~~ **Done, the hard way.** `npm view api-pilot` returned
   404, which says only that nobody registered it — *not* that it can be
   published. npm runs a typosquat similarity check at publish time, and it
   rejected `api-pilot` as too close to the existing `apipilot`:

   ```
   403 Forbidden - PUT https://registry.npmjs.org/api-pilot
   Package name too similar to existing package apipilot
   ```

   Hence the scope. `@hamzu/api-pilot` skips the similarity check entirely, which
   is the only way to know a name is available before attempting the publish. The
   `bin` is still `api-pilot`, so every documented command is unchanged; only
   install and `npx` lines carry the scope. Scoped packages default to
   restricted, so `publishConfig.access` is set to `public` in `package.json`
   rather than relying on the `--access public` flag alone.

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
   with `--provenance`, then smoke-tests `npx @hamzu/api-pilot@<version>` on Linux,
   macOS and Windows — `--version`, and a `tools/list` frame through the MCP
   server.

6. **Verify the provenance badge** appears on the npm page. If it is missing, the
   publish did not attest, and that is worth understanding before announcing.

## Before v0.1.0 specifically

Three things gate the first release and none of them can be closed by a test run.

- [ ] **Verified working in Claude Code and one other host.** This is the M6
      acceptance criterion still open. `docs/guides/mcp-setup.md` has the
      configuration for five hosts; the fixture only a real host produces is an
      odd `initialize` payload or a working directory you did not expect.

      The published package has been driven end to end over stdio —
      `initialize`, `tools/list`, `api_env`, `api_search`, `api_call` against a
      live server, `api_history`, no secret in any frame — but by a script, not
      by a host. That proves the transport and leaves the criterion open: what
      is unverified is what a host does *around* the protocol.

      It has already paid for itself once. Registering the server with Codex
      exposed that every host example here omitted the `env` block, so any
      workspace using a `${env:...}` reference failed on its first call for
      anyone following the guide.
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
`npm deprecate @hamzu/api-pilot@<version> "<reason>"` first, so installs warn while the
fix builds.
