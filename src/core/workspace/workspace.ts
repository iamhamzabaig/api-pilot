import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import type { AuthConfig } from "../auth/apply.js";
import { ApiPilotError } from "../errors.js";
import type { Classification } from "../policy/policy.js";
import { Redactor } from "../redact/redactor.js";
import {
  DEFAULT_RESOLVERS,
  parseSecretReference,
  resolverFor,
  type SecretResolver,
} from "../secrets/resolvers.js";
import { isSpecUrl } from "../spec/document.js";
import { expandVariables, interpolate } from "../vars/interpolate.js";
import {
  type EnvironmentDeclaration,
  EnvironmentsFileSchema,
  looksLikeSecretName,
} from "./schema.js";

/**
 * A workspace is a directory containing `.apipilot/`. Everything API Pilot
 * knows about a project lives in files there, so `git clone` is the whole
 * onboarding story and there is no account or sync layer to go wrong.
 */

export const WORKSPACE_DIRNAME = ".apipilot";
export const ENVIRONMENTS_FILENAME = "environments.yaml";
export const LOCAL_ENVIRONMENTS_FILENAME = "environments.local.yaml";
export const CACHE_DIRNAME = ".cache";

export interface ResolvedEnvironment {
  readonly name: string;
  readonly classification: Classification;
  readonly baseUrl: string | undefined;
  readonly allowedHosts: readonly string[];
  readonly variables: ReadonlyMap<string, string>;
  /** Variables whose values came from a secret reference. Names only. */
  readonly secretNames: readonly string[];
  readonly auth: AuthConfig | undefined;
}

export interface ResolvedEnvironmentBundle {
  readonly environment: ResolvedEnvironment;
  /** Pre-seeded with every secret resolved for this environment. */
  readonly redactor: Redactor;
}

export class Workspace {
  /** Directory containing `.apipilot/`. */
  readonly root: string;
  readonly cacheDir: string;
  /** Non-fatal configuration problems, worth showing the user once. */
  readonly warnings: readonly string[];

  /**
   * Configured spec sources: local paths resolved against the workspace root,
   * `http(s)://` URLs left alone. `resolve()` would mangle a URL into a path
   * relative to the root, so the two cases have to be told apart here.
   */
  readonly specPaths: readonly string[];

  readonly #declarations: ReadonlyMap<string, EnvironmentDeclaration>;
  readonly #defaultEnvironment: string | undefined;
  readonly #resolvers: readonly SecretResolver[];

  private constructor(
    root: string,
    declarations: ReadonlyMap<string, EnvironmentDeclaration>,
    defaultEnvironment: string | undefined,
    specs: readonly string[],
    warnings: readonly string[],
    resolvers: readonly SecretResolver[],
  ) {
    this.root = root;
    this.cacheDir = join(root, WORKSPACE_DIRNAME, CACHE_DIRNAME);
    this.specPaths = specs.map((source) => (isSpecUrl(source) ? source : resolve(root, source)));
    this.#declarations = declarations;
    this.#defaultEnvironment = defaultEnvironment;
    this.warnings = warnings;
    this.#resolvers = resolvers;
  }

