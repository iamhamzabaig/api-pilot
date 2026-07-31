import type { OperationRecord } from "./operations.js";

/**
 * Ranked search over indexed operations — the other half of the ADR-0002 bet.
 *
 * Written rather than taken as a dependency because the thing that makes an
 * API search useful is not the ranking maths (which is a standard IDF scheme
 * in ~60 lines) but the domain knowledge a generic text index has none of:
 *
 *   - `getUserById` is three words, not one token
 *   - "update" means PATCH or PUT, and evidence *against* DELETE
 *   - "list" wants a collection path, not `/{id}`
 *
 * Without that, "what endpoint updates a subscription?" ranks every route
 * mentioning subscriptions equally, which is the failure mode this whole
 * design is betting against.
 */

export interface SearchHit {
  readonly operation: OperationRecord;
  readonly score: number;
}

interface IndexedOperation {
  readonly operation: OperationRecord;
  /** token → accumulated field weight. */
  readonly weights: ReadonlyMap<string, number>;
  /**
   * Tokens from the operationId, path, and tags — what the operation *is*,
   * as opposed to what its prose happens to mention.
   */
  readonly identity: ReadonlySet<string>;
  readonly haystack: string;
  readonly endsWithParameter: boolean;
}

const FIELD_WEIGHTS = {
  operationId: 3,
  summary: 3,
  path: 2.5,
  tag: 2,
  parameter: 1,
  description: 1,
} as const;

/**
 * Saturation constant. Tuned to the field-weight scale above: at 1.2 every
 * weight over ~3 scored within a few percent of every other, which made the
 * field weights decorative.
 */
const SATURATION = 4;

const METHOD_INTENT: ReadonlyMap<string, readonly string[]> = new Map([
  ["creat", ["POST"]],
  ["add", ["POST"]],
  ["new", ["POST"]],
  ["insert", ["POST"]],
  ["submit", ["POST"]],
  ["updat", ["PATCH", "PUT"]],
  // Both stems occur: "modify" survives stemming intact, "modifies" becomes
  // "modifi". Missing one silently disables the signal for half the phrasings.
  ["modify", ["PATCH", "PUT"]],
  ["modifi", ["PATCH", "PUT"]],
  ["edit", ["PATCH", "PUT"]],
  ["chang", ["PATCH", "PUT"]],
  ["set", ["PATCH", "PUT"]],
  ["replac", ["PUT"]],
  ["delet", ["DELETE"]],
  ["remov", ["DELETE"]],
  ["destroy", ["DELETE"]],
  ["cancel", ["DELETE", "POST"]],
  ["get", ["GET"]],
  ["fetch", ["GET"]],
  ["read", ["GET"]],
  ["retriev", ["GET"]],
  ["show", ["GET"]],
  ["list", ["GET"]],
  ["search", ["GET"]],
  ["find", ["GET"]],
  ["all", ["GET"]],
]);

/** Words that carry intent about cardinality rather than about a resource. */
const COLLECTION_WORDS = new Set(["list", "all", "search", "browse", "everi", "every"]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "what",
  "which",
  "how",
  "do",
  "doe",
  "i",
  "to",
  "for",
  "of",
  "in",
  "on",
  "is",
  "are",
  "that",
  "endpoint",
  "endpoints",
  "api",
  "call",
  "route",
  "can",
  "me",
  "my",
  "and",
  // "all" and "every" are cardinality intent, not subject matter. Scored as
  // content they hand the win to any summary that says "list all ...".
  "all",
  "every",
  "everi",
  "one",
  "single",
  "existing",
  "exist",
  "specified",
  "specifi",
]);

const INTENT_MATCH_BONUS = 2.5;
const INTENT_MISMATCH_PENALTY = 1.5;
const COLLECTION_BONUS = 1;
const EXACT_ID_BONUS = 12;
const EXACT_PATH_BONUS = 6;
const SUBSTRING_BONUS = 3;

/**
 * How hard to penalise an operation for being *about* something the query did
 * not mention. `/subscriptions/{id}/items` matching "list subscriptions" is
 * the canonical case: it scores higher on raw term weight because it says
 * "subscription" more often, while being the wrong answer.
 */
const DRIFT_PENALTY = 0.35;
const MAX_DRIFT_PENALTY = 3;

export class OperationSearch {
  readonly #documents: readonly IndexedOperation[];
  readonly #idf: ReadonlyMap<string, number>;

