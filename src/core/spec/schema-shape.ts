import type { Shape, ShapeField } from "../digest/shape.js";
import type { LoadedSpec } from "./document.js";

/**
 * JSON Schema → the same `Shape` the response digest renders.
 *
 * Reusing M2's renderer means a request body and a response body are described
 * in one notation, and there is only one place where "too deep, elide it"
 * logic lives.
 *
 * A `$ref` already visited on the current branch renders as its component name
 * rather than recursing. For a self-referential schema (`Comment.replies:
 * Comment[]`) that is not a fallback — it is the better output.
 */

export interface SchemaShapeLimits {
  readonly maxDepth: number;
  readonly maxFields: number;
}

export const DEFAULT_SCHEMA_LIMITS: SchemaShapeLimits = { maxDepth: 4, maxFields: 16 };

type Schema = Record<string, unknown>;

export function schemaToShape(
  schema: unknown,
  spec: LoadedSpec,
  limits: SchemaShapeLimits = DEFAULT_SCHEMA_LIMITS,
): Shape {
  return convert(schema, spec, limits, 0, new Set());
}

function convert(
  node: unknown,
  spec: LoadedSpec,
  limits: SchemaShapeLimits,
  depth: number,
  visited: ReadonlySet<string>,
): Shape {
  if (node === null || typeof node !== "object") return { kind: "elided" };
  if (depth > limits.maxDepth) return { kind: "elided" };

  const schema = node as Schema;

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (visited.has(ref)) {
      // The cycle is the interesting fact; print the name and stop.
      return { kind: "named", name: refName(ref) };
    }
    const target = spec.resolveRef(ref);
    if (target === undefined) return { kind: "named", name: refName(ref) };
    return convert(target.value, spec, limits, depth, new Set([...visited, ref]));
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { kind: "named", name: renderEnum(schema.enum) };
  }

  const composed = composition(schema, spec, limits, depth, visited);
  if (composed !== undefined) return composed;

  const types = normaliseTypes(schema);

  if (types.includes("array")) {
    return {
      kind: "array",
      items: convert(schema.items ?? {}, spec, limits, depth + 1, visited),
    };
  }

  if (types.includes("object") || schema.properties !== undefined) {
    return objectShape(schema, spec, limits, depth, visited);
  }

  return withNull(primitive(schema, types), types, schema);
}

function composition(
  schema: Schema,
  spec: LoadedSpec,
  limits: SchemaShapeLimits,
  depth: number,
  visited: ReadonlySet<string>,
): Shape | undefined {
  // allOf composes into one object: keys accumulate and a key required by any
  // branch stays required. Merging as a union would wrongly make them optional.
  if (Array.isArray(schema.allOf)) {
    const fields: ShapeField[] = [];
    let hidden = 0;
    for (const branch of schema.allOf) {
      const part = convert(branch, spec, limits, depth, visited);
      if (part.kind !== "object") continue;
      hidden += part.hiddenFields;
      for (const field of part.fields) {
        if (!fields.some((existing) => existing.name === field.name)) fields.push(field);
      }
    }
    if (fields.length > 0) return { kind: "object", fields, hiddenFields: hidden };
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const options = branches.map((branch) => convert(branch, spec, limits, depth, visited));
    return options.length === 1 ? (options[0] as Shape) : { kind: "union", options };
  }

  return undefined;
}

function objectShape(
  schema: Schema,
  spec: LoadedSpec,
  limits: SchemaShapeLimits,
  depth: number,
  visited: ReadonlySet<string>,
): Shape {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(
    (Array.isArray(schema.required) ? schema.required : []).filter(
      (name): name is string => typeof name === "string",
    ),
  );

  const entries = Object.entries(properties);
  const shown = entries.slice(0, limits.maxFields);

  const fields: ShapeField[] = shown.map(([name, child]) => ({
    name,
    shape: convert(child, spec, limits, depth + 1, visited),
    optional: !required.has(name),
  }));

  if (fields.length === 0 && schema.additionalProperties !== undefined) {
    const value =
      schema.additionalProperties === true
        ? { kind: "elided" as const }
        : convert(schema.additionalProperties, spec, limits, depth + 1, visited);
    return {
      kind: "object",
      fields: [{ name: "[key: string]", shape: value, optional: false }],
      hiddenFields: 0,
    };
  }

  return { kind: "object", fields, hiddenFields: entries.length - shown.length };
}

function primitive(schema: Schema, types: readonly string[]): Shape {
  const format = typeof schema.format === "string" ? schema.format : undefined;

  for (const type of types) {
    switch (type) {
      case "string":
        // `string(uuid)` tells a caller far more than `string` alone.
        return format === undefined
          ? { kind: "string" }
          : { kind: "named", name: `string(${format})` };
      case "integer":
      case "number":
        return { kind: "number" };
      case "boolean":
        return { kind: "boolean" };
      case "null":
        return { kind: "null" };
      default:
        break;
    }
  }
  return { kind: "elided" };
}

/** OpenAPI 3.0 spells it `nullable: true`; 3.1 uses `type: [..., "null"]`. */
function withNull(shape: Shape, types: readonly string[], schema: Schema): Shape {
  const nullable = schema.nullable === true || types.includes("null");
  if (!nullable || shape.kind === "null") return shape;
  return { kind: "union", options: [shape, { kind: "null" }] };
}

function normaliseTypes(schema: Schema): string[] {
  const type = schema.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === "string");
  return [];
}

function renderEnum(values: readonly unknown[]): string {
  const shown = values.slice(0, 6).map((value) => JSON.stringify(value));
  if (values.length > shown.length) shown.push(`…+${values.length - shown.length}`);
  return shown.join(" | ");
}

function refName(ref: string): string {
  return (
    ref
      .split("/")
      .filter((segment) => segment !== "")
      .at(-1) ?? ref
  );
}
