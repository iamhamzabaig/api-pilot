import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Timing-sensitive; runs alone via `pnpm run bench`. See vitest.bench.config.ts.
    exclude: ["tests/bench/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      // The engine is what has silent failure modes — a leaked secret, an
      // oversized digest. The CLI is a thin shell over it and is covered by its
      // own integration suite, so the gate is aimed where it buys something.
      include: ["src/core/**/*.ts"],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
