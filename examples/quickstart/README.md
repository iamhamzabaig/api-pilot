# Quickstart: a workspace you can run

A complete `.apipilot/` workspace against a local service, so you can see the
whole loop — discover, call, drill in, replay — without pointing anything at an
API you care about.

`verify.mjs` runs every command below and checks the output. **CI runs it**, so a
command on this page that stops working fails the build rather than quietly
misleading the next person.

## What is here

```
examples/quickstart/
├─ .apipilot/environments.yaml   two environments: local (safe) and prod (gated)
├─ openapi.yaml                  a three-operation spec
├─ server.mjs                    the local widget store, zero dependencies
└─ verify.mjs                    runs everything below and asserts the results
```

## Run it

From the repository root:

```sh
pnpm install && pnpm run build
node examples/quickstart/verify.mjs
```

Or drive it by hand. In one terminal:

```sh
WIDGET_TOKEN=example-token node examples/quickstart/server.mjs
```

In another, from `examples/quickstart/`, with the CLI on your path
(`node ../../dist/cli/index.js` works too):

```sh
export WIDGET_TOKEN=example-token

api-pilot env local                       # resolved config; the token is [redacted]
api-pilot search remove a widget          # ranks deleteWidget first
api-pilot describe createWidget           # params, body schema, auth, under 1 KB
api-pilot call GET '/widgets?limit=400'   # ~38 KB of JSON → a digest and a handle
api-pilot inspect <handle> --path data[0].id
api-pilot history                         # the run log, newest first
api-pilot replay <handle>                 # re-runs the recorded intent
```

## The three things worth noticing

**The 38 KB response never reaches your terminal.** `call` prints a digest —
status, shape, sizes, one sample — and a handle. The bytes are on disk, and
`inspect` queries them under a byte budget. That is the whole context-economy
bet, and the numbers are in the [root README](../../README.md#what-that-costs-measured).

**The token travelled but was never shown.** The widget store returns `401`
without a correct `Authorization` header, so the run proves the credential
reached the wire. It appears in no output stream: not the request summary, not
the digest, not the run log on disk, not an error message. See
[SECURITY.md](../../SECURITY.md) T1.

**Production is gated.** The `prod` environment is classified `production`, so a
`DELETE` against it is refused with `CONFIRMATION_REQUIRED` until you pass
`--confirm` (or, from an MCP host, `confirm: true`). Try it:

```sh
api-pilot call DELETE /widgets/wgt_000001 --env prod
```

## Using it as your own starting point

Copy `.apipilot/environments.yaml`, then:

1. Point `baseUrl` at your service and `specs:` at your OpenAPI document — a
   local path, or an `http(s)` URL, which is fetched once and cached for a day.
2. Replace `${env:WIDGET_TOKEN}` with a reference to wherever your credential
   already lives. `${env:NAME}` and `${file:./path}` both work. **Never write the
   value into this file** — the loader warns if a variable that looks like a
   credential holds a literal.
3. Classify honestly. `classification: production` is what makes the mutation
   gate fire, and the tool cannot infer it from a hostname.

`.apipilot/.cache/` — stored responses, the run log, fetched specs — is
gitignored. `.apipilot/environments.local.yaml` is too, and overrides the
committed file per developer.
