import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ApiPilotError } from "../errors.js";

/**
 * Loads an OpenAPI document and resolves `$ref` **lazily**.
 *
 * The usual approach is to dereference the whole document up front with a
 * library. We deliberately do not: a large public spec is megabytes, we only
 * ever render the handful of operations someone asked about, and a fully
 * dereferenced document is a cyclic object graph that every consumer then has
 * to defend against.
 *
 * Instead a `$ref` stays a pointer and is followed on demand, with a visited
 * set. That also produces better output — a self-referential schema renders as
 * the component's name rather than being expanded until a depth cap bites.
 */

export type JsonValue = unknown;

export interface LoadedSpec {
  /** Stable identifier used to attribute operations and warnings. */
  readonly id: string;
  readonly root: JsonValue;
  readonly sourcePath: string;
  readonly warnings: readonly string[];
  /** Resolves a `$ref` string against this document (and its sibling files). */
  resolveRef(ref: string): RefTarget | undefined;
}

export interface RefTarget {
  readonly value: JsonValue;
  /** Last path segment of the pointer — `Pet` for `#/components/schemas/Pet`. */
  readonly name: string;
}

export interface LoadOptions {
  readonly id?: string;
  /**
   * Refs may not escape this directory. A spec is user-supplied data, and
   * `$ref: ../../../../etc/passwd` is otherwise a file read primitive.
   */
  readonly refRoot?: string;
}

export async function loadSpec(path: string, options: LoadOptions = {}): Promise<LoadedSpec> {
  const sourcePath = resolve(path);
  const refRoot = resolve(options.refRoot ?? dirname(sourcePath));
  const warnings: string[] = [];

  const root = await readDocument(sourcePath);
  const externals = new Map<string, JsonValue>();

  const resolveRef = (ref: string): RefTarget | undefined => {
    const [filePart = "", pointer = ""] = splitRef(ref);

    let document: JsonValue;
    if (filePart === "") {
      document = root;
    } else {
      const external = externals.get(filePart);
      if (external === undefined) {
        // Loading is async but resolution must be synchronous for the renderer,
        // so external files are pre-loaded in `prefetchExternalRefs` below.
        warnings.push(`Unresolved external $ref "${ref}" (file not preloaded)`);
        return undefined;
      }
      document = external;
    }

    const value = followPointer(document, pointer);
    if (value === undefined) {
      warnings.push(`Unresolved $ref "${ref}"`);
      return undefined;
    }
    return { value, name: pointerName(pointer, filePart) };
  };

  await prefetchExternalRefs(root, sourcePath, refRoot, externals, warnings);

  return {
    id: options.id ?? sourcePath,
    root,
    sourcePath,
    warnings,
    resolveRef,
  };
}

/** Parses an already-in-memory document, for tests and for future URL loading. */
export function fromValue(value: JsonValue, id: string): LoadedSpec {
  const warnings: string[] = [];
  return {
    id,
    root: value,
    sourcePath: id,
    warnings,
    resolveRef(ref) {
      const [filePart = "", pointer = ""] = splitRef(ref);
      if (filePart !== "") {
        warnings.push(`External $ref "${ref}" is not available for in-memory documents`);
        return undefined;
      }
      const target = followPointer(value, pointer);
      if (target === undefined) {
        warnings.push(`Unresolved $ref "${ref}"`);
        return undefined;
      }
      return { value: target, name: pointerName(pointer, filePart) };
    },
  };
}

async function readDocument(path: string): Promise<JsonValue> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ApiPilotError("NOT_FOUND", `Could not read spec ${path}`, { cause: error });
  }

  try {
    // The `yaml` parser accepts JSON, so one code path covers both formats.
    return parseYaml(raw);
  } catch (error) {
    throw new ApiPilotError("CONFIG_INVALID", `${path} is not valid YAML or JSON`, {
      cause: error,
    });
  }
}

/**
 * Walks the document collecting external `$ref` files and loads them, so the
 * synchronous resolver above always has what it needs.
 */
async function prefetchExternalRefs(
  root: JsonValue,
  sourcePath: string,
  refRoot: string,
  into: Map<string, JsonValue>,
  warnings: string[],
): Promise<void> {
  const pending = new Set<string>();
  collectExternalRefs(root, pending, 0);

  for (const filePart of pending) {
    const target = resolve(dirname(sourcePath), filePart);

    const relativeToRoot = relative(refRoot, target);
    if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
      warnings.push(`Refusing external $ref "${filePart}": it escapes the spec directory`);
      continue;
    }

    try {
      into.set(filePart, await readDocument(target));
    } catch {
      warnings.push(`Could not load external $ref file "${filePart}"`);
    }
  }
}

const MAX_SCAN_DEPTH = 64;

function collectExternalRefs(node: JsonValue, into: Set<string>, depth: number): void {
  if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) collectExternalRefs(item, into, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref === "string") {
    const [filePart = ""] = splitRef(ref);
    // Remote URLs are out of scope: fetching them would make loading a spec an
    // egress event, which needs the policy gate wired in first.
    if (filePart !== "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(filePart)) into.add(filePart);
  }

  for (const value of Object.values(record)) collectExternalRefs(value, into, depth + 1);
}

function splitRef(ref: string): [string, string] {
  const hash = ref.indexOf("#");
  if (hash === -1) return [ref, ""];
  return [ref.slice(0, hash), ref.slice(hash + 1)];
}

function followPointer(document: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "" || pointer === "/") return document;

  let current: JsonValue = document;
  for (const rawSegment of pointer.replace(/^\//, "").split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

function pointerName(pointer: string, filePart: string): string {
  const segments = pointer.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? filePart ?? "unknown";
}
