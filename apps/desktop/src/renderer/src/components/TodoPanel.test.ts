/**
 * Pure-logic tests for TodoPanel's F1b selector/formatter (design/slice-
 * P7.11-cut.md §1/§3.W1). Same `.test.ts`-only rationale as ToolCallCard.
 * test.ts: no jsdom in this package's vitest config, so the exported pure
 * functions are covered directly instead of through DOM rendering.
 */
import { describe, expect, it } from "vitest";
import type { TranscriptBlock } from "../store.js";
import {
  TODO_STALE_TOOL_CALLS,
  isPlanPossiblyStale,
  progressLabel,
  selectCurrentTodos,
  shouldResetCompletedExpanded,
  staleHint,
} from "./TodoPanel.js";
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

/** Minimal non-TodoWrite tool_call fixture (Taskana 4665 staleness counting). */
function bashBlock(id: string, status: string = "success"): TranscriptBlock {
  return {
    kind: "tool_call",
    id,
    toolCallId: `${id}-call`,
    toolName: "Bash",
    input: { command: "ls" },
    status,
    modelText: null,
    snapshots: { before: null, after: null },
    subagent: null,
    workflow: null,
  } as TranscriptBlock;
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

  it("counts tool_call blocks after the source block (user_text and pre-source blocks excluded)", () => {
    const transcript = [
      bashBlock("pre1"),
      otherBlock("u1"),
      todoBlock("t1", "success", TWO_ITEMS),
      otherBlock("u2"),
      bashBlock("b1"),
      bashBlock("b2"),
    ];
    const result = selectCurrentTodos(transcript);
    expect(result?.sourceBlockId).toBe("t1");
    expect(result?.toolCallsSince).toBe(2);
  });

  it("counts tool_call blocks of any status, including failed ones", () => {
    const transcript = [
      todoBlock("t1", "success", TWO_ITEMS),
      bashBlock("b1"),
      bashBlock("b2", "error"),
      bashBlock("b3", "running"),
    ];
    expect(selectCurrentTodos(transcript)?.toolCallsSince).toBe(3);
  });
});

describe("isPlanPossiblyStale / staleHint (Taskana 4665)", () => {
  function transcriptWith(callsAfter: number, input = TWO_ITEMS): TranscriptBlock[] {
    return [todoBlock("t1", "success", input), ...Array.from({ length: callsAfter }, (_, i) => bashBlock(`b${i}`))];
  }

  it("flags at 10 tool calls with an open item, not at 9", () => {
    expect(TODO_STALE_TOOL_CALLS).toBe(10);
    expect(isPlanPossiblyStale(selectCurrentTodos(transcriptWith(9))!)).toBe(false);
    expect(isPlanPossiblyStale(selectCurrentTodos(transcriptWith(10))!)).toBe(true);
  });

  it("never flags when every item is completed", () => {
    expect(isPlanPossiblyStale(selectCurrentTodos(transcriptWith(10, ONE_DONE))!)).toBe(false);
  });

  it("a newer successful TodoWrite resets the count to 0", () => {
    const transcript = [...transcriptWith(12), todoBlock("t2", "success", TWO_ITEMS)];
    const result = selectCurrentTodos(transcript);
    expect(result?.sourceBlockId).toBe("t2");
    expect(result?.toolCallsSince).toBe(0);
    expect(isPlanPossiblyStale(result!)).toBe(false);
  });

  it("staleHint returns null when fresh and a descriptive string when stale", () => {
    expect(staleHint(selectCurrentTodos(transcriptWith(3))!)).toBeNull();
    const hint = staleHint(selectCurrentTodos(transcriptWith(10))!);
    expect(hint).toContain("10 tool calls");
    expect(hint).toContain("may be out of date");
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
