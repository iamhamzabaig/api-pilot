import { z } from "zod";

/**
 * Schema for `.apipilot/environments.yaml`.
 *
 * One map, one concept: every entry under `variables` is either a literal
 * (public, rendered freely) or a `${scheme:arg}` reference (secret, resolved
 * at the HTTP boundary and never rendered). The security distinction falls out
 * of the syntax instead of needing a second map the user must remember to use.
 */

export const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
  z.object({
    type: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal("apikey"),
    name: z.string().min(1),
    in: z.enum(["header", "query"]).default("header"),
    value: z.string().min(1),
  }),
]);

export const ClassificationSchema = z.enum(["safe", "caution", "production"]);

export const EnvironmentSchema = z.object({
  /** Drives the confirmation gate. Defaults to the strictest sensible guess. */
  classification: ClassificationSchema.default("safe"),
  baseUrl: z.string().url().optional(),
  /** Omitted means "derive from baseUrl"; neither means every request is refused. */
  allowedHosts: z.array(z.string().min(1)).optional(),
  variables: z.record(z.string(), z.string()).default({}),
  auth: AuthSchema.optional(),
});

export const EnvironmentsFileSchema = z.object({
  version: z.literal(1).default(1),
  default: z.string().optional(),
  /**
   * Spec documents to index, relative to the workspace root (absolute is
   * allowed for a spec kept outside it). BLUEPRINT §17 put these in a separate
   * `config.yaml`; one array does not justify a second file, a second schema
   * and a second loader, so they live here until something else needs that file.
   */
  specs: z.array(z.string().min(1)).default([]),
  environments: z.record(z.string(), EnvironmentSchema),
});

export type AuthDeclaration = z.infer<typeof AuthSchema>;
export type EnvironmentDeclaration = z.infer<typeof EnvironmentSchema>;
export type EnvironmentsFile = z.infer<typeof EnvironmentsFileSchema>;

/**
 * Variable names that almost always hold a credential. Used to warn when one
 * is given a literal value in a file that is meant to be committed.
 */
const SECRET_NAME_HINTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "credential",
  "authorization",
  "private",
  "bearer",
];

export function looksLikeSecretName(name: string): boolean {
  const normalised = name.toLowerCase().replaceAll(/[^a-z]/g, "");
  return SECRET_NAME_HINTS.some((hint) => normalised.includes(hint.replaceAll(/[^a-z]/g, "")));
}
