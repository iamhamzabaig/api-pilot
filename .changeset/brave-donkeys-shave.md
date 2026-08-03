---
"@hamzu/api-pilot": minor
---

**Production mutations can no longer be confirmed over MCP.** The `confirm`
argument is gone from `api_call` and `api_history`, and the MCP adapter never
reports a call as confirmed. A `POST`/`PUT`/`PATCH`/`DELETE` against an
environment classified `production` now fails with `CONFIRMATION_REQUIRED` no
matter what the caller sends.

The gate previously accepted `confirm: true` from the caller, on the assumption
that the host would show a human that argument before running the tool. Testing
against a real host disproved it: asked to delete a record in `prod`, and never
told to confirm anything, the model set the flag itself on its first attempt.
A model confirming on the user's behalf is not confirmation, and against a host
that auto-approves tool calls it left nothing in the way.

Run production writes from the CLI, where `--confirm` is typed by a person:

```sh
api-pilot run DELETE /widgets/wgt_1 --env prod --confirm
```

The `CONFIRMATION_REQUIRED` hint changed with it. It used to read "Re-issue the
same call with confirm: true", which to a model is instructions for getting past
the gate rather than a reason to stop; it now names the CLI command a person has
to run.
