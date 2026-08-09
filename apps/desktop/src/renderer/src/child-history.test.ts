/**
 * child-history.ts tests (TASK.102 CUT-S2 §10.8.1 point 4/6d, slice S2c C4):
 * the pure CHILD_HISTORY_CHANNEL response -> view-state mapper, in isolation
 * from the IPC call itself (main/tab-ipc.ts, tested separately) and from the
 * JSX layer (App.tsx, untestable — vitest does not collect `.tsx`).
 */
import { describe, expect, it } from "vitest";
import { projectChildHistoryResult, type ChildHistoryResult } from "./child-history.js";
import type { WireHistoryItem } from "../../shared/protocol.js";

const REFUSED: ChildHistoryResult = { ok: false, reason: "not_found" };
const REFUSED_INVALID: ChildHistoryResult = { ok: false, reason: "invalid_id" };

const ITEMS: WireHistoryItem[] = [
  { id: "h1", createdAt: 1, message: { role: "user", content: "hello" } },
  {
    id: "h2",
    createdAt: 2,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "on it" },
        { type: "tool_call", toolCallId: "call-1", toolName: "Bash", input: { command: "ls" } },
      ],
    },
  },
  {
    id: "h3",
    createdAt: 3,
    message: { role: "tool", content: [{ type: "tool_result", toolCallId: "call-1", toolName: "Bash", text: "a.ts", status: "success" }] },
  },
];

describe("projectChildHistoryResult", () => {
  it("a refused channel call (unauthorized/not-found) maps to the unavailable state, never a thrown exception", () => {
    expect(() => projectChildHistoryResult(REFUSED)).not.toThrow();
    expect(projectChildHistoryResult(REFUSED)).toEqual({ kind: "unavailable" });
  });

  it("a refused channel call for malformed input (invalid_id) ALSO maps to unavailable — every refusal reason collapses to the same honest state", () => {
    expect(projectChildHistoryResult(REFUSED_INVALID)).toEqual({ kind: "unavailable" });
  });

  it("an authorized but empty history (ok:true, items:[]) maps to the empty state — NOT unavailable (the call succeeded; there is simply nothing to show, e.g. a cancelled child reaped before its first flush)", () => {
    expect(projectChildHistoryResult({ ok: true, items: [] })).toEqual({ kind: "empty" });
  });

  it("an authorized non-empty history maps to blocks, via the REAL projectHistoryToBlocks, with the exact block count that function would produce standalone", () => {
    const state = projectChildHistoryResult({ ok: true, items: ITEMS });
    if (state.kind !== "blocks") {
      throw new Error("expected the blocks state for a non-empty ok result");
    }
    // user_text + assistant_text + tool_call = 3 blocks (the tool-role item
    // pairs into the tool_call block, same invariant store.test.ts's own
    // projectHistoryToBlocks suite pins).
    expect(state.blocks).toHaveLength(3);
    expect(state.blocks.map((b) => b.kind)).toEqual(["user_text", "assistant_text", "tool_call"]);
  });

  it("a history containing an Agent card projects it through the SAME path (nested subagent card renders inside a child's own history, §3 C4's originally-assigned case)", () => {
    const withAgentCard: WireHistoryItem[] = [
      {
        id: "a1",
        createdAt: 1,
        message: { role: "assistant", content: [{ type: "tool_call", toolCallId: "call-agent", toolName: "Agent", input: {} }] },
      },
      {
        id: "a2",
        createdAt: 2,
        message: { role: "tool", content: [{ type: "tool_result", toolCallId: "call-agent", toolName: "Agent", text: "done", status: "success" }] },
      },
    ];
    const state = projectChildHistoryResult({ ok: true, items: withAgentCard });
    if (state.kind !== "blocks") {
      throw new Error("expected the blocks state");
    }
    expect(state.blocks).toEqual([
      {
        kind: "tool_call",
        id: "a1:0",
        toolCallId: "call-agent",
        toolName: "Agent",
        input: {},
        status: "success",
        modelText: "done",
        snapshots: { before: null, after: null },
        subagent: null,
        workflow: null,
      },
    ]);
  });

  it("mapping the SAME result twice produces an equivalent projection computed FROM ZERO both times, never an append (CUT-S1 §9.2 / CUT-S2 §10.4's live->completed flip invariant): re-mapping never doubles the block count", () => {
    const result: ChildHistoryResult = { ok: true, items: ITEMS };
    const first = projectChildHistoryResult(result);
    const second = projectChildHistoryResult(result);
    expect(first).toEqual(second);
    if (first.kind !== "blocks" || second.kind !== "blocks") {
      throw new Error("expected the blocks state both times");
    }
    expect(second.blocks).toHaveLength(first.blocks.length);
    expect(second.blocks).toHaveLength(3);
  });
});
