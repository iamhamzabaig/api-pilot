import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiPilotError } from "../errors.js";
import type { HeaderPair, HttpResponse } from "../exec/execute.js";
import type { Redactor } from "../redact/redactor.js";

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
}

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

/** Time-prefixed so a lexical sort is a chronological sort. */
function newHandle(): string {
  return `r_${Date.now().toString(36)}${randomBytes(4).toString("hex").slice(0, 5)}`;
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
