import { applyAuth } from "../auth/apply.js";
import { ApiPilotError } from "../errors.js";
import { assertRequestAllowed } from "../policy/policy.js";
import type { Redactor } from "../redact/redactor.js";
import type { StoredRequestSummary } from "../store/response-store.js";
import { interpolate } from "../vars/interpolate.js";
import type { ResolvedEnvironment, ResolvedEnvironmentBundle } from "../workspace/workspace.js";
import type { HttpRequest, RequestBody } from "./types.js";

/**
 * Assembles an executable request from an environment and a caller's intent:
 * interpolate, authenticate, then check policy — in that order, because the
 * policy gate must see the final URL, not the template.
 *
 * The returned `request` holds live credentials. `summary` is the redacted
 * twin, and it is the only one of the two that may be stored or shown.
 */

export interface RequestIntent {
  readonly method: string;
  /** Absolute, or relative to the environment's `baseUrl`. May contain `{{vars}}`. */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: RequestBody;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxResponseBytes?: number;
}

export interface PrepareOptions {
  /** Set by the caller when a human has seen and approved this specific call. */
  readonly confirmed?: boolean;
}

export interface PreparedRequest {
  /** Contains resolved secrets. Never digest, store, or log this. */
  readonly request: HttpRequest;
  /** Redacted. This is what goes to the store and to the user. */
  readonly summary: StoredRequestSummary;
  readonly redactor: Redactor;
  readonly environment: ResolvedEnvironment;
}

export function prepareRequest(
  intent: RequestIntent,
  bundle: ResolvedEnvironmentBundle,
  options: PrepareOptions = {},
): PreparedRequest {
  const { environment, redactor } = bundle;
  const method = intent.method.toUpperCase();
  const url = resolveUrl(intent.url, environment);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(intent.headers ?? {})) {
    headers[name] = interpolate(value, environment.variables);
  }

  const base: HttpRequest = {
    method,
    url,
    headers,
    ...(intent.body === undefined
      ? {}
      : { body: interpolateBody(intent.body, environment.variables) }),
    ...(intent.timeoutMs === undefined ? {} : { timeoutMs: intent.timeoutMs }),
    ...(intent.maxRedirects === undefined ? {} : { maxRedirects: intent.maxRedirects }),
    ...(intent.maxResponseBytes === undefined ? {} : { maxResponseBytes: intent.maxResponseBytes }),
  };

  const request = applyAuth(base, environment.auth, redactor);

  // After auth, because an API key in the query string changes the final URL.
  assertRequestAllowed(new URL(request.url), method, environment, {
    confirmed: options.confirmed === true,
  });

  return { request, summary: summarise(request, redactor), redactor, environment };
}

function resolveUrl(template: string, environment: ResolvedEnvironment): string {
  const interpolated = interpolate(template, environment.variables);

  if (/^[a-z][a-z0-9+.-]*:/i.test(interpolated)) return interpolated;

  if (environment.baseUrl === undefined) {
    throw new ApiPilotError(
      "INVALID_REQUEST",
      `"${interpolated}" is relative but environment "${environment.name}" has no baseUrl`,
      { hint: "Set baseUrl on the environment, or pass an absolute URL." },
    );
  }

  try {
    // The trailing slash keeps a baseUrl path prefix from being discarded:
    // without it, `https://x/api` + `users` resolves to `https://x/users`.
    return new URL(
      interpolated.replace(/^\//, ""),
      ensureTrailingSlash(environment.baseUrl),
    ).toString();
  } catch (error) {
    throw new ApiPilotError("INVALID_REQUEST", `Could not resolve "${interpolated}"`, {
      cause: error,
    });
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function interpolateBody(body: RequestBody, variables: ReadonlyMap<string, string>): RequestBody {
  switch (body.kind) {
    case "text":
      return { ...body, content: interpolate(body.content, variables) };
    case "json":
      return { kind: "json", value: interpolateJson(body.value, variables) };
    case "bytes":
      // Binary payloads are opaque; substituting inside them would corrupt them.
      return body;
  }
}

function interpolateJson(value: unknown, variables: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return interpolate(value, variables);
  if (Array.isArray(value)) return value.map((item) => interpolateJson(item, variables));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[interpolate(key, variables)] = interpolateJson(child, variables);
    }
    return out;
  }
  return value;
}

function summarise(request: HttpRequest, redactor: Redactor): StoredRequestSummary {
  return {
    method: request.method,
    url: redactor.redact(request.url),
    headers: Object.entries(request.headers ?? {}).map(([name, value]) => ({
      name,
      value: redactor.redact(value),
    })),
    ...(request.body === undefined ? {} : { bodyBytes: estimateBodyBytes(request.body) }),
  };
}

function estimateBodyBytes(body: RequestBody): number {
  switch (body.kind) {
    case "text":
      return Buffer.byteLength(body.content, "utf8");
    case "json":
      return Buffer.byteLength(JSON.stringify(body.value) ?? "", "utf8");
    case "bytes":
      return body.content.byteLength;
  }
}
