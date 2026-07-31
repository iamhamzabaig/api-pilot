/**
 * Every failure API Pilot raises carries a stable machine-readable `code`.
 * Adapters render `message` + `hint`; agents and scripts branch on `code`.
 *
 * One class with a code discriminant, not a subclass per failure — callers
 * switch on the code, and a hierarchy would buy nothing over that.
 */
export type ErrorCode =
  /** The request could not be built or was structurally invalid. */
  | "INVALID_REQUEST"
  /** DNS, TCP, or TLS failure — the request never got an HTTP response. */
  | "NETWORK"
  /** Exceeded the per-attempt timeout. */
  | "TIMEOUT"
  /** The caller's AbortSignal fired. */
  | "ABORTED"
  /** Redirect chain exceeded `maxRedirects`. */
  | "TOO_MANY_REDIRECTS"
  /** Refused by the policy gate — host allowlist, protocol, or similar. */
  | "POLICY_BLOCKED"
  /** A mutating call against a production environment needs `confirm: true`. */
  | "CONFIRMATION_REQUIRED"
  /** The workspace, an environment, or a secret reference is misconfigured. */
  | "CONFIG_INVALID"
  /** A secret reference could not be resolved (missing env var, missing file). */
  | "SECRET_UNRESOLVED"
  /** Reading or writing the local response store failed. */
  | "STORE_IO"
  /** A handle or record does not exist. */
  | "NOT_FOUND";

export interface ApiPilotErrorOptions {
  /** Actionable next step for a human. Never include secret values. */
  readonly hint?: string;
  readonly cause?: unknown;
}

export class ApiPilotError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: ApiPilotErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ApiPilotError";
    this.code = code;
    this.hint = options.hint;
  }
}

export function isApiPilotError(value: unknown): value is ApiPilotError {
  return value instanceof ApiPilotError;
}
