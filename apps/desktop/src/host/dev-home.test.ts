/**
 * Unit tests for resolveExtensionsHomeOverride (host/dev-home.ts,
 * design/slice-P7.21-cut.md dispatch-parity fix). Pure predicate, no fs/electron.
 */

import { describe, expect, it } from "vitest";
import { resolveExtensionsHomeOverride } from "./dev-home.js";

describe("resolveExtensionsHomeOverride", () => {
  it("honors an absolute override when automation is on", () => {
    const result = resolveExtensionsHomeOverride({
      ANYCODE_AUTOMATION: "1",
      ANYCODE_SUBAGENTS_HOME: "/tmp/anycode-fixture-home",
    });
    expect(result).toBe("/tmp/anycode-fixture-home");
  });

  it("trims surrounding whitespace from the override path", () => {
    const result = resolveExtensionsHomeOverride({
      ANYCODE_AUTOMATION: "1",
      ANYCODE_SUBAGENTS_HOME: "  /tmp/anycode-fixture-home  ",
    });
    expect(result).toBe("/tmp/anycode-fixture-home");
  });

  const nullCases: Array<[string, NodeJS.ProcessEnv]> = [
    ["automation unset", { ANYCODE_SUBAGENTS_HOME: "/tmp/x" }],
    ["automation = 0", { ANYCODE_AUTOMATION: "0", ANYCODE_SUBAGENTS_HOME: "/tmp/x" }],
    ["automation = true (not the literal \"1\")", { ANYCODE_AUTOMATION: "true", ANYCODE_SUBAGENTS_HOME: "/tmp/x" }],
    ["home var unset", { ANYCODE_AUTOMATION: "1" }],
    ["home var blank", { ANYCODE_AUTOMATION: "1", ANYCODE_SUBAGENTS_HOME: "" }],
    ["home var whitespace-only", { ANYCODE_AUTOMATION: "1", ANYCODE_SUBAGENTS_HOME: "   " }],
    ["home var relative", { ANYCODE_AUTOMATION: "1", ANYCODE_SUBAGENTS_HOME: "relative/fixture-home" }],
  ];

  it.each(nullCases)("returns null: %s", (_label, env) => {
    expect(resolveExtensionsHomeOverride(env)).toBeNull();
  });
});
