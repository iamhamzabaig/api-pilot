import { ApiPilotError } from "../errors.js";

/**
 * `{{name}}` substitution.
 *
 * Two syntaxes exist on purpose and mean different things:
 *   `${env:TOKEN}`  a secret *reference*, resolved once, never rendered back
 *   `{{token}}`     a variable *use*, substituted into a request
 *
 * Keeping them distinct is what lets the redactor know which resolved values
 * are dangerous to print. Collapsing them into one syntax would lose that.
 *
 * Substitution is always single-pass: a value that has been substituted in is
 * never rescanned. A credential containing `{{` is a credential, not a
 * template, and rescanning it would be an injection vector.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function interpolate(template: string, variables: ReadonlyMap<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, rawName: string) => {
    const value = variables.get(rawName);
    if (value === undefined) throw unknownVariable(rawName, variables.keys());
    return value;
  });
}

/**
 * Expands variables that reference other variables, so `interpolate` itself
 * stays a single pass over request text.
 *
 * Resolution is depth-first with a visiting set rather than repeated sweeps:
 * it terminates in one pass per variable, detects cycles exactly, and — unlike
 * a sweep — never rescans text it just substituted in.
 */
export function expandVariables(
  raw: ReadonlyMap<string, string>,
  /**
   * Names whose values are taken literally. Resolved secrets live here: a
   * credential that happens to contain `{{` is not a template.
   */
  frozen: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const resolved = new Map<string, string>();
  const visiting = new Set<string>();

  const resolveOne = (name: string): string => {
    const done = resolved.get(name);
    if (done !== undefined) return done;

    const value = raw.get(name);
    if (value === undefined) throw unknownVariable(name, raw.keys());

    if (frozen.has(name)) {
      resolved.set(name, value);
      return value;
    }

    if (visiting.has(name)) {
      throw new ApiPilotError(
        "CONFIG_INVALID",
        `Variable definitions reference each other in a cycle: ${[...visiting, name].join(" -> ")}`,
        { hint: "A variable cannot expand to itself, directly or through another." },
      );
    }

    visiting.add(name);
    const expanded = value.replace(PLACEHOLDER, (_match, reference: string) =>
      resolveOne(reference),
    );
    visiting.delete(name);

    resolved.set(name, expanded);
    return expanded;
  };

  for (const name of raw.keys()) resolveOne(name);
  return resolved;
}

function unknownVariable(name: string, available: Iterable<string>): ApiPilotError {
  return new ApiPilotError("CONFIG_INVALID", `Unknown variable {{${name}}}`, {
    // Names only. Listing values here would print secrets in an error message.
    hint: `Defined in this environment: ${[...available].join(", ") || "(none)"}.`,
  });
}
