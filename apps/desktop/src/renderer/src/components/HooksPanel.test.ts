import { describe, expect, it } from "vitest";
import type { CommandHookDeclaration } from "@anycode/core";
import { formatHookEvent, formatHookMatcher, formatHookTimeout, groupHooksByEvent } from "./HooksPanel.js";

describe("HooksPanel pure helpers", () => {
  it("formats hook events verbatim for the static config list", () => {
    expect(formatHookEvent("PreToolUse")).toBe("PreToolUse");
    expect(formatHookEvent("UserPromptSubmit")).toBe("UserPromptSubmit");
  });

  it("formats absent matcher and explicit matcher", () => {
    expect(formatHookMatcher(undefined)).toBe("-");
    expect(formatHookMatcher("Write|Edit")).toBe("/Write|Edit/");
  });

  it("formats absent timeout as default", () => {
    expect(formatHookTimeout(undefined)).toBe("default");
    expect(formatHookTimeout(2500)).toBe("2500 ms");
  });
});

// ── group-by-event with counts (P7.25/F3 W2, design §3 W2) ──

function hook(overrides: Partial<CommandHookDeclaration> = {}): CommandHookDeclaration {
  return {
    event: "PreToolUse",
    command: "echo hi",
    ...overrides,
  };
}

describe("groupHooksByEvent", () => {
  it("returns no groups for an empty hook list", () => {
    expect(groupHooksByEvent([])).toEqual([]);
  });

  it("groups hooks under their event with a count matching the group size", () => {
    const hooks = [
      hook({ event: "PreToolUse", command: "a" }),
      hook({ event: "PreToolUse", command: "b" }),
      hook({ event: "Stop", command: "c" }),
    ];
    const groups = groupHooksByEvent(hooks);
    expect(groups).toEqual([
      { event: "PreToolUse", count: 2, hooks: [hooks[0], hooks[1]] },
      { event: "Stop", count: 1, hooks: [hooks[2]] },
    ]);
  });

  it("orders groups by the EVENT_LABELS key order, NOT alphabetically or by first appearance", () => {
    const hooks = [
      hook({ event: "SubagentStop", command: "z" }),
      hook({ event: "UserPromptSubmit", command: "y" }),
      hook({ event: "PreToolUse", command: "x" }),
    ];
    const groups = groupHooksByEvent(hooks);
    // Declared EVENT_LABELS order: PreToolUse, PostToolUse, PostToolUseFailure,
    // UserPromptSubmit, Stop, SubagentStop — alphabetical would put PostToolUse*
    // before PreToolUse and SubagentStop before UserPromptSubmit; neither holds.
    expect(groups.map((g) => g.event)).toEqual(["PreToolUse", "UserPromptSubmit", "SubagentStop"]);
  });

  it("omits events with zero hooks from the grouped result", () => {
    const groups = groupHooksByEvent([hook({ event: "Stop" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.event).toBe("Stop");
  });
});
