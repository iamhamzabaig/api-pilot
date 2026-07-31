/**
 * The single choke point every string passes through on its way out of the
 * process. A leaked credential is the worst bug this project can have, so the
 * defence is one small class that everything funnels into rather than
 * discipline spread across a dozen call sites.
 *
 * Seeded with the secret values resolved for the current run. It redacts the
 * raw value *and* the encodings that value predictably takes on the wire —
 * a token that is safe in the header but leaks base64-encoded in a Basic auth
 * blob has not been protected.
 */

export const REDACTED = "[redacted]";

/**
 * Below this, a "secret" is more likely to be a common substring than a
 * credential, and redacting it would mangle unrelated output.
 */
const MIN_SECRET_LENGTH = 4;

export class Redactor {
  /** Longest-first, so an overlapping shorter secret cannot leave a tail behind. */
  #patterns: string[] = [];
  readonly #seen = new Set<string>();

  /** Registers a secret and the forms it predictably takes on the wire. */
  add(secret: string): void {
    for (const form of derivedForms(secret)) {
      if (form.length < MIN_SECRET_LENGTH || this.#seen.has(form)) continue;
      this.#seen.add(form);
      this.#patterns.push(form);
    }
    this.#patterns.sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.#patterns.length;
  }

  redact(text: string): string {
    let out = text;
    for (const pattern of this.#patterns) {
      out = out.split(pattern).join(REDACTED);
    }
    return out;
  }

  /**
   * Walks a JSON-shaped value, redacting every string in it — keys included,
   * because a secret used as an object key leaks just as completely.
   */
  redactDeep<T>(value: T): T {
    return this.#walk(value) as T;
  }

  #walk(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.#walk(item));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[this.redact(key)] = this.#walk(child);
      }
      return out;
    }
    return value;
  }
}

function derivedForms(secret: string): string[] {
  if (secret === "") return [];
  const forms = [secret];

  // Basic auth and similar schemes ship credentials base64-encoded.
  try {
    forms.push(Buffer.from(secret, "utf8").toString("base64"));
  } catch {
    // Unencodable input is not a secret we can meaningfully derive from.
  }

  // Query-string placement percent-encodes anything non-alphanumeric.
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) forms.push(encoded);

  return forms;
}

/**
 * Redacts a thrown value's message without discarding its type. Errors are a
 * common leak path: an HTTP client that echoes the failing URL will echo an
 * API key sitting in the query string along with it.
 */
export function redactError(error: unknown, redactor: Redactor): unknown {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? redactor.redact(error) : error;
  }
  error.message = redactor.redact(error.message);
  if (error.stack !== undefined) error.stack = redactor.redact(error.stack);
  if (error.cause !== undefined) redactError(error.cause, redactor);
  return error;
}
