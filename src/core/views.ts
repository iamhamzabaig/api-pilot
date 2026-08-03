import type { RunResult } from "./run/run.js";
import type { OperationRecord } from "./spec/operations.js";
import type { SearchHit } from "./spec/search.js";
import type { StoredResponseMeta } from "./store/response-store.js";
import type { ResolvedEnvironmentBundle, Workspace } from "./workspace/workspace.js";

/**
 * The machine-readable projections, shared by both adapters.
 *
 * These started as two hand-maintained copies — one behind `--json`, one in the
 * MCP tool results — and they were identical, which is the tell. A field added
 * to one and forgotten in the other is a silent divergence between what a
 * scripted user sees and what a model sees, and nothing would have failed.
 *
 * Types only at the top of this file: it is on the CLI's lazy-load path and
 * must not pull runtime code in behind it.
 */

/** What one call produced, minus the digest — adapters place that themselves. */
export function runView(result: RunResult) {
  return {
    handle: result.meta.handle,
    environment: result.environmentName,
    status: result.meta.status,
    statusText: result.meta.statusText,
    method: result.meta.request.method,
    url: result.meta.request.url,
    durationMs: result.meta.durationMs,
    attempts: result.meta.attempts,
    bodyBytes: result.meta.bodyBytes,
    bodyTruncated: result.meta.bodyTruncated,
    redirects: result.meta.redirects,
  };
}

export function historyView(runs: readonly StoredResponseMeta[]) {
  return runs.map((run) => ({
    handle: run.handle,
    createdAt: run.createdAt,
    method: run.request.method,
    url: run.request.url,
    status: run.status,
    durationMs: run.durationMs,
    bodyBytes: run.bodyBytes,
    // A run recorded before replay existed, or one that sent a binary body,
    // cannot be re-issued. Saying so up front beats an error later.
    replayable: run.intent !== undefined && run.intent.bodyOmitted !== true,
  }));
}

export function searchView(query: string, total: number, hits: readonly SearchHit[]) {
  return {
    query,
    total,
    hits: hits.map((hit) => ({ ...operationView(hit.operation), score: hit.score })),
  };
}

export function operationView(operation: OperationRecord) {
  return {
    id: operation.id,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    deprecated: operation.deprecated,
    specId: operation.specId,
  };
}

export function workspaceView(workspace: Workspace) {
  return {
    root: workspace.root,
    default: workspace.defaultEnvironmentName,
    environments: workspace.environmentNames,
    specs: workspace.specPaths,
    warnings: workspace.warnings,
  };
}

/**
 * Variables are masked twice over: by name, which covers a secret's own value,
 * and through the redactor, which covers a plain variable built out of one.
 */
export function environmentView({ environment, redactor }: ResolvedEnvironmentBundle) {
  const secrets = new Set(environment.secretNames);
  return {
    name: environment.name,
    classification: environment.classification,
    baseUrl: environment.baseUrl,
    allowedHosts: environment.allowedHosts,
    auth: environment.auth === undefined ? null : { type: environment.auth.type },
    variables: [...environment.variables].map(([name, value]) => ({
      name,
      value: secrets.has(name) ? "[redacted]" : redactor.redact(value),
      secret: secrets.has(name),
    })),
  };
}
