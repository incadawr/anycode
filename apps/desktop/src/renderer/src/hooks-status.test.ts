import { describe, expect, it } from "vitest";
import type { CommandHookDeclaration } from "@anycode/core";
import { formatEnvironmentHooksDetail } from "./hooks-status.js";

function hook(overrides: Partial<CommandHookDeclaration> = {}): CommandHookDeclaration {
  return {
    event: "PreToolUse",
    command: "echo hi",
    ...overrides,
  };
}

describe("formatEnvironmentHooksDetail", () => {
  it("renders 'None' for an empty hook list", () => {
    expect(formatEnvironmentHooksDetail([])).toBe("None");
  });

  it("uses the singular 'hook' for a single declaration", () => {
    expect(formatEnvironmentHooksDetail([hook()])).toBe("1 hook (PreToolUse 1)");
  });

  it("counts hooks and groups per event", () => {
    const hooks = [
      hook({ event: "PreToolUse" }),
      hook({ event: "PostToolUse", command: "b" }),
      hook({ event: "PostToolUse", command: "c" }),
    ];
    expect(formatEnvironmentHooksDetail(hooks)).toBe("3 hooks (PreToolUse 1, PostToolUse 2)");
  });

  it("follows groupHooksByEvent's stable event order, not input order", () => {
    const hooks = [
      hook({ event: "SubagentStop" }),
      hook({ event: "UserPromptSubmit" }),
      hook({ event: "PreToolUse" }),
    ];
    // EVENT_LABELS key order: PreToolUse, PostToolUse, ..., UserPromptSubmit, Stop, SubagentStop.
    expect(formatEnvironmentHooksDetail(hooks)).toBe("3 hooks (PreToolUse 1, UserPromptSubmit 1, SubagentStop 1)");
  });

  it("groups a duplicate event into one group with its count", () => {
    const hooks = [hook({ event: "Stop", command: "a" }), hook({ event: "Stop", command: "b" })];
    expect(formatEnvironmentHooksDetail(hooks)).toBe("2 hooks (Stop 2)");
  });
});