  /** Walks up from `startDir` looking for `.apipilot/`, like git does for `.git`. */
  static async find(
    startDir: string = process.cwd(),
    resolvers: readonly SecretResolver[] = DEFAULT_RESOLVERS,
  ): Promise<Workspace> {
    let current = resolve(startDir);

    for (;;) {
      if (await isDirectory(join(current, WORKSPACE_DIRNAME))) {
        return Workspace.load(current, resolvers);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    throw new ApiPilotError("NOT_FOUND", `No ${WORKSPACE_DIRNAME}/ directory found`, {
      hint: `Create ${WORKSPACE_DIRNAME}/${ENVIRONMENTS_FILENAME} at the root of your project.`,
    });
  }

  static async load(
    root: string,
    resolvers: readonly SecretResolver[] = DEFAULT_RESOLVERS,
  ): Promise<Workspace> {
    const dir = join(root, WORKSPACE_DIRNAME);
    const warnings: string[] = [];

    const shared = await readEnvironmentsFile(join(dir, ENVIRONMENTS_FILENAME), true);
    if (shared === undefined) {
      throw new ApiPilotError("NOT_FOUND", `No ${ENVIRONMENTS_FILENAME} in ${dir}`, {
        hint: "Every workspace needs at least one environment.",
      });
    }
    const local = await readEnvironmentsFile(join(dir, LOCAL_ENVIRONMENTS_FILENAME), false);

    // Only the committed file gets the literal-secret warning: a literal in the
    // gitignored override is a local choice, not a disclosure.
    for (const [name, declaration] of Object.entries(shared.environments)) {
      for (const [variable, value] of Object.entries(declaration.variables)) {
        if (looksLikeSecretName(variable) && parseSecretReference(value) === undefined) {
          warnings.push(
            `${ENVIRONMENTS_FILENAME} (${name}.variables.${variable}) looks like a credential but holds a literal value. ` +
              `Use a reference such as \${env:MY_TOKEN} so the secret stays out of version control.`,
          );
        }
      }
    }

    const declarations = new Map(Object.entries(shared.environments));
    for (const [name, override] of Object.entries(local?.environments ?? {})) {
      declarations.set(name, mergeDeclarations(declarations.get(name), override));
    }

    return new Workspace(
      resolve(root),
      declarations,
      local?.default ?? shared.default,
      // A local file replaces the spec list outright rather than appending:
      // "index these instead" is the reason to override it at all.
      local?.specs !== undefined && local.specs.length > 0 ? local.specs : shared.specs,
      warnings,
      resolvers,
    );
  }

  get environmentNames(): readonly string[] {
    return [...this.#declarations.keys()];
  }

  get defaultEnvironmentName(): string {
    const fallback = this.#defaultEnvironment ?? this.environmentNames[0];
    if (fallback === undefined) {
      throw new ApiPilotError("CONFIG_INVALID", "No environments are defined");
    }
    return fallback;
  }

  /** Resolves secrets and returns the environment alongside a seeded redactor. */
  async resolveEnvironment(name?: string): Promise<ResolvedEnvironmentBundle> {
    const environmentName = name ?? this.defaultEnvironmentName;
    const declaration = this.#declarations.get(environmentName);
    if (declaration === undefined) {
      throw new ApiPilotError("NOT_FOUND", `No environment named "${environmentName}"`, {
        hint: `Defined: ${this.environmentNames.join(", ") || "(none)"}.`,
      });
    }

    const redactor = new Redactor();
    const rawVariables = new Map<string, string>();
    const secretNames = new Set<string>();

    for (const [variable, value] of Object.entries(declaration.variables)) {
      const reference = parseSecretReference(value);
      if (reference === undefined) {
        rawVariables.set(variable, value);
        continue;
      }
      const resolver = resolverFor(reference.scheme, this.#resolvers);
      const secret = await resolver.resolve(reference.argument, { baseDir: this.root });
      redactor.add(secret);
      rawVariables.set(variable, secret);
      secretNames.add(variable);
    }

    const variables = expandVariables(rawVariables, secretNames);
    const auth = resolveAuth(declaration.auth, variables);
    const allowedHosts = resolveAllowedHosts(declaration, environmentName);

    return {
      redactor,
      environment: {
        name: environmentName,
        classification: declaration.classification,
        baseUrl: declaration.baseUrl,
        allowedHosts,
        variables,
        secretNames: [...secretNames],
        auth,
      },
    };
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readEnvironmentsFile(path: string, required: boolean) {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (!required) return undefined;
    throw new ApiPilotError("NOT_FOUND", `Could not read ${path}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ApiPilotError("CONFIG_INVALID", `${path} is not valid YAML`, { cause: error });
  }

  const result = EnvironmentsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiPilotError("CONFIG_INVALID", `${path} is not a valid environments file`, {
      hint: describeIssues(result.error),
    });
  }
  return result.data;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function mergeDeclarations(
  base: EnvironmentDeclaration | undefined,
  override: EnvironmentDeclaration,
): EnvironmentDeclaration {
  if (base === undefined) return override;
  return {
    ...base,
    ...override,
    // Variables merge key-wise so a local file can override one value without
    // restating the environment.
    variables: { ...base.variables, ...override.variables },
    auth: override.auth ?? base.auth,
  };
}

function resolveAuth(
  declaration: EnvironmentDeclaration["auth"],
  variables: ReadonlyMap<string, string>,
): AuthConfig | undefined {
  if (declaration === undefined) return undefined;

  switch (declaration.type) {
    case "none":
      return { type: "none" };
    case "bearer":
      return { type: "bearer", token: interpolate(declaration.token, variables) };
    case "basic":
      return {
        type: "basic",
        username: interpolate(declaration.username, variables),
        password: interpolate(declaration.password, variables),
      };
    case "apikey":
      return {
        type: "apikey",
        name: declaration.name,
        in: declaration.in,
        value: interpolate(declaration.value, variables),
      };
  }
}

/** An explicit list wins; otherwise the baseUrl's host is the only thing allowed. */
function resolveAllowedHosts(
  declaration: EnvironmentDeclaration,
  environmentName: string,
): readonly string[] {
  if (declaration.allowedHosts !== undefined) return declaration.allowedHosts;
  if (declaration.baseUrl === undefined) return [];

  try {
    return [new URL(declaration.baseUrl).hostname];
  } catch (error) {
    throw new ApiPilotError(
      "CONFIG_INVALID",
      `Environment "${environmentName}" has an unparseable baseUrl`,
      { cause: error },
    );
  }
}
