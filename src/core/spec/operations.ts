import type { JsonValue, LoadedSpec } from "./document.js";

/**
 * Flattens a document into a list of operations.
 *
 * Nothing here throws. Real specs are broken in small ways constantly — a
 * missing `operationId`, a `$ref` to a component someone deleted, a stray key
 * where a path item belongs — and refusing to load the other 400 operations
 * because of one bad entry would be useless behaviour. Every problem becomes a
 * warning and the index stays partial but usable.
 */

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface OperationParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required: boolean;
  readonly description: string | undefined;
  readonly schema: JsonValue;
}

export interface OperationBody {
  readonly required: boolean;
  readonly contentType: string;
  readonly schema: JsonValue;
}

export interface OperationResponse {
  readonly status: string;
  readonly description: string | undefined;
  readonly contentType: string | undefined;
  readonly schema: JsonValue;
}

export interface OperationRecord {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly specId: string;
  readonly parameters: readonly OperationParameter[];
  readonly body: OperationBody | undefined;
  readonly responses: readonly OperationResponse[];
  /** Security scheme descriptions, already flattened for display. */
  readonly security: readonly string[];
}

export interface ExtractResult {
  readonly operations: readonly OperationRecord[];
  readonly warnings: readonly string[];
}

export function extractOperations(spec: LoadedSpec): ExtractResult {
  const warnings: string[] = [];
  const operations: OperationRecord[] = [];

  const root = asRecord(spec.root);
  if (root === undefined) {
    warnings.push(`${spec.id}: document is not an object`);
    return { operations, warnings };
  }

  const paths = asRecord(root.paths);
  if (paths === undefined) {
    warnings.push(`${spec.id}: no "paths" object, so no operations were indexed`);
    return { operations, warnings };
  }

  const securitySchemes = asRecord(asRecord(root.components)?.securitySchemes) ?? {};
  const defaultSecurity = root.security;
  const seenIds = new Map<string, number>();

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = asRecord(deref(rawItem, spec));
    if (item === undefined) {
      warnings.push(`${spec.id}: path "${path}" is not an object and was skipped`);
      continue;
    }

    const sharedParameters = readParameters(item.parameters, spec, warnings, `${spec.id} ${path}`);

    for (const method of HTTP_METHODS) {
      const operation = asRecord(item[method]);
      if (operation === undefined) continue;

      const own = readParameters(
        operation.parameters,
        spec,
        warnings,
        `${spec.id} ${method.toUpperCase()} ${path}`,
      );

      const id = uniqueId(
        typeof operation.operationId === "string" && operation.operationId !== ""
          ? operation.operationId
          : synthesiseId(method, path),
        seenIds,
        spec,
        warnings,
      );

      operations.push({
        id,
        method: method.toUpperCase(),
        path,
        summary: asString(operation.summary),
        description: asString(operation.description),
        tags: asStringArray(operation.tags),
        deprecated: operation.deprecated === true,
        specId: spec.id,
        // Operation-level parameters override same-named path-level ones.
        parameters: mergeParameters(sharedParameters, own),
        body: readBody(operation.requestBody, spec),
        responses: readResponses(operation.responses, spec),
        security: describeSecurity(operation.security ?? defaultSecurity, securitySchemes),
      });
    }
  }

  return { operations, warnings };
}

function mergeParameters(
  shared: readonly OperationParameter[],
  own: readonly OperationParameter[],
): OperationParameter[] {
  const merged = [...own];
  for (const parameter of shared) {
    if (!merged.some((p) => p.name === parameter.name && p.in === parameter.in)) {
      merged.push(parameter);
    }
  }
  return merged;
}

