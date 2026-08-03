import { ApiPilotError } from "../errors.js";
import { type DescribeOptions, describeOperation } from "./describe.js";
import {
  fromValue,
  isSpecUrl,
  type JsonValue,
  type LoadedSpec,
  type LoadOptions,
  loadSpec,
} from "./document.js";
import { extractOperations, type OperationRecord } from "./operations.js";
import { OperationSearch, type SearchHit } from "./search.js";

/**
 * The facade the adapters talk to. Holds any number of loaded specs behind one
 * search surface, because "which of my four services has an endpoint for X?"
 * is a question people actually ask.
 *
 * Loading a spec adds **zero** MCP tools and zero tokens to the tool surface,
 * however many operations it contains. That is the measurable claim from
 * ADR-0002 and it lives or dies here.
 */
export class SpecIndex {
  readonly operations: readonly OperationRecord[];

  readonly #specs: ReadonlyMap<string, LoadedSpec>;
  readonly #byId: ReadonlyMap<string, OperationRecord>;
  readonly #search: OperationSearch;
  readonly #extractionWarnings: readonly string[];

  private constructor(specs: readonly LoadedSpec[]) {
    const operations: OperationRecord[] = [];
    const warnings: string[] = [];

    for (const spec of specs) {
      const result = extractOperations(spec);
      operations.push(...result.operations);
      warnings.push(...result.warnings);
    }

    this.#specs = new Map(specs.map((spec) => [spec.id, spec]));
    this.operations = operations;
    this.#extractionWarnings = warnings;
    this.#byId = new Map(operations.map((operation) => [operation.id, operation]));
    this.#search = new OperationSearch(operations);
  }

  /**
   * Read live rather than snapshotted at construction. Refs resolve lazily, so
   * a broken `$ref` inside a schema is only discovered when something renders
   * it — a snapshot taken at load time would always claim that spec was clean.
   */
  get warnings(): readonly string[] {
    const all = [...this.#extractionWarnings];
    for (const spec of this.#specs.values()) {
      all.push(...spec.warnings.map((warning) => `${spec.id}: ${warning}`));
    }
    return [...new Set(all)];
  }

  /**
   * A source is a file path or an `http(s)://` URL. The remote loader is behind
   * a dynamic import so a workspace with only local specs never loads the HTTP
   * stack to run `search`.
   */
  static async fromPaths(
    sources: readonly string[],
    options: LoadOptions = {},
  ): Promise<SpecIndex> {
    const specs: LoadedSpec[] = [];
    for (const source of sources) {
      if (isSpecUrl(source)) {
        const { loadRemoteSpec } = await import("./remote.js");
        specs.push(await loadRemoteSpec(source, options));
      } else {
        specs.push(await loadSpec(source, options));
      }
    }
    return new SpecIndex(specs);
  }

  static fromDocuments(documents: readonly { value: JsonValue; id: string }[]): SpecIndex {
    return new SpecIndex(documents.map((document) => fromValue(document.value, document.id)));
  }

  get size(): number {
    return this.operations.length;
  }

  search(query: string, limit = 10): SearchHit[] {
    return this.#search.search(query, limit);
  }

  get(id: string): OperationRecord {
    const operation = this.#byId.get(id);
    if (operation === undefined) {
      throw new ApiPilotError("NOT_FOUND", `No operation with id "${id}"`, {
        hint: "Use search to find an operation id.",
      });
    }
    return operation;
  }

  describe(id: string, options: DescribeOptions = {}): string {
    const operation = this.get(id);
    const spec = this.#specs.get(operation.specId);
    if (spec === undefined) {
      throw new ApiPilotError("NOT_FOUND", `Spec "${operation.specId}" is no longer loaded`);
    }
    return describeOperation(operation, spec, options);
  }
}
