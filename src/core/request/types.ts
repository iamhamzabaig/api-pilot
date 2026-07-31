/**
 * The normalized request record. Everything upstream — a `.http` file, an
 * OpenAPI operation plus params, a raw CLI invocation — funnels into this
 * shape before execution, and this shape is what history serializes.
 */

/**
 * Bodies are held in memory and must survive serialization for replay.
 * Streaming uploads are deliberately absent until a real use case lands.
 */
export type RequestBody =
  | { readonly kind: "text"; readonly content: string; readonly contentType?: string }
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "bytes"; readonly content: Uint8Array; readonly contentType?: string };

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  /** Header names are matched case-insensitively; later duplicates win. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: RequestBody;
  /** Per-attempt, not per-call: a retried request gets a fresh budget. */
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Body bytes beyond this are dropped and the response is flagged truncated. */
  readonly maxResponseBytes?: number;
  readonly retry?: RetryPolicy;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Guards against a runaway download exhausting memory. The context window is
 * protected separately by the digest budget — this cap is only about the process.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

/**
 * Only these get retried. Replaying a POST can double-charge a customer, so a
 * non-idempotent request is executed exactly once regardless of retry policy.
 */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);
