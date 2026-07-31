import { ApiPilotError } from "../core/errors.js";

/**
 * Argument coercion shared by the command modules. Kept out of `output.ts`
 * because that file is on the `--version` path and must not import core.
 */

export function parseNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ApiPilotError("INVALID_REQUEST", `${flag} expects a number, got "${raw}"`);
  }
  return value;
}
