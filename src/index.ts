export { type AuthConfig, applyAuth } from "./core/auth/apply.js";
export { capBytes, type DecodedBody, decodeBody, formatBytes } from "./core/body.js";
export {
  DEFAULT_DIGEST_MAX_BYTES,
  type Digest,
  type DigestOptions,
  digest,
} from "./core/digest/digest.js";
export {
  inferShape,
  mergeShapes,
  renderShape,
  type Shape,
  type ShapeField,
  type ShapeLimits,
} from "./core/digest/shape.js";
export {
  ApiPilotError,
  type ApiPilotErrorOptions,
  type ErrorCode,
  isApiPilotError,
} from "./core/errors.js";
export {
  type ExecuteOptions,
  execute,
  type HeaderPair,
  type HttpResponse,
} from "./core/exec/execute.js";
export {
  DEFAULT_INSPECT_MAX_BYTES,
  type InspectOptions,
  type InspectResult,
  type InspectTarget,
  inspect,
} from "./core/inspect/inspect.js";
export {
  type InspectRunOptions,
  type InspectRunResult,
  inspectRun,
} from "./core/inspect/inspect-run.js";
export { type PathSegment, parsePath, queryPath } from "./core/inspect/json-path.js";
export {
  assertHostAllowed,
  assertProtocolAllowed,
  assertRequestAllowed,
  type Classification,
  isHostAllowed,
  type PolicyContext,
  type PolicyEnvironment,
  redirectGuard,
} from "./core/policy/policy.js";
export { REDACTED, Redactor, redactError } from "./core/redact/redactor.js";
export {
  type PreparedRequest,
  type PrepareOptions,
  prepareRequest,
  type RequestIntent,
} from "./core/request/prepare.js";
export {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  type HttpRequest,
  IDEMPOTENT_METHODS,
  type RequestBody,
  type RetryPolicy,
} from "./core/request/types.js";
export {
  type RunOptions,
  type RunResult,
  replayRun,
  runRequest,
} from "./core/run/run.js";
export {
  DEFAULT_RESOLVERS,
  envResolver,
  fileResolver,
  parseSecretReference,
  type ResolverContext,
  type SecretReference,
  type SecretResolver,
} from "./core/secrets/resolvers.js";
export {
  DEFAULT_DESCRIBE_MAX_BYTES,
  type DescribeOptions,
  describeOperation,
} from "./core/spec/describe.js";
export {
  fromValue,
  isSpecUrl,
  type LoadedSpec,
  type LoadOptions,
  loadSpec,
  parseDocument,
  type RefTarget,
} from "./core/spec/document.js";
export {
  extractOperations,
  type OperationBody,
  type OperationParameter,
  type OperationRecord,
  type OperationResponse,
  type ParameterLocation,
} from "./core/spec/operations.js";
export { loadRemoteSpec } from "./core/spec/remote.js";
export {
  DEFAULT_SCHEMA_LIMITS,
  type SchemaShapeLimits,
  schemaToShape,
} from "./core/spec/schema-shape.js";
export { OperationSearch, type SearchHit, stem, tokenise } from "./core/spec/search.js";
export { SpecIndex } from "./core/spec/spec-index.js";
export {
  DEFAULT_HISTORY_LIMIT,
  type HistoryQuery,
  type PutOptions,
  ResponseStore,
  type StoredRequestBody,
  type StoredRequestIntent,
  type StoredRequestSummary,
  type StoredResponseMeta,
} from "./core/store/response-store.js";
export { expandVariables, interpolate } from "./core/vars/interpolate.js";
export type {
  AuthDeclaration,
  EnvironmentDeclaration,
  EnvironmentsFile,
} from "./core/workspace/schema.js";
export {
  CACHE_DIRNAME,
  ENVIRONMENTS_FILENAME,
  LOCAL_ENVIRONMENTS_FILENAME,
  type ResolvedEnvironment,
  type ResolvedEnvironmentBundle,
  WORKSPACE_DIRNAME,
  Workspace,
} from "./core/workspace/workspace.js";
export { version } from "./version.js";