  constructor(operations: readonly OperationRecord[]) {
    this.#documents = operations.map(indexOperation);

    const documentFrequency = new Map<string, number>();
    for (const document of this.#documents) {
      for (const token of document.weights.keys()) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }

    const total = Math.max(1, this.#documents.length);
    const idf = new Map<string, number>();
    for (const [token, frequency] of documentFrequency) {
      idf.set(token, Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5)));
    }
    this.#idf = idf;
  }

  search(query: string, limit = 10): SearchHit[] {
    const normalisedQuery = query.trim().toLowerCase();
    if (normalisedQuery === "") return [];

    // Intent is read from the raw tokens, before stop-word removal: "all" is
    // noise as a search term but meaningful as cardinality.
    const rawTokens = tokenise(query);
    const tokens = rawTokens.filter((token) => !STOP_WORDS.has(token));
    const intendedMethods = new Set(rawTokens.flatMap((token) => METHOD_INTENT.get(token) ?? []));
    const wantsCollection = rawTokens.some((token) => COLLECTION_WORDS.has(token));
    const asked = new Set(rawTokens);

    const hits: SearchHit[] = [];
    for (const document of this.#documents) {
      const score = this.#score(
        document,
        tokens,
        asked,
        intendedMethods,
        wantsCollection,
        normalisedQuery,
      );
      if (score > 0) hits.push({ operation: document.operation, score });
    }

    hits.sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id));
    return hits.slice(0, limit);
  }

  #score(
    document: IndexedOperation,
    tokens: readonly string[],
    asked: ReadonlySet<string>,
    intendedMethods: ReadonlySet<string>,
    wantsCollection: boolean,
    rawQuery: string,
  ): number {
    let score = 0;
    let matched = 0;

    for (const token of tokens) {
      const weight = document.weights.get(token);
      if (weight === undefined) continue;
      matched += 1;
      score += (this.#idf.get(token) ?? 1) * (weight / (weight + SATURATION));
    }

    if (matched === 0) {
      // An exact identifier or path fragment is still a hit even when every
      // word of it was filtered out as noise.
      return document.haystack.includes(rawQuery) ? SUBSTRING_BONUS : 0;
    }

    if (document.operation.id.toLowerCase() === rawQuery) score += EXACT_ID_BONUS;
    if (document.operation.path.toLowerCase() === rawQuery) score += EXACT_PATH_BONUS;
    else if (document.operation.path.toLowerCase().includes(rawQuery)) score += SUBSTRING_BONUS;

    score -= this.#driftPenalty(document, asked);

    if (intendedMethods.size > 0) {
      score += intendedMethods.has(document.operation.method)
        ? INTENT_MATCH_BONUS
        : -INTENT_MISMATCH_PENALTY;
    }

    if (wantsCollection) {
      score += document.endsWithParameter ? -COLLECTION_BONUS : COLLECTION_BONUS;
    }

    // A deprecated operation is a real answer, but never the best one.
    if (document.operation.deprecated) score -= 1;

    return score;
  }

  /**
   * Charges an operation for the distinctive subjects in its own identity that
   * the query never mentioned. Common path noise like `v1` has near-zero IDF
   * and costs nothing; a whole extra resource like `items` costs real score.
   */
  #driftPenalty(document: IndexedOperation, asked: ReadonlySet<string>): number {
    let penalty = 0;
    for (const token of document.identity) {
      if (asked.has(token)) continue;
      penalty += DRIFT_PENALTY * (this.#idf.get(token) ?? 0);
      if (penalty >= MAX_DRIFT_PENALTY) return MAX_DRIFT_PENALTY;
    }
    return penalty;
  }
}

function indexOperation(operation: OperationRecord): IndexedOperation {
  const weights = new Map<string, number>();
  const identity = new Set<string>();

  const add = (text: string | undefined, weight: number, isIdentity = false): void => {
    if (text === undefined) return;
    for (const token of tokenise(text)) {
      if (STOP_WORDS.has(token)) continue;
      weights.set(token, (weights.get(token) ?? 0) + weight);
      if (isIdentity) identity.add(token);
    }
  };

  add(operation.id, FIELD_WEIGHTS.operationId, true);
  add(operation.path, FIELD_WEIGHTS.path, true);
  for (const tag of operation.tags) add(tag, FIELD_WEIGHTS.tag, true);

  add(operation.summary, FIELD_WEIGHTS.summary);
  add(operation.method, FIELD_WEIGHTS.operationId);
  for (const parameter of operation.parameters) add(parameter.name, FIELD_WEIGHTS.parameter);
  add(operation.description, FIELD_WEIGHTS.description);

  return {
    operation,
    weights,
    identity,
    haystack:
      `${operation.method} ${operation.path} ${operation.id} ${operation.summary ?? ""}`.toLowerCase(),
    endsWithParameter: /\{[^}]*\}\/?$/.test(operation.path),
  };
}

/**
 * Splits on non-alphanumerics *and* on camelCase boundaries, then stems.
 * `getUserById` and "get user by id" have to land on the same tokens or
 * natural-language search over generated operationIds does not work at all.
 */
export function tokenise(text: string): string[] {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "")
    .map(stem);
}

/**
 * A deliberately small suffix stripper, not a Porter stemmer. It exists to
 * make update/updates/updating/updated collapse to one token; anything more
 * aggressive starts merging unrelated resource names.
 */
export function stem(token: string): string {
  let out = token;

  if (out.length > 4 && out.endsWith("ies")) out = `${out.slice(0, -3)}y`;
  else if (out.length > 4 && out.endsWith("sses")) out = out.slice(0, -2);
  else if (out.length > 4 && out.endsWith("es")) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith("s") && !out.endsWith("ss")) out = out.slice(0, -1);

  if (out.length > 5 && out.endsWith("ing")) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith("ed")) out = out.slice(0, -2);

  if (out.length > 4 && out.endsWith("e")) out = out.slice(0, -1);

  return out;
}
