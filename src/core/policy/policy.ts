import { ApiPilotError } from "../errors.js";

/**
 * Runs before every request, with no bypass flag in the library API. Two
 * controls, both cheap, both aimed at the same failure: an autonomous agent
 * sending a request the human would not have sent.
 */

export type Classification = "safe" | "caution" | "production";

/** Methods that cannot change server state, so they never need confirmation. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export interface PolicyEnvironment {
  readonly name: string;
  readonly classification: Classification;
  /** Hostnames, or `.example.com` / `*.example.com` for a subdomain suffix. */
  readonly allowedHosts: readonly string[];
}

export interface PolicyContext {
  /** The caller passed `confirm: true` for this specific call. */
  readonly confirmed: boolean;
}

export function assertRequestAllowed(
  url: URL,
  method: string,
  environment: PolicyEnvironment,
  context: PolicyContext,
): void {
  assertHostAllowed(url, environment);
  assertMutationConfirmed(method, environment, context);
}

export function assertHostAllowed(url: URL, environment: PolicyEnvironment): void {
  if (environment.allowedHosts.length === 0) {
    throw new ApiPilotError(
      "POLICY_BLOCKED",
      `Environment "${environment.name}" has no allowed hosts, so every request is refused`,
      { hint: "Set `allowedHosts` (or `baseUrl`, which seeds it) for this environment." },
    );
  }

  if (!isHostAllowed(url.hostname, environment.allowedHosts)) {
    throw new ApiPilotError(
      "POLICY_BLOCKED",
      `Host ${url.hostname} is not allowed in environment "${environment.name}"`,
      { hint: `Allowed: ${environment.allowedHosts.join(", ")}.` },
    );
  }
}

function assertMutationConfirmed(
  method: string,
  environment: PolicyEnvironment,
  context: PolicyContext,
): void {
  if (environment.classification !== "production") return;
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return;
  if (context.confirmed) return;

  throw new ApiPilotError(
    "CONFIRMATION_REQUIRED",
    `${method.toUpperCase()} against environment "${environment.name}" is classified production`,
    {
      hint: "Re-issue the same call with confirm: true once a human has seen it.",
    },
  );
}

/**
 * Exact hostname match, or a subdomain suffix when the entry starts with a dot
 * or `*.`. Deliberately not a general glob: `api*.example.com` also matches
 * `api.evil-example.com` to a careless reader, and this is a security control.
 */
export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();

  return allowedHosts.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    if (allowed === "") return false;

    if (allowed.startsWith("*.") || allowed.startsWith(".")) {
      const suffix = allowed.startsWith("*.") ? allowed.slice(1) : allowed;
      // `.example.com` covers `api.example.com` and bare `example.com`.
      return host.endsWith(suffix) || host === suffix.slice(1);
    }

    return host === allowed;
  });
}

/**
 * Redirect predicate for the executor. A response body is attacker-influenced
 * input; a Location header is part of that body's blast radius, so a redirect
 * gets exactly the same host check the original request did.
 */
export function redirectGuard(environment: PolicyEnvironment): (url: URL) => boolean {
  return (url) => isHostAllowed(url.hostname, environment.allowedHosts);
}
