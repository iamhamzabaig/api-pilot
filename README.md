# API Pilot

**Let an AI assistant call your HTTP APIs — without pasting huge responses into its
context and without ever showing it your credentials.**

Works with Claude Code, Claude Desktop, Cursor, Zed and anything else that speaks
MCP. Also a normal CLI you can use by hand.

> **Status: pre-alpha (v0.0.0), not on npm yet.** Everything below works, but the
> install step is "clone and build" until the first release lands. Where you see
> `npx api-pilot`, use `node /path/to/api-pilot/dist/cli/index.js` for now.

---

## Contents

- [What problem this solves](#what-problem-this-solves)
- [Install](#install)
- [Your first five minutes](#your-first-five-minutes)
- [Use it with an AI assistant](#use-it-with-an-ai-assistant)
- [Use it from the terminal](#use-it-from-the-terminal)
- [Configuration](#configuration)
- [How responses work](#how-responses-work)
- [What it refuses to do](#what-it-refuses-to-do)
- [When something goes wrong](#when-something-goes-wrong)
- [Why not just curl](#why-not-just-curl)
- [Design and internals](#design-and-internals)

---

## What problem this solves

Ask an assistant to call an API and three things go wrong.

**The response floods the context.** A list endpoint returns 200 KB of JSON, all of
it gets pasted into the conversation, and you have burned 50,000 tokens to learn
that the first item has an `id` field.

**Your credentials end up in the transcript.** The token gets typed into a command,
which gets echoed, which gets saved.

**The assistant guesses.** It does not know your endpoints, so it invents plausible
paths and you spend the next five minutes correcting 404s.

API Pilot fixes all three. Responses get summarised into a small digest with a
handle you can query for the parts you actually need. Credentials live in
environment variables and are resolved at the last moment, never printed. And your
OpenAPI or Swagger spec becomes searchable, so the assistant looks up the real
endpoint instead of guessing.

---

## Install

**Requires Node 22 or newer.**

### Today — from source

```sh
git clone <this-repo> api-pilot
cd api-pilot
corepack enable pnpm
pnpm install
pnpm run build
```

That gives you `dist/cli/index.js`. Either call it directly:

```sh
node /path/to/api-pilot/dist/cli/index.js --version
```

…or put it on your `PATH` so `api-pilot` works anywhere:

```sh
npm link          # from inside the api-pilot directory
api-pilot --version
```

### After the first npm release

No install needed — `npx` fetches it on demand:

```sh
npx api-pilot --version
```

Or install it once:

```sh
npm install -g api-pilot
```

---

## Your first five minutes

Want to see the whole thing working before touching your own API? A complete
working example ships with the repo:

```sh
pnpm run example
```

That starts a small local API, then runs every command against it and checks the
results. Read [`examples/quickstart/README.md`](examples/quickstart/) to see what
it did — it is the fastest way to understand the shape of a real setup.

### Now point it at your own API

**Step 1 — make a workspace.** A workspace is just a folder with a `.apipilot/`
directory in it. Usually that is your project root; API Pilot finds it by walking
up from wherever you are, the way `git` finds `.git`.

```sh
mkdir -p my-project/.apipilot
cd my-project
```

**Step 2 — write one config file.** Save this as `.apipilot/environments.yaml`:

```yaml
version: 1
default: dev

# Your OpenAPI or Swagger document. A file path or an http(s) URL.
specs:
  - https://api.example.com/swagger/v1/swagger.json

environments:
  dev:
    baseUrl: https://api.example.com
    variables:
      # A *reference* to an environment variable — never the token itself.
      token: ${env:MY_API_TOKEN}
    auth:
      type: bearer
      token: "{{token}}"
```

**Step 3 — put your token in your shell**, not in the file:

```sh
export MY_API_TOKEN="..."          # macOS / Linux
$env:MY_API_TOKEN="..."            # PowerShell
```

**Step 4 — check it before calling anything.** This resolves the config and touches
no network:

```sh
api-pilot env dev
```

Your token should show as `[redacted]`. If it prints the real value, that is a bug —
please report it.

**Step 5 — find something and call it:**

```sh
api-pilot search list all customers
api-pilot describe getCustomers
api-pilot call GET /v1/customers
```

You will get back a summary of the response and a handle like `r_msd2x1pj31b99`.
The full body is on disk, not on your screen. To look inside it:

```sh
api-pilot inspect r_msd2x1pj31b99 --path data[0]
```

That is the whole loop: **search → describe → call → inspect**.

---

## Use it with an AI assistant

This is the main way to use API Pilot. The assistant gets six tools and works out
the rest itself.

### Claude Code

```sh
claude mcp add api-pilot -- npx -y api-pilot mcp
```

Before the npm release:

```sh
claude mcp add api-pilot -- node /absolute/path/to/api-pilot/dist/cli/index.js mcp
```

Check it with `/mcp` inside a session. You should see six tools.

### Claude Desktop, Cursor, Zed

Add this to the host's MCP config file:

```json
{
  "mcpServers": {
    "api-pilot": {
      "command": "npx",
      "args": ["-y", "api-pilot", "mcp", "--dir", "/absolute/path/to/my-project"]
    }
  }
}
```

**`--dir` matters.** Claude Code starts the server inside your project, so it finds
`.apipilot/` on its own. Other hosts do not, so tell it where to look. Exact file
locations for each host: **[docs/guides/mcp-setup.md](docs/guides/mcp-setup.md)**.

**One gotcha:** the assistant's server process needs to see your token. Set the
environment variable *before* launching the host, or every call fails with
`SECRET_UNRESOLVED`.

### What the assistant can do

| Tool | What it does |
|---|---|
| `api_search` | Find operations by plain description — "cancel a subscription" |
| `api_describe` | One operation in detail: parameters, body, responses, auth |
| `api_call` | Make the request. Returns a summary and a handle, never a body |
| `api_inspect` | Query a stored response by handle |
| `api_history` | List past runs, or replay one |
| `api_env` | Show configured environments. Never returns secret values |

Six tools, no matter how big your spec is. A 1,000-operation API adds none.

Then just ask for what you want:

> *Find the endpoint that lists open invoices, then call it and tell me how many
> there are.*

---

## Use it from the terminal

Eight commands. Every one except `mcp` takes `--json` for scripting.

| Command | Purpose |
|---|---|
| `api-pilot search <words…>` | Find an operation in your specs |
| `api-pilot describe <id>` | Show one operation in full |
| `api-pilot call <METHOD> <url>` | Make a request |
| `api-pilot inspect <handle>` | Look inside a stored response |
| `api-pilot history` | List past runs |
| `api-pilot replay <handle>` | Run a past request again |
| `api-pilot env [name]` | Show configuration |
| `api-pilot mcp` | Start the MCP server |

```sh
# Search is plain English — no quotes needed, no exact names required
api-pilot search cancel a subscription

# Then read the operation before calling it
api-pilot describe cancelSubscription

# Call it. --env picks a non-default environment
api-pilot call GET /v1/invoices --env staging

# Send a body
api-pilot call POST /v1/customers --body '{"email":"a@b.com"}' --content-type application/json

# Add headers, curl-style
api-pilot call GET /v1/me -H "Accept: application/json"

# Query a stored response — a path, a byte range, or its headers
api-pilot inspect r_m8x2k9qp --path data[0].id
api-pilot inspect r_m8x2k9qp --range 0:512
api-pilot inspect r_m8x2k9qp --headers

# Re-run an old request, optionally somewhere else
api-pilot replay r_m8x2k9qp --env staging
```

Full reference, generated from the CLI itself: **[docs/cli.md](docs/cli.md)**. Or
`--help` on any command.

---

## Configuration

Everything lives in one file: `.apipilot/environments.yaml`. Here it is with every
option used at once.

```yaml
version: 1

# Which environment commands use when you do not pass --env.
default: dev

# OpenAPI / Swagger documents to index. Paths are relative to the folder that
# holds .apipilot/ — not to this file. URLs are fetched once and cached for a day.
specs:
  - openapi/billing.yaml
  - https://api.example.com/openapi.json

environments:
  dev:
    baseUrl: http://localhost:3000
    variables:
      apiToken: ${env:DEV_TOKEN}
    auth:
      type: bearer
      token: "{{apiToken}}"

  staging:
    classification: caution
    baseUrl: https://staging.example.com
    # Explicit list of hosts this environment may talk to. Omit it and the host
    # from baseUrl is the only one allowed.
    allowedHosts: ["staging.example.com", "cdn.staging.example.com"]
    variables:
      user: admin
      pass: ${file:./secrets/staging-password}
    auth:
      type: basic
      username: "{{user}}"
      password: "{{pass}}"

  prod:
    classification: production
    baseUrl: https://api.example.com
    variables:
      key: ${env:PROD_API_KEY}
    auth:
      type: apikey
      name: X-Api-Key
      in: header          # or: query
      value: "{{key}}"
```

### Secrets: `${...}` versus `{{...}}`

Two different syntaxes, and the difference is the point.

- **`${env:NAME}`** and **`${file:./path}`** are *secret references*. The value is
  fetched at the moment of the request and is never printed, stored, or shown to a
  model.
- **`{{name}}`** uses a variable you defined. You can put it in a URL, a header, or
  a body.

```yaml
variables:
  token: ${env:MY_TOKEN}        # secret reference — value stays hidden
  region: eu-west-1             # plain value — safe to print
auth:
  type: bearer
  token: "{{token}}"            # uses the variable above
```

You can use `{{region}}` in a URL too: `api-pilot call GET /{{region}}/status`.

**Never write a token directly into this file.** If you name a variable something
like `token`, `password`, or `apiKey` and give it a literal value, API Pilot warns
you — that file is meant to be committed.

### Auth types

| `type` | Sends |
|---|---|
| `bearer` | `Authorization: Bearer <token>` |
| `basic` | `Authorization: Basic <base64 of user:pass>` |
| `apikey` | A header or query parameter you name |
| `none` | Nothing |

### Classification: `safe`, `caution`, `production`

This is the safety dial, and nothing can guess it for you.

- **`safe`** (the default) — anything goes. Right for localhost.
- **`caution`** — same as safe today; reserved for stricter future defaults.
- **`production`** — **any `POST`, `PUT`, `PATCH` or `DELETE` is refused** unless
  you explicitly add `--confirm` (or the assistant passes `confirm: true`, which
  your host shows you first).

Mark real environments `production`. It is the difference between an assistant
misreading a spec and an assistant deleting your data.

### Per-developer overrides

`.apipilot/environments.local.yaml` overrides the committed file and should be
gitignored. Useful for a personal port or a different token source. Variables merge
key by key, so you can override one value without restating the environment.

### What gets written to disk

Everything lands in `.apipilot/.cache/` — response bodies, run history, fetched
specs. **Add it to `.gitignore`:**

```gitignore
.apipilot/.cache/
.apipilot/environments.local.yaml
```

Response bodies are stored exactly as received, because `inspect` needs the real
bytes. Request details are scrubbed of credentials before being written.

---

## How responses work

This is the part that is different from `curl`, and it is worth one minute.

When you call something, you do **not** get the body. You get:

```
200 OK · application/json · 525.4 KB · 340ms
handle: r_msd2x1pj31b99

array[7000] of {
  id: number
  name: string
  email: string
  active: boolean
}

sample [0]:
{"id":1,"name":"User 1","email":"user1@example.test","active":false}
```

That tells you the response is an array of 7,000 objects, what fields they have, and
what one real item looks like — in about 200 bytes instead of half a megabyte.

The full body is saved. When you need a specific part, ask for it:

```sh
api-pilot inspect r_msd2x1pj31b99 --path [0].email      # one field
api-pilot inspect r_msd2x1pj31b99 --path data[3].lines  # a subtree
api-pilot inspect r_msd2x1pj31b99 --headers             # response headers
api-pilot inspect r_msd2x1pj31b99 --range 0:512         # raw bytes
```

Every output is capped in size. There is deliberately no "print the whole thing"
mode — that is the one behaviour that would undo the entire point.

`--max-bytes` raises or lowers the cap per call if you need more or less.

---

## What it refuses to do

Safety here is on by default rather than opt-in.

**It will not send a mutating request to a production environment** without
explicit confirmation. You get `CONFIRMATION_REQUIRED` and nothing goes out.

**It will not call a host you have not allowed.** Each environment has a host
allowlist, seeded from `baseUrl` if you do not write one.

**It only speaks http and https.** A `file:` URL, a `data:` URL, or a local path
cannot become a request.

**It will not follow a redirect off your allowlist**, even mid-chain, and it strips
credentials when a redirect crosses origins.

**It never shows a model your credentials.** Config holds references; values are
resolved at the HTTP boundary and removed from every output — summaries, digests,
saved history, and error messages, including base64 and URL-encoded forms.

**It marks response bodies as untrusted** when handing them to a model, wrapped in
`<untrusted-api-response>`, because an API response is text written by someone else
arriving in a context that can call tools.

Full threat model, including what is explicitly *not* defended against:
**[SECURITY.md](SECURITY.md)**.

---

## When something goes wrong

**`No .apipilot/ directory found`**
You are not inside a workspace. Create `.apipilot/environments.yaml`, or pass
`--dir /path/to/project`.

**`Environment variable MY_TOKEN is not set`**
Your config references a secret your shell does not have. Export it. If this happens
only inside an AI host, the host was launched before you set the variable — restart
it.

**`No specs are configured for this workspace`**
Add a `specs:` list to your config, or pass `--spec path/or/url` for a one-off.

**`Host api.example.com is not allowed in environment "dev"`**
The URL points somewhere the environment does not permit. Add it to `allowedHosts`,
or check for a typo in `baseUrl`.

**`Environment "dev" has no allowed hosts, so every request is refused`**
No `baseUrl` and no `allowedHosts`. Set at least one.

**`CONFIRMATION_REQUIRED: POST against environment "prod" is classified production`**
Working as designed. Add `--confirm` if you meant it.

**`No operation with id "GetCustomers"`**
Operation ids come from your spec, and many specs do not declare them — in that
case they are generated from the method and path, like
`get_api_Customers_GetCustomers`. Run `search` and copy the id from its output.

**`No stored response for handle r_…`**
That run's cache was cleared, or the handle has a typo. `api-pilot history` lists
what still exists.

**`Protocol c: is not allowed` — on Windows, in Git Bash**
Git Bash rewrites arguments that look like Unix paths, so `/v1/customers` becomes
`C:/Program Files/Git/v1/customers` before API Pilot ever sees it, and the protocol
gate correctly refuses `c:`. Quoting does not help — the shell does it either way.
Three fixes, in order of preference: use PowerShell or `cmd`, pass the full URL
(`https://api.example.com/v1/customers`), or double the leading slash
(`//v1/customers`).

**Search returns odd results**
Ranking uses operation names, paths, summaries and tags. If your spec has no
summaries — common with auto-generated Swagger — there is much less to work with.
Try words that appear in the actual path.

Every error also has a `--json` form with a stable `code`, for scripting.

---

## Why not just `curl`

`curl` is already installed and already works. API Pilot only earns its place by
beating it on four things an agent loop actually struggles with:

| | `curl` in an agent loop | API Pilot |
|---|---|---|
| **Context cost** | a 200 KB JSON response is ~50k tokens pasted into the session | a budgeted digest (shape, sizes, sample) plus a handle you can query |
| **Credentials** | the token ends up in the transcript and shell history | resolved at the HTTP boundary; the model never sees the value |
| **Discovery** | the agent guesses paths or reads the whole spec | search across indexed OpenAPI operations |
| **Reproducibility** | nothing persists | every run logged, replayable, and diffable |

### What that costs, measured

<!-- BEGIN COST: generated by scripts/token-cost.mjs -->

| Response | Raw body | Digest | Digest + one `inspect` | Cost vs. raw |
|---|---|---|---|---|
| 7,000-item user list | 1,096,614 B — ~274,154 tok | 377 B — ~95 tok | 576 B — ~144 tok | **0.05%** |
| paginated invoice page | 35,537 B — ~8,885 tok | 709 B — ~178 tok | 981 B — ~246 tok | **2.76%** |
| single deeply nested resource | 1,797 B — ~450 tok | 1,245 B — ~312 tok | 1,334 B — ~334 tok | **74.23%** |
| error envelope | 202 B — ~51 tok | 389 B — ~98 tok | 408 B — ~102 tok | **201.98%** |

The `inspect` column is the realistic sequence, not the flattering one: the
digest the model always sees **plus** the one follow-up query it makes
(`[0]`, `data[0].lines`, `items[0].price`, `error.code` respectively).
Tokens are estimated at 4 bytes each, which is conservative for JSON.

**The last two rows cost more than the raw body, and that is the honest shape
of it.** A digest carries fixed overhead — status, handle, inferred shape — so
on a response already small enough to paste it loses. The bet was never that
digesting always wins; it is that the payloads which actually threaten a
context window are large and uniform, and there the margin is three orders of
magnitude. Nothing here caps how badly a small response can lose, because the
absolute numbers are tens of tokens.

Reproduce it with `pnpm run build && pnpm run cost`.
<!-- END COST -->

### Why not a spec-to-MCP generator?

Generating one MCP tool per OpenAPI operation is the common approach. On a
500-operation API it produces 500 tool definitions and burns 80 KB of context before
the model does anything.

API Pilot exposes **six tools, always**, and treats the spec as searchable data
instead. Loading a 1,000-operation spec adds zero tools; the whole surface
serializes to ~820 tokens, and a golden test fails if that moves. See
[ADR-0002](docs/adr/0002-fixed-mcp-tool-surface.md).

---

## Design and internals

Everything lives in plain files in your repo: OpenAPI specs and one YAML
environment file holding secret *references*, never secret values. No account, no
cloud, no telemetry. Two production dependencies.

- **[Architecture blueprint](docs/BLUEPRINT.md)** — vision, competitive analysis, requirements, module breakdown, roadmap
- **[ADR-0001](docs/adr/0001-language-and-stack.md)** — TypeScript on Node 22+, and the explicit trigger for revisiting it
- **[ADR-0002](docs/adr/0002-fixed-mcp-tool-surface.md)** — the fixed six-tool surface, and the risk it takes on
- **[ADR-0003](docs/adr/0003-lazy-ref-resolution-and-in-house-search.md)** — lazy `$ref` resolution, an in-house search ranker, and what authorises fetching a spec by URL
- **[ADR-0004](docs/adr/0004-hand-rolled-mcp-stdio-transport.md)** — a hand-rolled stdio transport instead of the MCP SDK

### Development

```sh
pnpm install
pnpm test              # vitest
pnpm run test:coverage # with the 85% gate on src/core
pnpm run check         # biome lint + format
pnpm run typecheck     # tsc --noEmit
pnpm run build         # tsc -> dist/
pnpm run bench         # cold-start budget, < 200 ms p95
pnpm run docs          # regenerate docs/cli.md from the CLI's own --help
pnpm run cost          # regenerate the token-cost table above
pnpm run example       # every documented command, against a local service
```

`pnpm run bench` runs under its own config because it is timing-sensitive: sharing
cores with the main suite's workers roughly triples the measurement.

Releases are tag-driven and published from CI with provenance — see
[docs/RELEASING.md](docs/RELEASING.md).

### Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The short version: the scope
boundaries in [§8 of the blueprint](docs/BLUEPRINT.md#8-out-of-scope) are a
contract, and new dependencies need justification.

Security issues: see [SECURITY.md](SECURITY.md). Please do not open a public issue
for a vulnerability.

## License

[Apache-2.0](LICENSE)
