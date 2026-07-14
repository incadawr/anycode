import { describe, expect, it, vi } from "vitest";
import {
  enterWorktreeInputSchema,
  enterWorktreeTool,
  exitWorktreeInputSchema,
  exitWorktreeTool,
} from "./worktrees.js";
import type { ToolContext } from "../types/tools.js";
import type { WorkspaceTransition, WorktreeControlPort } from "../ports/worktrees.js";

const transition: WorkspaceTransition = {
  kind: "enter_worktree",
  projectRoot: "/repo",
  fromWorkspace: "/repo",
  toWorkspace: "/repo/.anycode/worktrees/task-5",
  worktree: {
    id: "task-5",
    path: "/repo/.anycode/worktrees/task-5",
    branch: "anycode-wt/task-5",
    baseRef: "HEAD",
    ownedByAnyCode: true,
  },
};

function context(worktrees?: WorktreeControlPort): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: new AbortController().signal,
    cwd: "/repo",
    ports: {},
    worktrees,
  } as ToolContext;
}

describe("worktree terminal-control tools", () => {
  it("uses PascalCase, stays solo, and is not part of the default registry", async () => {
    expect(enterWorktreeTool.metadata).toMatchObject({
      name: "EnterWorktree",
      concurrentSafe: false,
      terminalControl: true,
    });
    expect(exitWorktreeTool.metadata).toMatchObject({
      name: "ExitWorktree",
      concurrentSafe: false,
      terminalControl: true,
    });

    const { createDefaultToolRegistry } = await import("./registry.js");
    const registry = createDefaultToolRegistry();
    expect(registry.has("EnterWorktree")).toBe(false);
    expect(registry.has("ExitWorktree")).toBe(false);
  });

  it("validates mutually exclusive create/existing inputs and defaults cleanup to auto", () => {
    expect(
      enterWorktreeInputSchema.safeParse({ name: "task-5", existing: "/repo/other" }).success,
    ).toBe(false);
    expect(exitWorktreeInputSchema.parse({})).toEqual({ cleanup: "auto" });
  });

  it("returns the host transition as terminal control and forwards abort", async () => {
    const enter = vi.fn<WorktreeControlPort["enter"]>(async () => ({ ok: true, transition }));
    const worktrees: WorktreeControlPort = {
      enter,
      exit: async () => ({ ok: false, error: "not active" }),
    };

    const result = await enterWorktreeTool.handler({ name: "task-5" }, context(worktrees));

    expect(result).toMatchObject({
      ok: true,
      control: { type: "workspace_transition", transition },
    });
    expect(enter).toHaveBeenCalledWith(
      { name: "task-5" },
      { signal: expect.any(AbortSignal), toolCallId: "call-1" },
    );
  });

  it("fails closed without a host port", async () => {
    const result = await exitWorktreeTool.handler({ cleanup: "keep" }, context());
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("unavailable");
  });

  it("marks only cleanup=remove as high-risk destructive and approval-required", () => {
    expect(exitWorktreeTool.resolveMetadata?.({ cleanup: "auto" })).toMatchObject({
      destructive: false,
      riskLevel: "medium",
      needsApproval: false,
    });
    expect(exitWorktreeTool.resolveMetadata?.({ cleanup: "remove" })).toMatchObject({
      destructive: true,
      riskLevel: "high",
      needsApproval: true,
    });
  });
});
