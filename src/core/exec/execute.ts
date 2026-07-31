import { ApiPilotError } from "../errors.js";
import {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  type HttpRequest,
  IDEMPOTENT_METHODS,
  type RequestBody,
  type RetryPolicy,
} from "../request/types.js";

/**
 * The only module in the codebase that performs network I/O, and the only one
 * that ever holds a resolved secret value. Keep it that way.
 *
 * Redirects are followed manually rather than by the platform so that the
 * hop chain is observable, sensitive headers can be stripped on cross-origin
 * hops, and the policy gate has something to inspect (see ADR-0002 fallout).
 */

/** Kept as pairs, not a record, because `set-cookie` legitimately repeats. */
export interface HeaderPair {
  readonly name: string;
  readonly value: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderPair[];
  readonly body: Uint8Array;
  /** True when the body hit `maxResponseBytes` and was cut short. */
  readonly bodyTruncated: boolean;
  /** Final URL after redirects. */
  readonly url: string;
  /** URLs that issued a redirect, in order. Empty for a direct response. */
  readonly redirects: readonly string[];
  /** Method of the final hop — a 303 rewrites POST to GET. */
  readonly method: string;
  readonly durationMs: number;
  /** 1 when the first attempt succeeded. */
  readonly attempts: number;
}

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  /**
   * Vetoes a redirect target before it is followed. A Location header is part
   * of an attacker-influenceable response, so the policy gate gets to see each
   * hop rather than only the URL the caller asked for.
   */
  readonly allowRedirectTo?: (url: URL) => boolean;
}

/** Stripped when a redirect crosses origins, so credentials never follow. */
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export async function execute(
  request: HttpRequest,
  options: ExecuteOptions = {},
): Promise<HttpResponse> {
  const method = request.method.toUpperCase();
  const target = parseUrl(request.url);

  const retry = request.retry ?? DEFAULT_RETRY;
  const maxAttempts = IDEMPOTENT_METHODS.has(method) ? Math.max(1, retry.maxAttempts) : 1;

  const startedAt = performance.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await attemptOnce(request, method, target, options);

      if (attempt < maxAttempts && RETRYABLE_STATUSES.has(result.status)) {
        await sleep(backoffMs(attempt, retry, retryAfterMs(result.headers)), options.signal);
        continue;
      }

      return { ...result, attempts: attempt, durationMs: performance.now() - startedAt };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableError(error)) throw error;
      await sleep(backoffMs(attempt, retry, undefined), options.signal);
    }
  }

  // Only reachable when the final attempt returned a retryable status and the
  // loop fell through, or the last iteration threw and rethrew above.
  throw lastError ?? new ApiPilotError("NETWORK", `Request to ${request.url} failed`);
}

type AttemptResult = Omit<HttpResponse, "attempts" | "durationMs">;

