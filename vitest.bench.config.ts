import { defineConfig } from "vitest/config";

/**
 * The cold-start budget (NFR N1) runs under its own config because it is the
 * one measurement in the repo that is sensitive to what else is running: with
 * the main suite's workers competing for cores, the same binary measures ~125 ms
 * alone and ~295 ms alongside them. A benchmark sharing a CPU with eighteen
 * test files measures the machine, not the tool.
 */
export default defineConfig({
  test: {
    include: ["tests/bench/**/*.test.ts"],
    fileParallelism: false,
  },
});
