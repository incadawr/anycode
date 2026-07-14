import { describe, expect, it } from "vitest";
import type { HistoryItem } from "@anycode/core";
import { hasDurableTransitionResult } from "./worktree-recovery.js";

function item(message: HistoryItem["message"], id: string): HistoryItem {
  return { id, createdAt: 1, message };
}

describe("hasDurableTransitionResult", () => {
  it("never confirms a new journal from an older same-named success", () => {
    const history: HistoryItem[] = [
      item({ role: "tool", content: [{
        type: "tool_result", toolCallId: "old", toolName: "EnterWorktree", text: "ok", status: "success",
      }] }, "h1"),
      item({ role: "assistant", content: [{
        type: "tool_call", toolCallId: "new", toolName: "EnterWorktree", input: {},
      }] }, "h2"),
    ];
    expect(hasDurableTransitionResult(history, "enter_worktree", "tool", "new")).toBe(false);
  });

  it("confirms only the exact successful result and treats chrome transitions as journal-authoritative", () => {
    const history: HistoryItem[] = [item({ role: "tool", content: [{
      type: "tool_result", toolCallId: "exact", toolName: "ExitWorktree", text: "ok", status: "success",
    }] }, "h1")];
    expect(hasDurableTransitionResult(history, "exit_worktree", "tool", "exact")).toBe(true);
    expect(hasDurableTransitionResult(history, "exit_worktree", "tool", "different")).toBe(false);
    expect(hasDurableTransitionResult([], "exit_worktree", "tool", undefined)).toBe(false);
    expect(hasDurableTransitionResult([], "exit_worktree", "chrome", undefined)).toBe(true);
  });
});
