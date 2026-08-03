import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiPilotError } from "../errors.js";
import { execute } from "../exec/execute.js";
import { assertProtocolAllowed } from "../policy/policy.js";
import { fromValue, type LoadedSpec, type LoadOptions, parseDocument } from "./document.js";

/**
 * Loading a spec from a URL, which makes indexing an **egress event**.
 *
 * That is the whole reason this is a separate module, imported dynamically by
 * `SpecIndex`: a workspace with only local specs must not pull the HTTP stack in
 * behind `search`. Nothing here runs unless a `specs:` entry is a URL.
 *
 * Three things guard the fetch:
 *
 * 1. **The protocol gate**, the same one every request goes through. http and
 *    https only.
 * 2. **Same-host redirects only.** A `Location` header is attacker-influenceable,
 *    and a configured spec URL authorises that host, not wherever it forwards to.
 * 3. **A byte cap.** Public specs run to megabytes; an endless response must not
 *    be able to fill the disk cache.
 *
 * There is no host allowlist check, and that is deliberate rather than an
 * oversight: a spec URL is written into a committed config file by a human, and
 * the allowlist is per-environment while specs are per-workspace. Gating on it
 * would mean `search` had to resolve an environment — and therefore resolve
 * secrets — before it could read a spec.
 */

/** Stripe's is ~6 MB. Past this a "spec" is something else. */
const MAX_SPEC_BYTES = 16 * 1024 * 1024;

/**
 * ponytail: one fixed TTL, no per-spec configuration and no `--refresh` flag.
 * A spec that changed inside the window is one `rm` away. Add a flag only when
 * someone is actually working against a spec that moves hourly.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function loadRemoteSpec(url: string, options: LoadOptions = {}): Promise<LoadedSpec> {
  const id = options.id ?? url;
  const cache = options.cacheDir === undefined ? undefined : cachePath(options.cacheDir, url);

  const fresh = cache === undefined ? undefined : await readIfFresh(cache);
  if (fresh !== undefined) {
    return fromValue(parseDocument(fresh, url), id);
  }

  let raw: string;
  try {
    raw = await fetchSpec(url);
  } catch (error) {
    // Offline with a stale copy beats offline with nothing: the spec is
    // description, not state, and a day-old description still answers "which
    // endpoint cancels a subscription".
    const stale = cache === undefined ? undefined : await read(cache);
    if (stale === undefined) throw error;
    return fromValue(parseDocument(stale, url), id, [
      `Using a cached copy of ${url}: it could not be refreshed (${reason(error)})`,
    ]);
  }

  const parsed = parseDocument(raw, url);
  if (cache !== undefined) await writeCache(cache, raw);
  return fromValue(parsed, id);
}

async function fetchSpec(url: string): Promise<string> {
  let target: URL;
  try {
    target = new URL(url);
  } catch (error) {
    throw new ApiPilotError("INVALID_REQUEST", `Not a valid spec URL: ${url}`, { cause: error });
  }
  assertProtocolAllowed(target);

  const response = await execute(
    {
      method: "GET",
      url: target.toString(),
      headers: { accept: "application/json, application/yaml, text/yaml, */*;q=0.1" },
      maxResponseBytes: MAX_SPEC_BYTES,
    },
    { allowRedirectTo: (next) => next.hostname === target.hostname },
  );

  if (response.status >= 400) {
    throw new ApiPilotError("NOT_FOUND", `Fetching spec ${url} returned ${response.status}`, {
      hint: "Check the URL is the raw document, not an HTML page about it.",
    });
  }
  if (response.bodyTruncated) {
    throw new ApiPilotError("INVALID_REQUEST", `Spec at ${url} exceeds ${MAX_SPEC_BYTES} bytes`);
  }

  return Buffer.from(response.body).toString("utf8");
}

/**
 * Keyed by a hash of the URL, not by its path: two hosts serving `openapi.json`
 * must not collide, and a URL is not a safe filename.
 */
function cachePath(cacheDir: string, url: string): string {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 32);
  return join(cacheDir, "specs", `${key}.yaml`);
}

async function readIfFresh(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > CACHE_TTL_MS) return undefined;
  } catch {
    return undefined;
  }
  return read(path);
}

async function read(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, raw: string): Promise<void> {
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, raw, "utf8");
  } catch {
    // A cache is an optimisation. Failing to write one must not fail the load.
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
