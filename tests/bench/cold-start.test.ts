import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * NFR N1: the CLI starts in under 200 ms at the 95th percentile.
 *
 * This is the number that decides whether the tool feels like `curl` or like a
 * Java CLI, and it is the one ADR-0001 names as the revisit trigger for a Go
 * port — so it is measured, not assumed. It is also the reason `src/cli/index.ts`
 * dispatches through dynamic imports and parses with `node:util.parseArgs`:
 * adding a CLI framework would show up here first.
 *
 * Measured against the built output, so CI must build before it runs tests.
 */

const run = promisify(execFile);

const CLI = join(process.cwd(), "dist", "cli", "index.js");
const BUDGET_MS = 200;
/**
 * Enough samples that the 95th percentile is genuinely a percentile. At 15 the
 * nearest-rank index lands on the largest sample, which turns this into "no
 * spawn ever exceeded the budget" — a much harsher claim than NFR N1 makes, and
 * one that fails on any unlucky scheduler hiccup on a shared CI runner.
 */
const SAMPLES = 40;

const built = existsSync(CLI);

/**
 * A clean environment for the measured child. Under `--coverage` the runner
 * exports `NODE_V8_COVERAGE`, which the child inherits and honours — that
 * writes a coverage file per spawn and roughly triples the number, measuring
 * the instrumentation rather than the CLI.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const { NODE_V8_COVERAGE, NODE_OPTIONS, ...rest } = process.env;
  return rest;
}

describe.skipIf(!built)("cold start", () => {
  it(`runs --version in under ${BUDGET_MS} ms at p95`, async () => {
    // Warm the module cache and the filesystem so the first sample is not
    // measuring the disk.
    await run(process.execPath, [CLI, "--version"], { env: cleanEnv() });

    const timings: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const started = performance.now();
      const { stdout } = await run(process.execPath, [CLI, "--version"], { env: cleanEnv() });
      timings.push(performance.now() - started);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }

    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)];
    const p50 = timings[Math.floor(timings.length / 2)];

    // Printed unconditionally: a passing number that has crept from 90 ms to
    // 190 ms is the interesting case, and an assertion alone would hide it.
    console.log(
      `cold start: p50 ${p50?.toFixed(1)} ms, p95 ${p95?.toFixed(1)} ms over ${SAMPLES} runs`,
    );

    expect(p95).toBeLessThan(BUDGET_MS);
  }, 60_000);
});
