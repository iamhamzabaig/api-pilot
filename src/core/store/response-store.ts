import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiPilotError } from "../errors.js";
import type { HeaderPair, HttpResponse } from "../exec/execute.js";
import type { Redactor } from "../redact/redactor.js";
import type { RequestIntent } from "../request/prepare.js";
import type { RequestBody } from "../request/types.js";

/**
 * Persists full responses so the model never has to hold one. `api_call`
 * returns a handle plus a digest; the full bytes stay here until `api_inspect`
 * asks for a bounded slice of them.
 *
 * Layout:
 *   <root>/objects/<ab>/<sha256>   raw body bytes, deduplicated by content
 *   <root>/meta/<handle>.json      one record per run, pointing at a body
 *
 * Bodies are content-addressed so that polling the same endpoint a hundred
 * times costs one copy. Handles are separate and unique per run, because two
 * identical responses are still two distinct events in history.
 */

export interface PutOptions {
  /**
   * Scrubs the metadata record before it is written. The final URL and the
   * redirect chain come off the wire with credentials still in the query
   * string, so a run against a key-in-query API would otherwise leave the key
   * sitting in a file we created.
   *
   * Response *bodies* are stored verbatim on purpose: the store is the vault,
   * and inspect needs the real bytes. It is local and gitignored.
   */
  readonly redactor?: Pick<Redactor, "redactDeep">;

  /**
   * The caller's pre-interpolation intent, kept so the run can be replayed.
   *
   * This is the template — `{{vars}}` and `${env:...}` references, not their
   * values — which is what makes replay against a *different* environment the
   * natural operation rather than a special case. It still passes through the
   * redactor with the rest of the record, because a caller is free to hardcode
   * a credential instead of referencing one.
   */
  readonly intent?: RequestIntent;

  /**
   * The environment this run was made under, by name.
   *
   * Recorded so a later `inspect` can rebuild that environment's redactor. A
   * stored body is verbatim, and a service that echoes your credential back into
   * its own response body puts it in there; without this field there is nothing
   * to seed a redactor from once the run is over.
   */
  readonly environment?: string;
}

/**
 * A binary body is a file upload: too large to belong in a run log, and it does
 * not survive JSON. It is dropped, and replay reports that rather than silently
 * re-sending a different request.
 */
export type StoredRequestBody = Exclude<RequestBody, { kind: "bytes" }>;

export type StoredRequestIntent = Omit<RequestIntent, "body"> & {
  readonly body?: StoredRequestBody;
  /** True when a binary body was dropped on the way in. */
  readonly bodyOmitted?: true;
};

/** What was sent. Callers must pass redacted values — this module does not redact. */
export interface StoredRequestSummary {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderPair[];
  readonly bodyBytes?: number;
}

export interface StoredResponseMeta {
  readonly handle: string;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly request: StoredRequestSummary;
  /** Absent on runs recorded before replay existed, and on runs put without one. */
  readonly intent?: StoredRequestIntent;
  /** Absent on runs recorded before inspect re-seeded a redactor. See `PutOptions`. */
  readonly environment?: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderPair[];
  readonly url: string;
  readonly redirects: readonly string[];
  readonly method: string;
  readonly durationMs: number;
  readonly attempts: number;
  readonly bodyTruncated: boolean;
  readonly bodySha256: string;
  readonly bodyBytes: number;
}

/**
 * Handles appear in tool results and get echoed back by a model, so they are
 * validated on the way in. This regex is the only thing standing between a
 * hallucinated handle and a path traversal.
 */
const HANDLE_PATTERN = /^r_[0-9a-z]{8,32}$/;

export const DEFAULT_HISTORY_LIMIT = 20;

/** Filters for the run log. Everything is optional; all given filters must match. */
export interface HistoryQuery {
  readonly limit?: number;
  readonly method?: string;
  readonly status?: number;
  /** Substring match against the redacted request URL. */
  readonly urlContains?: string;
}

function matches(meta: StoredResponseMeta, query: HistoryQuery): boolean {
  if (query.method !== undefined && meta.request.method !== query.method.toUpperCase())
    return false;
  if (query.status !== undefined && meta.status !== query.status) return false;
  if (query.urlContains !== undefined && !meta.request.url.includes(query.urlContains))
    return false;
  return true;
}

