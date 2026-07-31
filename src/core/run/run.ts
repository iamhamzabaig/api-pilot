import { type Digest, digest } from "../digest/digest.js";
import { ApiPilotError } from "../errors.js";
import { execute } from "../exec/execute.js";
import { redirectGuard } from "../policy/policy.js";
import { redactError } from "../redact/redactor.js";
import { prepareRequest, type RequestIntent } from "../request/prepare.js";
import { ResponseStore, type StoredResponseMeta } from "../store/response-store.js";
import type { Workspace } from "../workspace/workspace.js";

/**
 * One request, end to end: resolve the environment, prepare, execute, store,
 * digest. Both the CLI's `call` and its `replay` land here, and so will the
 * MCP server's `api_call` — a second implementation of this sequence is how
 * the redaction and policy guarantees would drift apart.
 *
 * Nothing here returns the live request. The caller gets the redacted summary
 * and a handle; the bytes stay in the store until inspect asks for a slice.
 */

export interface RunOptions {
  /** Defaults to the workspace's default environment. */
  readonly environment?: string;
  /** Set once a human has seen and approved this specific call. */
  readonly confirmed?: boolean;
  readonly digestMaxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly meta: StoredResponseMeta;
  readonly digest: Digest;
  readonly environmentName: string;
}

export async function runRequest(
  intent: RequestIntent,
  workspace: Workspace,
  options: RunOptions = {},
): Promise<RunResult> {
  const bundle = await workspace.resolveEnvironment(options.environment);
  const prepared = prepareRequest(intent, bundle, { confirmed: options.confirmed === true });

  let response: Awaited<ReturnType<typeof execute>>;
  try {
    response = await execute(prepared.request, {
      allowRedirectTo: redirectGuard(bundle.environment),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    // The executor is the one place holding live credentials, so anything it
    // throws is assumed to have them in its message, URL, or stack.
    throw redactError(error, prepared.redactor);
  }

  const store = new ResponseStore(workspace.cacheDir);
  const meta = await store.put(response, prepared.summary, {
    redactor: prepared.redactor,
    intent,
  });

  return {
    meta,
    digest: digest(response, {
      handle: meta.handle,
      redactor: prepared.redactor,
      ...(options.digestMaxBytes === undefined ? {} : { maxBytes: options.digestMaxBytes }),
    }),
    environmentName: bundle.environment.name,
  };
}

/**
 * Re-runs a recorded call. The stored intent is the pre-interpolation template,
 * so replaying against a different environment resolves that environment's
 * variables and credentials — which is the point, not an edge case.
 */
export async function replayRun(
  handle: string,
  workspace: Workspace,
  options: RunOptions = {},
): Promise<RunResult> {
  const store = new ResponseStore(workspace.cacheDir);
  const meta = await store.get(handle);

  if (meta.intent === undefined) {
    throw new ApiPilotError("NOT_FOUND", `Run ${handle} has no recorded intent to replay`, {
      hint: "Only runs recorded by this version carry one. Issue the call again directly.",
    });
  }

  if (meta.intent.bodyOmitted === true) {
    throw new ApiPilotError(
      "INVALID_REQUEST",
      `Run ${handle} sent a binary body, which is not kept`,
      {
        hint: "Re-issue the call with the original payload instead of replaying it.",
      },
    );
  }

  return runRequest(meta.intent, workspace, options);
}
