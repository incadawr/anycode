/**
 * GitHub #15 — production-wiring test for the host's prompt-cache plumbing.
 *
 * `host/index.ts` is NOT importable in a test (it touches `process.parentPort`
 * at module scope — see `index.test.ts`'s header). The established fallback for
 * "the wiring cannot silently drop this" is a SOURCE scan of the real file
 * (`builtin-skills.test.ts` pins `buildHostBuiltinSkills` that way), because the
 * thing under test is exactly the position of one spread: it must live inside
 * the `modelPortFactory` closure so EVERY port that factory builds — the first
 * model, every hot swap, the ask-zone classifier, inline agents and the
 * switchable port titling/compaction capture — carries the parsed policy, and
 * it must stay CONDITIONAL so an Off connection keeps today's request bytes.
 *
 * The behavioural half of this contract is covered by
 * `packages/core/src/provider/prompt-cache-wire.integration.test.ts` (real SDK,
 * real HTTP bodies) and `host-env.test.ts` (the env that feeds this field).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(resolve(here, "index.ts"), "utf8");

const SPREAD = "...(envConfig.promptCache !== undefined ? { promptCache: envConfig.promptCache } : {}),";

describe("host/index.ts — prompt-cache wiring (GitHub #15)", () => {
  it("forwards the parsed policy conditionally, exactly once", () => {
    const occurrences = indexSource.split(SPREAD).length - 1;
    // Exactly one: a second copy would mean one port family was patched twice,
    // and zero would mean the cache policy silently never reaches any request.
    expect(occurrences).toBe(1);
  });

  it("puts the spread inside the modelPortFactory closure, not on a single port instance", () => {
    const factoryStart = indexSource.indexOf("const modelPortFactory = (m: string): ModelPort =>");
    const factoryEnd = indexSource.indexOf("const switchableModelPort = new SwitchableModelPort(", factoryStart);
    expect(factoryStart).toBeGreaterThan(0);
    expect(factoryEnd).toBeGreaterThan(factoryStart);
    const factoryBody = indexSource.slice(factoryStart, factoryEnd);
    expect(factoryBody).toContain(SPREAD);
    // The same factory builds the switchable port and every hot-swapped /
    // classifier / inline-agent port, so the body is the right scope.
    expect(factoryBody).toContain("new AiSdkModelPort(");
  });

  it("keeps Off as absence rather than sending a disabled option object", () => {
    // The spread is the only prompt-cache reference on the host side; no
    // `mode:"off"` literal and no unconditional `promptCache: {...}` default.
    const references = indexSource.split("promptCache").length - 1;
    expect(references).toBe(3); // the three mentions inside the ONE conditional spread
    expect(indexSource).not.toContain('mode: "off"');
  });
});
