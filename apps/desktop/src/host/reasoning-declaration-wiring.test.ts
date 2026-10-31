/**
 * Production-wiring test for the host's effort-declaration plumbing.
 *
 * `host/index.ts` is NOT importable in a test (it touches `process.parentPort`
 * at module scope — see `index.test.ts`'s header), so this is a SOURCE scan,
 * the same fallback `index.prompt-cache-wiring.test.ts` uses. The thing under
 * test is the POSITION of one spread: the connection's declared effort
 * vocabulary (ANYCODE_EFFORT_LEVELS, parsed into `envConfig.effortLevels`) must
 * reach EVERY port `modelPortFactory` builds, and it must stay CONDITIONAL so
 * an undeclared connection keeps today's request bytes.
 *
 * The wire half lives in `packages/core/src/provider/custom-anthropic-effort-wire.test.ts`
 * (real SDK, real POST bodies): a custom endpoint gets `output_config.effort`
 * only when its connection declared both xhigh and max, and otherwise gets
 * distinct thinking budgets with no field it never advertised.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(resolve(here, "index.ts"), "utf8");

const SPREAD = "...(envConfig.effortLevels !== undefined ? { declaredEffortLevels: envConfig.effortLevels } : {}),";

describe("host/index.ts — declared effort vocabulary wiring", () => {
  it("forwards the declaration conditionally, exactly once", () => {
    expect(indexSource.split(SPREAD).length - 1).toBe(1);
  });

  it("puts the spread inside the modelPortFactory closure, not on a single port instance", () => {
    const factoryStart = indexSource.indexOf("const modelPortFactory = (m: string): ModelPort =>");
    const factoryEnd = indexSource.indexOf("const switchableModelPort = new SwitchableModelPort(", factoryStart);
    expect(factoryStart).toBeGreaterThan(0);
    expect(factoryEnd).toBeGreaterThan(factoryStart);
    const factoryBody = indexSource.slice(factoryStart, factoryEnd);
    expect(factoryBody).toContain(SPREAD);
    expect(factoryBody).toContain("new AiSdkModelPort(");
  });

  it("never sends a declaration the connection did not declare", () => {
    // No defaulted/empty array and no unconditional assignment: an undeclared
    // connection must stay byte-identical (no `output_config.effort` at all).
    expect(indexSource).not.toContain("declaredEffortLevels: []");
    expect(indexSource.split("declaredEffortLevels").length - 1).toBe(1);
  });
});
