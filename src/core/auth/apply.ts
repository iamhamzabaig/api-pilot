import { ApiPilotError } from "../errors.js";
import type { Redactor } from "../redact/redactor.js";
import type { HttpRequest } from "../request/types.js";

/**
 * Turns a declared auth scheme into headers or query parameters.
 *
 * Every credential that reaches this module is registered with the redactor,
 * including derived forms: a Basic auth blob is base64 of `user:pass`, which
 * no amount of redacting `pass` alone would catch.
 */

export type AuthConfig =
  | { readonly type: "none" }
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "basic"; readonly username: string; readonly password: string }
  | {
      readonly type: "apikey";
      readonly name: string;
      readonly in: "header" | "query";
      readonly value: string;
    };

export function applyAuth(
  request: HttpRequest,
  auth: AuthConfig | undefined,
  redactor: Redactor,
): HttpRequest {
  if (auth === undefined || auth.type === "none") return request;

  switch (auth.type) {
    case "bearer": {
      redactor.add(auth.token);
      return withHeader(request, "authorization", `Bearer ${auth.token}`);
    }
    case "basic": {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64");
      redactor.add(auth.password);
      // The combined blob is its own secret; redacting the password alone
      // would leave the credential readable on the wire and in logs.
      redactor.add(encoded);
      return withHeader(request, "authorization", `Basic ${encoded}`);
    }
    case "apikey": {
      redactor.add(auth.value);
      if (auth.in === "header") return withHeader(request, auth.name, auth.value);
      return withQueryParam(request, auth.name, auth.value);
    }
  }
}

function withHeader(request: HttpRequest, name: string, value: string): HttpRequest {
  const headers: Record<string, string> = {};
  for (const [key, existing] of Object.entries(request.headers ?? {})) {
    headers[key] = existing;
  }
  // An explicit header on the request wins: the caller was more specific
  // than the environment's default auth.
  if (Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())) {
    return request;
  }
  headers[name] = value;
  return { ...request, headers };
}

function withQueryParam(request: HttpRequest, name: string, value: string): HttpRequest {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    throw new ApiPilotError("INVALID_REQUEST", `Cannot attach an API key to ${request.url}`, {
      cause: error,
    });
  }
  if (url.searchParams.has(name)) return request;
  url.searchParams.set(name, value);
  return { ...request, url: url.toString() };
}
