import { describe, expect, it } from "vitest";
import type { ApiPilotError } from "../../src/core/errors.js";
import {
  assertRequestAllowed,
  isHostAllowed,
  type PolicyEnvironment,
} from "../../src/core/policy/policy.js";

function env(overrides: Partial<PolicyEnvironment> = {}): PolicyEnvironment {
  return {
    name: "test",
    classification: "safe",
    allowedHosts: ["api.example.com"],
    ...overrides,
  };
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as ApiPilotError).code;
  }
}

describe("isHostAllowed", () => {
  it("matches exactly", () => {
    expect(isHostAllowed("api.example.com", ["api.example.com"])).toBe(true);
    expect(isHostAllowed("evil.com", ["api.example.com"])).toBe(false);
  });

  it("matches subdomains for a dotted or starred entry", () => {
    for (const entry of [".example.com", "*.example.com"]) {
      expect(isHostAllowed("api.example.com", [entry])).toBe(true);
      expect(isHostAllowed("example.com", [entry])).toBe(true);
      expect(isHostAllowed("api.example.com.evil.net", [entry])).toBe(false);
    }
  });

  // The reason a general glob is not supported: `api*.example.com` reads as
  // safe but a careless entry like `api*` would match `api.evil.com`.
  it("does not treat a prefix as a wildcard", () => {
    expect(isHostAllowed("api.evil.com", ["api"])).toBe(false);
    expect(isHostAllowed("notexample.com", ["example.com"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isHostAllowed("API.Example.COM", ["api.example.com"])).toBe(true);
  });
});

describe("assertRequestAllowed", () => {
  const url = (raw: string) => new URL(raw);

  it("allows a listed host", () => {
    expect(() =>
      assertRequestAllowed(url("https://api.example.com/x"), "GET", env(), { confirmed: false }),
    ).not.toThrow();
  });

  it("blocks an unlisted host", () => {
    expect(
      codeOf(() =>
        assertRequestAllowed(url("https://evil.com/x"), "GET", env(), { confirmed: false }),
      ),
    ).toBe("POLICY_BLOCKED");
  });

  it("blocks everything when no hosts are configured", () => {
    expect(
      codeOf(() =>
        assertRequestAllowed(url("https://api.example.com/x"), "GET", env({ allowedHosts: [] }), {
          confirmed: false,
        }),
      ),
    ).toBe("POLICY_BLOCKED");
  });

  it("requires confirmation for a mutation against production", () => {
    const production = env({ classification: "production" });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        codeOf(() =>
          assertRequestAllowed(url("https://api.example.com/x"), method, production, {
            confirmed: false,
          }),
        ),
        method,
      ).toBe("CONFIRMATION_REQUIRED");
    }
  });

  it("lets a confirmed mutation through", () => {
    expect(() =>
      assertRequestAllowed(
        url("https://api.example.com/x"),
        "DELETE",
        env({ classification: "production" }),
        { confirmed: true },
      ),
    ).not.toThrow();
  });

  it("never gates a read-only method", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(() =>
        assertRequestAllowed(
          url("https://api.example.com/x"),
          method,
          env({ classification: "production" }),
          { confirmed: false },
        ),
      ).not.toThrow();
    }
  });

  it("does not gate mutations outside production", () => {
    for (const classification of ["safe", "caution"] as const) {
      expect(() =>
        assertRequestAllowed(url("https://api.example.com/x"), "DELETE", env({ classification }), {
          confirmed: false,
        }),
      ).not.toThrow();
    }
  });
});
