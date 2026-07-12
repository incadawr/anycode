import { describe, expect, it } from "vitest";
import type { AlwaysAllowRule } from "../../shared/settings.js";
import { groupAlwaysAllowRules } from "./permission-rules.js";

describe("groupAlwaysAllowRules", () => {
  it("returns one group per distinct exact toolName", () => {
    const rules: AlwaysAllowRule[] = [
      { toolName: "Bash", pattern: "git *" },
      { toolName: "Read" },
    ];
    expect(groupAlwaysAllowRules(rules)).toEqual([
      { toolName: "Bash", rules: [{ toolName: "Bash", pattern: "git *" }] },
      { toolName: "Read", rules: [{ toolName: "Read" }] },
    ]);
  });

  it("groups duplicate tool names together, preserving stored (in-group) order", () => {
    const rules: AlwaysAllowRule[] = [
      { toolName: "Bash", pattern: "git *" },
      { toolName: "Bash", pattern: "npm *" },
      { toolName: "Bash" },
    ];
    const groups = groupAlwaysAllowRules(rules);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      toolName: "Bash",
      rules: [{ toolName: "Bash", pattern: "git *" }, { toolName: "Bash", pattern: "npm *" }, { toolName: "Bash" }],
    });
  });

  it("orders groups by first-appearance, not alphabetically", () => {
    const rules: AlwaysAllowRule[] = [
      { toolName: "WebFetch" },
      { toolName: "Bash", pattern: "git *" },
      { toolName: "WebFetch", pattern: "https://example.com/*" },
      { toolName: "Bash", pattern: "npm *" },
    ];
    expect(groupAlwaysAllowRules(rules).map((g) => g.toolName)).toEqual(["WebFetch", "Bash"]);
  });

  it("keeps a pattern-less rule in its group untouched (no synthetic pattern injected)", () => {
    const rules: AlwaysAllowRule[] = [{ toolName: "Edit" }];
    const groups = groupAlwaysAllowRules(rules);
    expect(groups[0]?.rules[0]?.pattern).toBeUndefined();
  });

  it("never normalizes toolName — a differently-cased name is its own group", () => {
    const rules: AlwaysAllowRule[] = [{ toolName: "Bash" }, { toolName: "bash" }];
    expect(groupAlwaysAllowRules(rules).map((g) => g.toolName)).toEqual(["Bash", "bash"]);
  });

  it("returns an empty array for no rules", () => {
    expect(groupAlwaysAllowRules([])).toEqual([]);
  });
});
