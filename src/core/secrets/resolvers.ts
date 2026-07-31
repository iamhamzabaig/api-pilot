import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ApiPilotError } from "../errors.js";

/**
 * Secrets are referenced, never written down. A committed `environments.yaml`
 * holds `${env:STRIPE_KEY}`; the value itself lives wherever the developer
 * already keeps it.
 *
 * This is the one interface in the codebase with no implementation yet in
 * sight for some of its cases — justified because three are already known
 * (env, file, and the keychain/vault resolvers scheduled for v1) and the shape
 * is a two-method contract, not a framework.
 */
export interface SecretResolver {
  /** The `${<scheme>:...}` prefix this resolver claims. */
  readonly scheme: string;
  resolve(argument: string, context: ResolverContext): Promise<string>;
}

export interface ResolverContext {
  /** Workspace root, so `${file:./x}` means the same thing from any cwd. */
  readonly baseDir: string;
}

const REFERENCE = /^\$\{([a-z][a-z0-9]*):([^}]*)\}$/i;

export interface SecretReference {
  readonly scheme: string;
  readonly argument: string;
}

/** Returns the parsed reference, or undefined when the value is a plain literal. */
export function parseSecretReference(value: string): SecretReference | undefined {
  const match = REFERENCE.exec(value.trim());
  if (match === null) return undefined;
  return { scheme: (match[1] as string).toLowerCase(), argument: match[2] as string };
}

export const envResolver: SecretResolver = {
  scheme: "env",
  async resolve(argument) {
    const value = process.env[argument];
    if (value === undefined || value === "") {
      throw new ApiPilotError("SECRET_UNRESOLVED", `Environment variable ${argument} is not set`, {
        hint: `Export ${argument}, or point the reference somewhere else.`,
      });
    }
    return value;
  },
};

export const fileResolver: SecretResolver = {
  scheme: "file",
  async resolve(argument, context) {
    const path = isAbsolute(argument) ? argument : resolve(context.baseDir, argument);
    try {
      // Trailing newlines are near-universal in secret files and never intended.
      return (await readFile(path, "utf8")).trim();
    } catch (error) {
      throw new ApiPilotError("SECRET_UNRESOLVED", `Could not read secret file ${argument}`, {
        cause: error,
        hint: "Check the path is relative to the workspace root and the file exists.",
      });
    }
  },
};

export const DEFAULT_RESOLVERS: readonly SecretResolver[] = [envResolver, fileResolver];

export function resolverFor(
  scheme: string,
  resolvers: readonly SecretResolver[] = DEFAULT_RESOLVERS,
): SecretResolver {
  const resolver = resolvers.find((r) => r.scheme === scheme);
  if (resolver === undefined) {
    throw new ApiPilotError("CONFIG_INVALID", `Unknown secret scheme "${scheme}"`, {
      hint: `Available: ${resolvers.map((r) => r.scheme).join(", ")}.`,
    });
  }
  return resolver;
}
