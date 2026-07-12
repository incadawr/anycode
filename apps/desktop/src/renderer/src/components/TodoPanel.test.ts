/**
 * Pure-logic tests for TodoPanel's F1b selector/formatter (design/slice-
 * P7.11-cut.md §1/§3.W1). Same `.test.ts`-only rationale as ToolCallCard.
 * test.ts: no jsdom in this package's vitest config, so the exported pure
 * functions are covered directly instead of through DOM rendering.
 */
import { describe, expect, it } from "vitest";
import type { TranscriptBlock } from "../store.js";
import { progressLabel, selectCurrentTodos, shouldResetCompletedExpanded } from "./TodoPanel.js";
import type { TodoItemView } from "./ToolCallCard.js";

/** Minimal tool_call block fixture — only the fields selectCurrentTodos reads vary per test. */
function todoBlock(id: string, status: string, input: unknown): TranscriptBlock {
  return {
    kind: "tool_call",
    id,
    toolCallId: `${id}-call`,
    toolName: "TodoWrite",
    input,
    status,
    modelText: null,
    snapshots: { before: null, after: null },
    subagent: null,
    workflow: null,
  } as TranscriptBlock;
}

function otherBlock(id: string): TranscriptBlock {
  return { kind: "user_text", id, text: "hi" };
}

const TWO_ITEMS = { todos: [{ content: "a", status: "pending" }, { content: "b", status: "completed" }] };
const ONE_DONE = { todos: [{ content: "only", status: "completed" }] };

describe("selectCurrentTodos", () => {
  it("returns null for an empty transcript", () => {
    expect(selectCurrentTodos([])).toBeNull();
  });

  it("returns null when there is no TodoWrite call", () => {
    expect(selectCurrentTodos([otherBlock("1")])).toBeNull();
  });

  it("picks the last completed TodoWrite call when two exist (replace-all semantics)", () => {
    const transcript = [todoBlock("t1", "success", TWO_ITEMS), todoBlock("t2", "success", ONE_DONE)];
    const result = selectCurrentTodos(transcript);
    expect(result?.sourceBlockId).toBe("t2");
    expect(result?.todos).toEqual([{ content: "only", status: "completed" }]);
  });

  it("ignores a proposed TodoWrite call", () => {
    const transcript = [todoBlock("t1", "success", ONE_DONE), todoBlock("t2", "proposed", TWO_ITEMS)];
    const result = selectCurrentTodos(transcript);
    expect(result?.sourceBlockId).toBe("t1");
  });

  it("ignores a running TodoWrite call", () => {
    const transcript = [todoBlock("t1", "success", ONE_DONE), todoBlock("t2", "running", TWO_ITEMS)];
    expect(selectCurrentTodos(transcript)?.sourceBlockId).toBe("t1");
  });

  it("ignores a failed TodoWrite call (error status)", () => {
    const transcript = [todoBlock("t1", "success", ONE_DONE), todoBlock("t2", "error", TWO_ITEMS)];
    expect(selectCurrentTodos(transcript)?.sourceBlockId).toBe("t1");
  });

  it("falls back to the previous valid call when the last TodoWrite has malformed input", () => {
    const transcript = [todoBlock("t1", "success", ONE_DONE), todoBlock("t2", "success", { todos: "not-an-array" })];
    const result = selectCurrentTodos(transcript);
    expect(result?.sourceBlockId).toBe("t1");
  });

  it("returns null when the only TodoWrite call is malformed", () => {
    const transcript = [todoBlock("t1", "success", { nope: true })];
    expect(selectCurrentTodos(transcript)).toBeNull();
  });

  it("returns an honest empty list for a valid empty replace-all", () => {
    const transcript = [todoBlock("t1", "success", { todos: [] })];
    const result = selectCurrentTodos(transcript);
    expect(result?.todos).toEqual([]);
    expect(result?.sourceBlockId).toBe("t1");
  });

  it("ignores non-TodoWrite tool_call blocks", () => {
    const other: TranscriptBlock = {
      kind: "tool_call",
      id: "b1",
      toolCallId: "b1-call",
      toolName: "Bash",
      input: { todos: [{ content: "x", status: "pending" }] },
      status: "success",
      modelText: null,
      snapshots: { before: null, after: null },
      subagent: null,
      workflow: null,
    };
    expect(selectCurrentTodos([other])).toBeNull();
  });
});

describe("progressLabel", () => {
  it("counts completed vs total", () => {
    const todos: TodoItemView[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ];
    expect(progressLabel(todos)).toBe("Progress 1/3");
  });

  it("reports 0/0 for an empty list", () => {
    expect(progressLabel([])).toBe("Progress 0/0");
  });

  it("reports N/N when every item is completed", () => {
    const todos: TodoItemView[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ];
    expect(progressLabel(todos)).toBe("Progress 2/2");
  });
});

describe("shouldResetCompletedExpanded", () => {
  it("resets when the source block id changes to a different block", () => {
    expect(shouldResetCompletedExpanded("t1", "t2")).toBe(true);
  });

  it("does not reset when the source block id is unchanged", () => {
    expect(shouldResetCompletedExpanded("t1", "t1")).toBe(false);
  });

  it("resets when there was no previous selection", () => {
    expect(shouldResetCompletedExpanded(null, "t1")).toBe(true);
  });

  it("does not reset when the next selection is null (nothing selected)", () => {
    expect(shouldResetCompletedExpanded("t1", null)).toBe(false);
  });

  it("does not reset when both are null", () => {
    expect(shouldResetCompletedExpanded(null, null)).toBe(false);
  });
});
