import { describe, expect, it } from "vitest";
import type { ApiPilotError } from "../../src/core/errors.js";
import { expandVariables, interpolate } from "../../src/core/vars/interpolate.js";

const vars = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("interpolate", () => {
  it("substitutes, tolerating inner whitespace", () => {
    const v = vars({ host: "api.test", version: "v2" });
    expect(interpolate("https://{{host}}/{{ version }}/users", v)).toBe(
      "https://api.test/v2/users",
    );
  });

  it("leaves text without placeholders alone", () => {
    expect(interpolate("nothing here", vars({}))).toBe("nothing here");
  });

  // The error lists names, never values. An error that helpfully printed the
  // variable map would print secrets.
  it("names the unknown variable without leaking any values", () => {
    const error = (() => {
      try {
        interpolate("{{missing}}", vars({ token: "sk_live_supersecret" }));
        return undefined;
      } catch (e) {
        return e as ApiPilotError;
      }
    })();

    expect(error?.code).toBe("CONFIG_INVALID");
    expect(error?.message).toContain("missing");
    expect(`${error?.message} ${error?.hint}`).not.toContain("sk_live_supersecret");
    expect(error?.hint).toContain("token");
  });
});

describe("expandVariables", () => {
  it("resolves variables defined in terms of others", () => {
    const out = expandVariables(vars({ base: "https://{{host}}", host: "api.test", n: "1" }));
    expect(out.get("base")).toBe("https://api.test");
  });

  it("resolves a chain several levels deep", () => {
    const out = expandVariables(vars({ a: "{{b}}", b: "{{c}}", c: "end" }));
    expect(out.get("a")).toBe("end");
  });

  it("rejects a cycle instead of spinning", () => {
    const error = (() => {
      try {
        expandVariables(vars({ a: "{{b}}", b: "{{a}}" }));
        return undefined;
      } catch (e) {
        return e as ApiPilotError;
      }
    })();
    expect(error?.code).toBe("CONFIG_INVALID");
  });

  // A resolved credential is a value, not a template. One that happens to
  // contain `{{` must survive untouched.
  it("leaves frozen entries verbatim", () => {
    const out = expandVariables(
      vars({ token: "weird{{value}}secret", url: "https://x/{{token}}" }),
      new Set(["token"]),
    );
    expect(out.get("token")).toBe("weird{{value}}secret");
    expect(out.get("url")).toBe("https://x/weird{{value}}secret");
  });
});