function readParameters(
  node: unknown,
  spec: LoadedSpec,
  warnings: string[],
  context: string,
): OperationParameter[] {
  if (!Array.isArray(node)) return [];

  const out: OperationParameter[] = [];
  for (const raw of node) {
    const parameter = asRecord(deref(raw, spec));
    if (parameter === undefined) {
      warnings.push(`${context}: a parameter could not be resolved and was skipped`);
      continue;
    }
    const name = asString(parameter.name);
    const location = asString(parameter.in);
    if (name === undefined || !isParameterLocation(location)) {
      warnings.push(`${context}: a parameter is missing "name" or "in" and was skipped`);
      continue;
    }
    out.push({
      name,
      in: location,
      // Path parameters are required by definition, whatever the spec claims.
      required: parameter.required === true || location === "path",
      description: asString(parameter.description),
      schema: parameter.schema ?? {},
    });
  }
  return out;
}

function readBody(node: unknown, spec: LoadedSpec): OperationBody | undefined {
  const body = asRecord(deref(node, spec));
  if (body === undefined) return undefined;

  const content = asRecord(body.content);
  if (content === undefined) return undefined;

  const [contentType, media] = preferredContent(content);
  if (contentType === undefined) return undefined;

  return {
    required: body.required === true,
    contentType,
    schema: asRecord(media)?.schema ?? {},
  };
}

function readResponses(node: unknown, spec: LoadedSpec): OperationResponse[] {
  const responses = asRecord(node);
  if (responses === undefined) return [];

  const out: OperationResponse[] = [];
  for (const [status, rawResponse] of Object.entries(responses)) {
    const response = asRecord(deref(rawResponse, spec));
    if (response === undefined) continue;

    const content = asRecord(response.content);
    const [contentType, media] =
      content === undefined ? [undefined, undefined] : preferredContent(content);

    out.push({
      status,
      description: asString(response.description),
      contentType,
      schema: asRecord(media)?.schema ?? {},
    });
  }
  return out;
}

/** JSON first: it is what an agent can actually construct and read. */
function preferredContent(
  content: Record<string, unknown>,
): [string | undefined, unknown | undefined] {
  const entries = Object.entries(content);
  const json = entries.find(([type]) => type.includes("json"));
  const chosen = json ?? entries[0];
  return chosen === undefined ? [undefined, undefined] : [chosen[0], chosen[1]];
}

function describeSecurity(
  requirement: unknown,
  schemes: Record<string, unknown>,
): readonly string[] {
  if (!Array.isArray(requirement) || requirement.length === 0) return [];

  const out: string[] = [];
  for (const entry of requirement) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    for (const name of Object.keys(record)) {
      const scheme = asRecord(schemes[name]);
      const type = asString(scheme?.type) ?? "unknown";
      const detail = asString(scheme?.scheme) ?? asString(scheme?.name);
      out.push(detail === undefined ? `${name} (${type})` : `${name} (${type}: ${detail})`);
    }
  }
  return [...new Set(out)];
}

function synthesiseId(method: string, path: string): string {
  const slug = path
    .replaceAll(/[{}]/g, "")
    .split("/")
    .filter((segment) => segment !== "")
    .join("_");
  return `${method}_${slug || "root"}`;
}

function uniqueId(
  candidate: string,
  seen: Map<string, number>,
  spec: LoadedSpec,
  warnings: string[],
): string {
  const count = seen.get(candidate) ?? 0;
  seen.set(candidate, count + 1);
  if (count === 0) return candidate;

  // Duplicated operationIds are common in generated specs. Keep both rather
  // than dropping one, but say so.
  warnings.push(
    `${spec.id}: duplicate operationId "${candidate}" was renamed to "${candidate}~${count}"`,
  );
  return `${candidate}~${count}`;
}

function deref(node: unknown, spec: LoadedSpec): unknown {
  const record = asRecord(node);
  if (record === undefined || typeof record.$ref !== "string") return node;
  return spec.resolveRef(record.$ref)?.value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isParameterLocation(value: string | undefined): value is ParameterLocation {
  return value === "path" || value === "query" || value === "header" || value === "cookie";
}
