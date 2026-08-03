import type { Redactor } from "../redact/redactor.js";
import { ResponseStore } from "../store/response-store.js";
import type { Workspace } from "../workspace/workspace.js";
import { type InspectOptions, type InspectResult, inspect } from "./inspect.js";

/**
 * Inspecting a *stored* run, under the redactor that run was made with.
 *
 * `inspect()` takes a redactor and knows nothing about where responses live.
 * This is the half that knows — and it exists because both adapters had the same
 * five lines (find the record, read the body, render it) and neither of them
 * seeded a redactor. That was the one remaining hole in the "nothing leaves the
 * process unredacted" invariant: a credential a service echoes into its own
 * response body is scrubbed from the digest, which is built while the
 * environment is still resolved, and was not scrubbed from a later inspect.
 *
 * The metadata record now names its environment, so the redactor can be rebuilt.
 * Two cases cannot rebuild it: a record written before that field existed, and
 * an environment whose secrets no longer resolve — rotated key, unset variable,
 * deleted environment. Refusing there would mean losing access to stored
 * responses because a shell variable is missing, so the slice is returned
 * unredacted and says so. An adapter that drops `redacted: false` on the floor
 * is reopening the hole.
 */

export interface InspectRunResult extends InspectResult {
  readonly handle: string;
  /** False when no redactor could be rebuilt — see `redactionWarning`. */
  readonly redacted: boolean;
  /** Why not. Present only when `redacted` is false. */
  readonly redactionWarning?: string;
}

/** `inspect()`'s options minus the redactor, which is derived from the record. */
export type InspectRunOptions = Omit<InspectOptions, "redactor">;

export async function inspectRun(
  handle: string,
  workspace: Workspace,
  options: InspectRunOptions = {},
): Promise<InspectRunResult> {
  const store = new ResponseStore(workspace.cacheDir);
  const meta = await store.get(handle);
  const body = await store.readBody(handle);

  const seeded = await redactorFor(workspace, meta.environment);
  const result = inspect(
    { headers: meta.headers, body },
    { ...options, ...(seeded.redactor === undefined ? {} : { redactor: seeded.redactor }) },
  );

  return {
    ...result,
    handle,
    redacted: seeded.redactor !== undefined,
    ...(seeded.warning === undefined ? {} : { redactionWarning: seeded.warning }),
  };
}

const UNREDACTED =
  "Output is not redacted: a credential this API echoed into its own response body would appear verbatim.";

/**
 * Re-resolving the environment resolves *today's* secrets. A value rotated since
 * the run will not be caught, which is the correct trade: the alternative is
 * storing the resolved secrets next to the response so they can be matched
 * later, and that file would be the leak.
 */
async function redactorFor(
  workspace: Workspace,
  environmentName: string | undefined,
): Promise<{ redactor?: Redactor; warning?: string }> {
  if (environmentName === undefined) {
    return { warning: `This run does not record which environment it used. ${UNREDACTED}` };
  }

  try {
    const { redactor } = await workspace.resolveEnvironment(environmentName);
    return { redactor };
  } catch (error) {
    // Resolver failures name the reference, never the value it could not read.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      warning: `Environment "${environmentName}" no longer resolves (${reason}). ${UNREDACTED}`,
    };
  }
}
