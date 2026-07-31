/**
 * Structural summary of a JSON value.
 *
 * This is the whole product bet (ADR-0002) in one file: a model should learn
 * what a 5,000-element response *is* without any of it entering its context.
 * The shape of a list is a few dozen tokens; the list is fifty thousand.
 *
 * Rendered in TypeScript-ish notation because models read it natively and it
 * is denser than JSON Schema by a wide margin.
 */

export interface ShapeLimits {
  /** Nesting past this renders as `…`. */
  readonly maxDepth: number;
  /** Object keys past this collapse into a `+N more` marker. */
  readonly maxFields: number;
  /** Array elements inspected when inferring the element shape. */
  readonly maxArraySamples: number;
}

export interface ShapeField {
  readonly name: string;
  readonly shape: Shape;
  /** True when some sampled sibling lacked this key. */
  readonly optional: boolean;
}

export type Shape =
  | { readonly kind: "null" }
  | { readonly kind: "boolean" }
  | { readonly kind: "number" }
  | { readonly kind: "string" }
  | { readonly kind: "empty-array" }
  | {
      /** Lengths are absent when the shape came from a schema rather than data. */
      readonly kind: "array";
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly items: Shape;
    }
  | {
      readonly kind: "object";
      readonly fields: readonly ShapeField[];
      readonly hiddenFields: number;
    }
  | { readonly kind: "union"; readonly options: readonly Shape[] }
  /**
   * Rendered verbatim. Carries anything already in its most useful printed
   * form: a schema component name (`Pet`), an enum (`"open" | "closed"`), or a
   * formatted primitive (`string(date-time)`).
   */
  | { readonly kind: "named"; readonly name: string }
  /** Cut off by maxDepth. */
  | { readonly kind: "elided" };

export function inferShape(value: unknown, limits: ShapeLimits, depth = 0): Shape {
  if (depth > limits.maxDepth) return { kind: "elided" };
  if (value === null) return { kind: "null" };

  switch (typeof value) {
    case "boolean":
      return { kind: "boolean" };
    case "number":
    case "bigint":
      return { kind: "number" };
    case "string":
      return { kind: "string" };
    default:
      break;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "empty-array" };

    const sampleCount = Math.min(value.length, Math.max(1, limits.maxArraySamples));
    let items = inferShape(value[0], limits, depth + 1);
    for (let i = 1; i < sampleCount; i++) {
      items = mergeShapes(items, inferShape(value[i], limits, depth + 1));
    }
    return { kind: "array", minLength: value.length, maxLength: value.length, items };
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, limits.maxFields);
    return {
      kind: "object",
      fields: shown.map(([name, child]) => ({
        name,
        shape: inferShape(child, limits, depth + 1),
        optional: false,
      })),
      hiddenFields: entries.length - shown.length,
    };
  }

  return { kind: "elided" };
}

/**
 * Combines two shapes observed in the same position. Objects merge field-wise
 * (a key missing from either side becomes optional); anything else that differs
 * becomes a union.
 */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.kind === "elided") return b;
  if (b.kind === "elided") return a;
  if (a.kind === "empty-array" && b.kind === "array") {
    return { ...b, minLength: 0 };
  }
  if (b.kind === "empty-array" && a.kind === "array") {
    return { ...a, minLength: 0 };
  }
  if (a.kind === "array" && b.kind === "array") {
    // One side of unknown length makes the merged length unknown.
    const known = a.minLength !== undefined && b.minLength !== undefined;
    return {
      kind: "array",
      ...(known
        ? {
            minLength: Math.min(a.minLength as number, b.minLength as number),
            maxLength: Math.max(a.maxLength as number, b.maxLength as number),
          }
        : {}),
      items: mergeShapes(a.items, b.items),
    };
  }
  if (a.kind === "object" && b.kind === "object") {
    const names: string[] = [];
    for (const field of [...a.fields, ...b.fields]) {
      if (!names.includes(field.name)) names.push(field.name);
    }
    const fields = names.map((name) => {
      const left = a.fields.find((f) => f.name === name);
      const right = b.fields.find((f) => f.name === name);
      if (left !== undefined && right !== undefined) {
        return {
          name,
          shape: mergeShapes(left.shape, right.shape),
          optional: left.optional || right.optional,
        };
      }
      const present = left ?? right;
      // Non-null: `name` came from one of the two field lists.
      return { name, shape: (present as ShapeField).shape, optional: true };
    });
    return { kind: "object", fields, hiddenFields: Math.max(a.hiddenFields, b.hiddenFields) };
  }

  const options = [...unionOptions(a), ...unionOptions(b)];
  const unique: Shape[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    const key = renderShape(option, "", { inline: true });
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(option);
  }
  return unique.length === 1 ? (unique[0] as Shape) : { kind: "union", options: unique };
}

function unionOptions(shape: Shape): readonly Shape[] {
  return shape.kind === "union" ? shape.options : [shape];
}

interface RenderOptions {
  /** Forces a single line — used for union dedupe keys and nested inline objects. */
  readonly inline?: boolean;
}

export function renderShape(shape: Shape, indent = "", options: RenderOptions = {}): string {
  switch (shape.kind) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "elided":
      return "…";
    case "named":
      return shape.name;
    case "empty-array":
      return "unknown[0]";
    case "union":
      return shape.options
        .map((option) => renderShape(option, indent, { inline: true }))
        .join(" | ");
    case "array":
      return renderArray(shape, indent, options);
    case "object":
      return renderObject(shape, indent, options);
  }
}

/** Empty when the length is unknown, as it always is for schema-derived shapes. */
function lengthLabel(min: number | undefined, max: number | undefined): string {
  if (min === undefined || max === undefined) return "";
  return min === max ? `${min}` : `${min}..${max}`;
}

function renderArray(
  shape: Extract<Shape, { kind: "array" }>,
  indent: string,
  options: RenderOptions,
): string {
  const label = lengthLabel(shape.minLength, shape.maxLength);
  const items = renderShape(shape.items, indent, options);

  // A multi-line element type would push the count far from the top of the
  // block, which is exactly the number the reader came for.
  if (items.includes("\n")) {
    return label === "" ? `array of ${items}` : `array[${label}] of ${items}`;
  }
  // Without parentheses `a | b[3]` reads as an array of `b`, not an array of
  // the union.
  if (shape.items.kind === "union") return `(${items})[${label}]`;
  return `${items}[${label}]`;
}

function renderObject(
  shape: Extract<Shape, { kind: "object" }>,
  indent: string,
  options: RenderOptions,
): string {
  if (shape.fields.length === 0) {
    return shape.hiddenFields > 0 ? `{ +${shape.hiddenFields} more }` : "{}";
  }

  const parts = shape.fields.map(
    (field) =>
      `${field.name}${field.optional ? "?" : ""}: ${renderShape(field.shape, `${indent}  `, options)}`,
  );
  if (shape.hiddenFields > 0) parts.push(`+${shape.hiddenFields} more`);

  const inline = `{ ${parts.join("; ")} }`;
  if (options.inline === true || (shape.fields.length <= 2 && !inline.includes("\n")))
    return inline;

  const inner = shape.fields.map(
    (field) =>
      `${indent}  ${field.name}${field.optional ? "?" : ""}: ${renderShape(field.shape, `${indent}  `, options)}`,
  );
  if (shape.hiddenFields > 0) inner.push(`${indent}  +${shape.hiddenFields} more`);
  return `{\n${inner.join("\n")}\n${indent}}`;
}
