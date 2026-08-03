# Spec fixtures

`tests/unit/spec-load.test.ts` loads **every** `*.yaml`, `*.yml` and `*.json` file
in this directory and asserts it parses and indexes without throwing. JSON is
included because that is how most vendors publish Swagger, and a corpus that
skipped those extensions would pass while checking nothing.

That is deliberate: drop a real downloaded spec here and it becomes part of the
corpus with no code change. It is how a large public spec gets validated without
committing megabytes to the repo or letting CI touch the network (NFR N6/N7).

```sh
# Not run in CI — a local check against something real.
curl -sL https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml \
  -o tests/fixtures/specs/local-github.yaml
pnpm test spec-load
rm tests/fixtures/specs/local-github.yaml
```

Anything matching `local-*.yaml`, `local-*.yml` or `local-*.json` is gitignored, so
a scratch download cannot be committed by accident. Use that prefix for anything
from a private API — a spec carries internal hostnames, internal paths, and
sometimes example payloads.

## What the committed fixtures are for

Each one encodes a failure mode real specs actually have, not a happy path:

| File | Exercises |
|---|---|
| `billing.yaml` | A realistic payments API. `allOf` composition, `oneOf`, enums, nullable, shared `components/parameters`, path-level parameters, security schemes, a deprecated operation. Also the search corpus: eight operations mention "subscription", so ranking rather than matching is what is under test. |
| `broken.yaml` | A path item that is a string, a missing `operationId`, duplicate `operationId`s, parameters missing `name` or `in`, a `$ref` to a component that does not exist, and a `$ref` that tries to escape the directory. |
| `circular.yaml` | Self-referential and mutually recursive schemas, plus OpenAPI 3.1 `type: [string, "null"]`. |
| `split-main.yaml` + `split-components.yaml` | `$ref` into a sibling file, for both a parameter and a schema. |