async function attemptOnce(
  request: HttpRequest,
  initialMethod: string,
  target: URL,
  options: ExecuteOptions,
): Promise<AttemptResult> {
  const externalSignal = options.signal;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = request.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const encoded = request.body === undefined ? undefined : encodeBody(request.body);
  let headers = buildHeaders(request.headers, encoded?.contentType);
  let method = initialMethod;
  let body: Uint8Array | undefined = encoded?.data;
  let currentUrl = target;
  const redirects: string[] = [];

  for (let hop = 0; ; hop++) {
    if (hop > maxRedirects) {
      throw new ApiPilotError(
        "TOO_MANY_REDIRECTS",
        `Exceeded ${maxRedirects} redirects starting at ${target.toString()}`,
        { hint: "Raise maxRedirects, or check the server for a redirect loop." },
      );
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw translateFetchError(error, currentUrl, timeoutMs, timeoutSignal, externalSignal);
    }

    const location = response.headers.get("location");
    if (isRedirectStatus(response.status) && location !== null) {
      await response.body?.cancel();

      const next = resolveLocation(location, currentUrl);
      if (options.allowRedirectTo?.(next) === false) {
        throw new ApiPilotError(
          "POLICY_BLOCKED",
          `Refusing to follow a redirect to ${next.hostname}`,
          {
            hint: "The redirect target is not allowed in this environment. Add it to allowedHosts if it is legitimate.",
          },
        );
      }
      if (next.origin !== currentUrl.origin) {
        headers = withoutSensitiveHeaders(headers);
      }
      if (shouldDowngradeToGet(response.status, method)) {
        method = "GET";
        body = undefined;
        headers = withoutBodyHeaders(headers);
      }

      redirects.push(currentUrl.toString());
      currentUrl = next;
      continue;
    }

    let read: { data: Uint8Array; truncated: boolean };
    try {
      read = await readBody(response, maxResponseBytes);
    } catch (error) {
      throw translateFetchError(error, currentUrl, timeoutMs, timeoutSignal, externalSignal);
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: collectHeaders(response.headers),
      body: read.data,
      bodyTruncated: read.truncated,
      url: currentUrl.toString(),
      redirects,
      method,
    };
  }
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ApiPilotError("INVALID_REQUEST", `Not a valid URL: ${raw}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiPilotError("INVALID_REQUEST", `Unsupported protocol: ${url.protocol}`, {
      hint: "Only http: and https: are supported.",
    });
  }
  return url;
}

function resolveLocation(location: string, base: URL): URL {
  let next: URL;
  try {
    next = new URL(location, base);
  } catch (error) {
    throw new ApiPilotError("NETWORK", `Server sent an unparseable Location: ${location}`, {
      cause: error,
    });
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new ApiPilotError(
      "NETWORK",
      `Refusing to follow a redirect to ${next.protocol} (${location})`,
      { hint: "Only http: and https: redirects are followed." },
    );
  }
  return next;
}

export function encodeBody(body: RequestBody): { data: Uint8Array; contentType: string } {
  switch (body.kind) {
    case "text":
      return {
        data: new TextEncoder().encode(body.content),
        contentType: body.contentType ?? "text/plain; charset=utf-8",
      };
    case "json":
      return {
        data: new TextEncoder().encode(JSON.stringify(body.value)),
        contentType: "application/json",
      };
    case "bytes":
      return {
        data: body.content,
        contentType: body.contentType ?? "application/octet-stream",
      };
  }
}

/** Lowercases names so caller headers reliably override the derived content-type. */
function buildHeaders(
  provided: Readonly<Record<string, string>> | undefined,
  contentType: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType !== undefined) headers["content-type"] = contentType;
  for (const [name, value] of Object.entries(provided ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

function withoutSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  for (const name of SENSITIVE_HEADERS) delete next[name];
  return next;
}

function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  delete next["content-type"];
  delete next["content-length"];
  return next;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 303 always becomes GET. 301/302 after a non-GET body method become GET too —
 * that is what every browser and HTTP client does in practice, whatever RFC 7231
 * says about preserving the method.
 */
function shouldDowngradeToGet(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD";
  if (status === 301 || status === 302) return method !== "GET" && method !== "HEAD";
  return false;
}

function collectHeaders(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (const [name, value] of headers) {
    // Iteration folds repeated set-cookie into one comma-joined value, which is
    // lossy and wrong for cookies. getSetCookie() below restores them intact.
    if (name.toLowerCase() === "set-cookie") continue;
    pairs.push({ name, value });
  }
  for (const value of headers.getSetCookie()) {
    pairs.push({ name: "set-cookie", value });
  }
  return pairs;
}

async function readBody(
  response: Response,
  maxBytes: number,
): Promise<{ data: Uint8Array; truncated: boolean }> {
  if (response.body === null) return { data: new Uint8Array(0), truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;

    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
      }
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    total += value.byteLength;
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data, truncated };
}

function translateFetchError(
  error: unknown,
  url: URL,
  timeoutMs: number,
  timeoutSignal: AbortSignal,
  externalSignal: AbortSignal | undefined,
): ApiPilotError {
  if (externalSignal?.aborted === true) {
    return new ApiPilotError("ABORTED", `Request to ${url.toString()} was cancelled`, {
      cause: error,
    });
  }
  if (timeoutSignal.aborted) {
    return new ApiPilotError(
      "TIMEOUT",
      `Request to ${url.toString()} timed out after ${timeoutMs}ms`,
      { cause: error, hint: "Raise timeoutMs if the endpoint is legitimately slow." },
    );
  }
  return new ApiPilotError("NETWORK", `Could not reach ${url.toString()}: ${describe(error)}`, {
    cause: error,
  });
}

/** fetch wraps the useful detail in `cause`; surface it rather than "fetch failed". */
function describe(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) return cause.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ApiPilotError)) return false;
  return error.code === "NETWORK" || error.code === "TIMEOUT";
}

function retryAfterMs(headers: readonly HeaderPair[]): number | undefined {
  const header = headers.find((h) => h.name.toLowerCase() === "retry-after");
  if (header === undefined) return undefined;

  const seconds = Number(header.value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header.value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/** Exponential backoff with full jitter; a server's Retry-After wins outright. */
function backoffMs(attempt: number, retry: RetryPolicy, retryAfter: number | undefined): number {
  if (retryAfter !== undefined) return Math.min(retryAfter, retry.maxDelayMs);
  const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new ApiPilotError("ABORTED", "Request was cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiPilotError("ABORTED", "Request was cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