export class ResponseStore {
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = rootDir;
  }

  async put(
    response: HttpResponse,
    request: StoredRequestSummary,
    options: PutOptions = {},
  ): Promise<StoredResponseMeta> {
    const handle = newHandle();
    const bodySha256 = createHash("sha256").update(response.body).digest("hex");

    const raw: StoredResponseMeta = {
      handle,
      createdAt: new Date().toISOString(),
      request,
      ...(options.intent === undefined ? {} : { intent: toStoredIntent(options.intent) }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      url: response.url,
      redirects: response.redirects,
      method: response.method,
      durationMs: response.durationMs,
      attempts: response.attempts,
      bodyTruncated: response.bodyTruncated,
      bodySha256,
      bodyBytes: response.body.byteLength,
    };

    const meta = options.redactor === undefined ? raw : options.redactor.redactDeep(raw);

    await this.#writeObject(bodySha256, response.body);
    await this.#writeMeta(meta);
    return meta;
  }

  async get(handle: string): Promise<StoredResponseMeta> {
    const path = this.#metaPath(handle);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        throw new ApiPilotError("NOT_FOUND", `No stored response for handle ${handle}`, {
          hint: "Handles are per-run. Use history to list the ones that still exist.",
        });
      }
      throw new ApiPilotError("STORE_IO", `Could not read response ${handle}`, { cause: error });
    }

    try {
      return JSON.parse(raw) as StoredResponseMeta;
    } catch (error) {
      throw new ApiPilotError("STORE_IO", `Stored response ${handle} is corrupt`, { cause: error });
    }
  }

  /**
   * The run log. There is no separate history store: a run *is* a metadata
   * record, and this module already owns that layout.
   *
   * Handles are time-prefixed base36, so sorting the filenames descending is a
   * reverse-chronological sort — which means a limited query reads only the
   * records it returns instead of the whole store.
   */
  async list(query: HistoryQuery = {}): Promise<readonly StoredResponseMeta[]> {
    const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
    if (limit <= 0) return [];

    let names: string[];
    try {
      names = await readdir(join(this.#root, "meta"));
    } catch (error) {
      // No cache directory yet is an empty history, not a failure.
      if (isNotFound(error)) return [];
      throw new ApiPilotError("STORE_IO", "Could not read the run log", { cause: error });
    }

    const handles = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((handle) => HANDLE_PATTERN.test(handle))
      .sort()
      .reverse();

    const out: StoredResponseMeta[] = [];
    for (const handle of handles) {
      if (out.length >= limit) break;
      // ponytail: a corrupt or half-written record is skipped rather than
      // reported, so one bad file cannot break `history` entirely. Surface a
      // warnings channel here if silent skipping ever hides a real problem.
      let meta: StoredResponseMeta;
      try {
        meta = await this.get(handle);
      } catch {
        continue;
      }
      if (matches(meta, query)) out.push(meta);
    }
    return out;
  }

  async readBody(handle: string): Promise<Uint8Array> {
    const meta = await this.get(handle);
    try {
      return await readFile(this.#objectPath(meta.bodySha256));
    } catch (error) {
      if (isNotFound(error)) {
        throw new ApiPilotError(
          "NOT_FOUND",
          `Body for handle ${handle} is missing from the store`,
          {
            hint: "The store may have been garbage-collected or partially deleted.",
          },
        );
      }
      throw new ApiPilotError("STORE_IO", `Could not read body for ${handle}`, { cause: error });
    }
  }

  async #writeObject(sha256: string, body: Uint8Array): Promise<void> {
    const path = this.#objectPath(sha256);
    try {
      await mkdir(join(this.#root, "objects", sha256.slice(0, 2)), { recursive: true });
      // "wx" makes the dedupe a no-op instead of rewriting bytes we already have.
      await writeFile(path, body, { flag: "wx" });
    } catch (error) {
      if (isAlreadyExists(error)) return;
      throw new ApiPilotError("STORE_IO", "Could not write response body to the store", {
        cause: error,
      });
    }
  }

  async #writeMeta(meta: StoredResponseMeta): Promise<void> {
    try {
      await mkdir(join(this.#root, "meta"), { recursive: true });
      await writeFile(this.#metaPath(meta.handle), JSON.stringify(meta, null, 2), "utf8");
    } catch (error) {
      throw new ApiPilotError("STORE_IO", "Could not write response metadata to the store", {
        cause: error,
      });
    }
  }

  #metaPath(handle: string): string {
    if (!HANDLE_PATTERN.test(handle)) {
      throw new ApiPilotError("INVALID_REQUEST", `Not a valid response handle: ${handle}`, {
        hint: "Handles look like r_m8x2k9qp and come from a previous call.",
      });
    }
    return join(this.#root, "meta", `${handle}.json`);
  }

  #objectPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ApiPilotError("STORE_IO", `Not a valid object hash: ${sha256}`);
    }
    return join(this.#root, "objects", sha256.slice(0, 2), sha256);
  }
}

function toStoredIntent(intent: RequestIntent): StoredRequestIntent {
  if (intent.body?.kind !== "bytes") return intent as StoredRequestIntent;
  const { body: _dropped, ...rest } = intent;
  return { ...rest, bodyOmitted: true };
}

/**
 * The last stamp handed out, so a burst inside one millisecond still sorts in
 * issue order. `Date.now()` alone is not enough: two runs in the same
 * millisecond share a prefix, and the random tail then orders them at random —
 * which `list()` reports as history out of order.
 */
let lastStamp = 0;

/**
 * Time-prefixed so a lexical sort is a chronological sort. Base36 keeps the
 * stamp eight characters wide until the year 5138, and equal width is what makes
 * the lexical sort chronological.
 *
 * ponytail: the counter is per-process, so two processes writing to one store in
 * the same millisecond still tie and fall back to the random tail. Those runs are
 * concurrent, and ordering them would need a real clock in the record rather than
 * in the name.
 */
function newHandle(): string {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return `r_${lastStamp.toString(36)}${randomBytes(4).toString("hex").slice(0, 5)}`;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}
