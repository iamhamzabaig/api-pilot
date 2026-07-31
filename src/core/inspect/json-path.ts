import { ApiPilotError } from "../errors.js";

/**
 * A deliberately small JSONPath subset.
 *
 * Full JSONPath includes filter expressions (`$[?(@.price < 10)]`), which most
 * implementations evaluate as JavaScript. Handing that to a model driving
 * queries against attacker-influenceable response bodies is an eval surface we
 * refuse to open. The subset below covers navigation, which is all an agent
 * drilling into a stored response actually needs, and is small enough that
 * not taking a dependency is the cheaper option.
 *
 * Supported:
 *   $                 root
 *   .name  ['name']   object key
 *   [0]  [-1]         array index, negative counts from the end
 *   [*]  .*           every element of an array or value of an object
 *   [1:5]  [2:]       array slice, end-exclusive
 *   ..name            recursive descent to every `name` at any depth
 *
 * Not supported, on purpose: filters, script expressions, unions (`[0,2]`).
 */

export type PathSegment =
  | { readonly kind: "key"; readonly name: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "wildcard" }
  | { readonly kind: "slice"; readonly start: number | undefined; readonly end: number | undefined }
  | { readonly kind: "descend"; readonly name: string };

export function parsePath(expression: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;

  const fail = (reason: string): never => {
    throw new ApiPilotError("INVALID_REQUEST", `Invalid path "${expression}": ${reason}`, {
      hint: "Supported: $.a.b, [0], [-1], [*], [1:5], ..name. Filters are not supported.",
    });
  };

  if (expression.startsWith("$")) i = 1;

  while (i < expression.length) {
    const char = expression[i];

    if (char === ".") {
      if (expression[i + 1] === ".") {
        i += 2;
        const name = readName(expression, i);
        if (name.length === 0) fail("`..` must be followed by a key name");
        segments.push({ kind: "descend", name });
        i += name.length;
        continue;
      }
      i += 1;
      if (expression[i] === "*") {
        segments.push({ kind: "wildcard" });
        i += 1;
        continue;
      }
      const name = readName(expression, i);
      if (name.length === 0) fail("`.` must be followed by a key name");
      segments.push({ kind: "key", name });
      i += name.length;
      continue;
    }

    if (char === "[") {
      const close = expression.indexOf("]", i);
      if (close === -1) fail("unclosed `[`");
      segments.push(parseBracket(expression.slice(i + 1, close), fail));
      i = close + 1;
      continue;
    }

    // Allow a leading bare key: `data.items` behaves like `$.data.items`.
    if (segments.length === 0 && i === 0) {
      const name = readName(expression, i);
      if (name.length === 0) fail(`unexpected character "${char}"`);
      segments.push({ kind: "key", name });
      i += name.length;
      continue;
    }

    fail(`unexpected character "${char}" at position ${i}`);
  }

  return segments;
}

function parseBracket(inner: string, fail: (reason: string) => never): PathSegment {
  const raw = inner.trim();
  if (raw === "*") return { kind: "wildcard" };

  const quoted = raw.match(/^'([^']*)'$|^"([^"]*)"$/);
  if (quoted !== null) return { kind: "key", name: quoted[1] ?? quoted[2] ?? "" };

  if (raw.includes(":")) {
    const [startRaw = "", endRaw = ""] = raw.split(":", 2);
    const start = startRaw.trim() === "" ? undefined : Number(startRaw);
    const end = endRaw.trim() === "" ? undefined : Number(endRaw);
    if (
      (start !== undefined && !Number.isInteger(start)) ||
      (end !== undefined && !Number.isInteger(end))
    ) {
      fail(`slice bounds must be integers, got "${raw}"`);
    }
    return { kind: "slice", start, end };
  }

  const index = Number(raw);
  if (!Number.isInteger(index)) fail(`expected an index, got "${raw}"`);
  return { kind: "index", index };
}

function readName(expression: string, from: number): string {
  let end = from;
  while (end < expression.length && /[A-Za-z0-9_$-]/.test(expression[end] as string)) end += 1;
  return expression.slice(from, end);
}

/** Returns every value matching `expression`, in document order. */
export function queryPath(root: unknown, expression: string): unknown[] {
  let current: unknown[] = [root];

  for (const segment of parsePath(expression)) {
    const next: unknown[] = [];
    for (const value of current) applySegment(segment, value, next);
    current = next;
  }

  return current;
}

function applySegment(segment: PathSegment, value: unknown, out: unknown[]): void {
  switch (segment.kind) {
    case "key": {
      if (isPlainObject(value) && segment.name in value) out.push(value[segment.name]);
      return;
    }
    case "index": {
      if (!Array.isArray(value)) return;
      const index = segment.index < 0 ? value.length + segment.index : segment.index;
      if (index >= 0 && index < value.length) out.push(value[index]);
      return;
    }
    case "wildcard": {
      if (Array.isArray(value)) out.push(...value);
      else if (isPlainObject(value)) out.push(...Object.values(value));
      return;
    }
    case "slice": {
      if (!Array.isArray(value)) return;
      out.push(...value.slice(segment.start, segment.end));
      return;
    }
    case "descend": {
      collectDescendants(value, segment.name, out);
      return;
    }
  }
}

function collectDescendants(value: unknown, name: string, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDescendants(item, name, out);
    return;
  }
  if (!isPlainObject(value)) return;

  if (name in value) out.push(value[name]);
  for (const child of Object.values(value)) collectDescendants(child, name, out);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
