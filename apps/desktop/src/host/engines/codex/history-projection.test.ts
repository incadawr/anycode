/**
 * Golden tests for the pure `thread/read` + shadow-log -> `HistoryItem[]`
 * projection (cut §2(e)/§3.6). The "resume" case is the literal W0-evidenced
 * shape (scrubbed copy also committed at contract/fixtures/resume-read.jsonl,
 * cut §2(h)) — pinning it here as an inline golden keeps this test
 * independent of that fixture file's exact on-disk path/format.
 */

import { describe, expect, it } from "vitest";
import type { HistoryItem } from "@anycode/core";
import { projectCodexHistory, type CodexThreadRead, type ShadowCommandItem } from "./history-projection.js";

const RESUME_READ_THREAD: CodexThreadRead = {
  thread: {
    id: "019f554c-dd9a-7d42-bcea-0673f965508e",
    turns: [
      {
        id: "019f554c-ddd9-71b2-a90d-0191ac1e4422",
        startedAt: 1783842528,
        items: [
          {
            type: "userMessage",
            id: "item-1",
            content: [{ type: "text", text: "Reply with exactly W0_TEXT_OK. Do not call tools." }],
          },
          { type: "agentMessage", id: "item-2", text: "W0_TEXT_OK" },
        ],
      },
    ],
  },
};

function toolCallIdsOf(items: HistoryItem[]): string[] {
  return items
    .map((item) => item.message)
    .filter((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((part): part is Extract<typeof part, { type: "tool_call" }> => part.type === "tool_call")
    .map((part) => part.toolCallId);
}

describe("projectCodexHistory — native-only projection", () => {
  it("projects the W0 resume-read golden turn verbatim (user + assistant text)", () => {
    const items = projectCodexHistory(RESUME_READ_THREAD, [], { maxItems: 200 });
    expect(items).toEqual([
      {
        id: "019f554c-ddd9-71b2-a90d-0191ac1e4422:item-1",
        createdAt: 1783842528000,
        message: { role: "user", content: "Reply with exactly W0_TEXT_OK. Do not call tools." },
      },
      {
        id: "019f554c-ddd9-71b2-a90d-0191ac1e4422:item-2",
        createdAt: 1783842528001,
        message: { role: "assistant", content: [{ type: "text", text: "W0_TEXT_OK" }] },
      },
    ]);
  });

  it("projects a native commandExecution item into an assistant tool_call + tool tool_result pair (Bash)", () => {
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [
          {
            id: "turn-1",
            startedAt: 100,
            items: [
              {
                type: "commandExecution",
                id: "exec-1",
                command: "echo hi",
                cwd: "/repo",
                status: "completed",
                aggregatedOutput: "hi\n",
              },
            ],
          },
        ],
      },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    expect(items).toEqual([
      {
        id: "turn-1:exec-1:call",
        createdAt: 100000,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", toolCallId: "exec-1", toolName: "Bash", input: { command: "echo hi", cwd: "/repo" } }],
        },
      },
      {
        id: "turn-1:exec-1:result",
        createdAt: 100001,
        message: {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "exec-1", toolName: "Bash", text: "hi\n", status: "success" }],
        },
      },
    ]);
  });

  it("projects a declined native commandExecution as denied, not error (C0 review Medium)", () => {
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [{ id: "turn-1", startedAt: 0, items: [{ type: "commandExecution", id: "exec-1", command: "rm -rf /", status: "declined" }] }],
      },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    const result = items.find((item) => item.message.role === "tool");
    // Pre-fix: statusFor had no "declined" branch, so this fell into the
    // catch-all `error` case — a user's own deny read as a malfunction.
    expect(result?.message).toMatchObject({ content: [{ status: "denied" }] });
  });

  it("projects a declined native fileChange as denied, not error", () => {
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [{ id: "turn-1", startedAt: 0, items: [{ type: "fileChange", id: "fc-1", status: "declined", changes: [{ path: "a.txt", diff: "+a" }] }] }],
      },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    const result = items.find((item) => item.message.role === "tool");
    expect(result?.message).toMatchObject({ content: [{ status: "denied" }] });
  });

  it("projects EVERY file of a multi-file fileChange (not just the first)", () => {
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [
          {
            id: "turn-1",
            startedAt: 0,
            items: [
              {
                type: "fileChange",
                id: "fc-1",
                status: "completed",
                changes: [
                  { path: "a.txt", diff: "+a" },
                  { path: "b.txt", diff: "+b" },
                ],
              },
            ],
          },
        ],
      },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    expect(toolCallIdsOf(items)).toEqual(["fc-1:0", "fc-1:1"]);
  });

  it("degrades an unmapped item type to a deterministic text block instead of dropping it", () => {
    // A genuinely unhandled item type (not reasoning/plan, which now have
    // their own dedicated projection below) — the generic fallback path.
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [{ id: "turn-1", startedAt: 0, items: [{ type: "webSearchCall", id: "ws-1" }] }],
      },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "[Codex webSearchCall item — not represented in AnyCode's transcript format]" }],
    });
  });

  it("preserves reasoning summary/content text instead of only the type label (C0 review Medium)", () => {
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [
          {
            id: "turn-1",
            startedAt: 0,
            items: [{ type: "reasoning", id: "rs-1", summary: ["Checking the file first"], content: ["Then I will run the test suite"] }],
          },
        ],
      },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    expect(items).toHaveLength(1);
    const message = items[0]?.message;
    // Pre-fix: reasoning fell into the generic fallback, which shows ONLY the
    // bare type label — this text would never appear.
    expect(message?.role === "assistant" ? message.content[0] : null).toMatchObject({
      type: "text",
      text: expect.stringContaining("Checking the file first"),
    });
    expect(message?.role === "assistant" ? message.content[0] : null).toMatchObject({
      text: expect.stringContaining("Then I will run the test suite"),
    });
  });

  it("degrades an empty reasoning item gracefully, without crashing", () => {
    const thread: CodexThreadRead = {
      thread: { id: "t1", turns: [{ id: "turn-1", startedAt: 0, items: [{ type: "reasoning", id: "rs-1" }] }] },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    expect(items).toHaveLength(1);
  });

  it("preserves plan text instead of only the type label (C0 review Medium)", () => {
    const thread: CodexThreadRead = {
      thread: { id: "t1", turns: [{ id: "turn-1", startedAt: 0, items: [{ type: "plan", id: "pl-1", text: "1. Read the file\n2. Fix the bug" }] }] },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    const message = items[0]?.message;
    expect(message?.role === "assistant" ? message.content[0] : null).toMatchObject({
      type: "text",
      text: expect.stringContaining("1. Read the file\n2. Fix the bug"),
    });
  });

  it("preserves a non-text userMessage part (image) as a bracketed reference instead of silently dropping it (C0 review Medium)", () => {
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [
          {
            id: "turn-1",
            startedAt: 0,
            items: [
              {
                type: "userMessage",
                id: "um-1",
                content: [{ type: "text", text: "Look at this: " }, { type: "image", url: "https://example.com/x.png" }],
              },
            ],
          },
        ],
      },
    };
    const items = projectCodexHistory(thread, [], { maxItems: 200 });
    const message = items[0]?.message;
    // Pre-fix: textOf() filtered to only parts with a `text` string, so the
    // image part vanished with no trace at all.
    expect(message?.role === "user" ? message.content : null).toContain("https://example.com/x.png");
  });

  it("caps to the last maxItems and prepends exactly one truncation marker", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      type: "agentMessage" as const,
      id: `item-${i}`,
      text: `msg-${i}`,
    }));
    const thread: CodexThreadRead = { thread: { id: "t1", turns: [{ id: "turn-1", startedAt: 0, items }] } };
    const projected = projectCodexHistory(thread, [], { maxItems: 2 });
    expect(projected).toHaveLength(3); // 1 marker + 2 kept
    expect(projected[0]?.kind).toBe("compact_summary");
    expect(projected[0]?.message.content).toEqual([
      { type: "text", text: "… earlier history truncated (native thread retains full history)" },
    ]);
    // The two KEPT items are the most recent ones (msg-3, msg-4), not the earliest.
    const keptTexts = projected.slice(1).map((item) => (item.message.role === "assistant" ? item.message.content : null));
    expect(keptTexts).toEqual([
      [{ type: "text", text: "msg-3" }],
      [{ type: "text", text: "msg-4" }],
    ]);
  });

  it("returns an empty array for a thread with no turns", () => {
    expect(projectCodexHistory({ thread: { id: "t1" } }, [], { maxItems: 200 })).toEqual([]);
  });
});

describe("projectCodexHistory — shadow command log merge (cut §2(e))", () => {
  it("fallback: an empty shadow log with shadowMissing:true prepends the explicit degradation marker", () => {
    const items = projectCodexHistory(RESUME_READ_THREAD, [], { maxItems: 200, shadowMissing: true });
    expect(items[0]).toMatchObject({
      kind: "compact_summary",
      message: { content: [{ text: "command output from earlier sessions is not retained by Codex" }] },
    });
    expect(items).toHaveLength(3); // marker + the 2 native golden items
  });

  it("an empty shadow log WITHOUT shadowMissing projects natives only — no false-positive marker", () => {
    const items = projectCodexHistory(RESUME_READ_THREAD, [], { maxItems: 200 });
    expect(items.some((item) => item.kind === "compact_summary")).toBe(false);
  });

  it("shadow-only turn: a turn whose only item is a command (never persisted natively) is reconstructed purely from the shadow log", () => {
    const thread: CodexThreadRead = {
      thread: { id: "t1", turns: [{ id: "turn-1", startedAt: 0, items: [] }] },
    };
    const shadow: ShadowCommandItem[] = [
      { turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo shadow-only", cwd: "/repo", exitCode: 0, outputHead: "shadow-only\n" },
    ];
    const items = projectCodexHistory(thread, shadow, { maxItems: 200 });
    expect(items).toEqual([
      {
        id: "turn-1:shadow:0:call",
        createdAt: 0,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", toolCallId: "turn-1:shadow:0", toolName: "Bash", input: { command: "echo shadow-only", cwd: "/repo" } }],
        },
      },
      {
        id: "turn-1:shadow:0:result",
        createdAt: 1,
        message: {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "turn-1:shadow:0", toolName: "Bash", text: "shadow-only\n", status: "success" }],
        },
      },
    ]);
  });

  it("native-only turn: a turn with items but zero shadow rows for it projects exactly as the native-only path (regression)", () => {
    const shadow: ShadowCommandItem[] = [{ turnOrdinal: 5, positionInTurn: 0, seqInTurn: 0, command: "unrelated turn", exitCode: 0 }];
    const items = projectCodexHistory(RESUME_READ_THREAD, shadow, { maxItems: 200 });
    // turnOrdinal 5 does not exist in RESUME_READ_THREAD (only turn 0) — the
    // shadow row is simply never matched to any turn, and turn 0 renders
    // byte-identical to the native-only golden above.
    expect(items).toEqual([
      {
        id: "019f554c-ddd9-71b2-a90d-0191ac1e4422:item-1",
        createdAt: 1783842528000,
        message: { role: "user", content: "Reply with exactly W0_TEXT_OK. Do not call tools." },
      },
      {
        id: "019f554c-ddd9-71b2-a90d-0191ac1e4422:item-2",
        createdAt: 1783842528001,
        message: { role: "assistant", content: [{ type: "text", text: "W0_TEXT_OK" }] },
      },
    ]);
  });

  // MECHANICS-ONLY unit test (W6): a hand-authored `positionInTurn` against a
  // native side with no dropped items. This proves `mergeTurnItems` inserts a
  // shadow row before the correct native index and nothing else — it is NOT
  // evidence that a real live turn produces this `positionInTurn`, which is
  // exactly the class of bug W6 fixes (see the composition test in
  // codex-engine.test.ts, built from a REAL captured live stream + a REAL
  // paired `thread/read`, never from hand-authored positions like this one).
  it("mechanics: a shadow row anchored at positionInTurn:1 is inserted strictly BEFORE native[1], not merged-space position 1", () => {
    // RESUME_READ_THREAD's turn has exactly 2 native items (userMessage,
    // agentMessage) — positionInTurn:1 means "insert before native[1]"
    // (the agentMessage), landing the command between the two.
    const shadow: ShadowCommandItem[] = [{ turnOrdinal: 0, positionInTurn: 1, seqInTurn: 1, command: "echo between", exitCode: 0, outputHead: "between\n" }];
    const items = projectCodexHistory(RESUME_READ_THREAD, shadow, { maxItems: 200 });

    const roles = items.map((item) => item.message.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(items[0]).toMatchObject({ message: { role: "user", content: "Reply with exactly W0_TEXT_OK. Do not call tools." } });
    // The shadow command's tool_call/tool_result pair sits strictly BETWEEN
    // the user message and the agent's final text reply.
    expect(items[1]).toMatchObject({ message: { content: [{ type: "tool_call", toolCallId: "019f554c-ddd9-71b2-a90d-0191ac1e4422:shadow:1" }] } });
    expect(items[2]).toMatchObject({ message: { role: "tool", content: [{ status: "success", text: "between\n" }] } });
    expect(items[3]).toMatchObject({ message: { role: "assistant", content: [{ type: "text", text: "W0_TEXT_OK" }] } });
  });

  it("a shadow command with no exitCode (declined/interrupted before completion) degrades to cancelled, not error", () => {
    const thread: CodexThreadRead = { thread: { id: "t1", turns: [{ id: "turn-1", startedAt: 0, items: [] }] } };
    const shadow: ShadowCommandItem[] = [{ turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "rm -rf /" }];
    const items = projectCodexHistory(thread, shadow, { maxItems: 200 });
    const result = items.find((item) => item.message.role === "tool");
    expect(result?.message).toMatchObject({ content: [{ status: "cancelled" }] });
  });

  it("truncation at 200 still applies correctly with shadow items merged in", () => {
    const nativeItems = Array.from({ length: 4 }, (_, i) => ({ type: "agentMessage" as const, id: `item-${i}`, text: `msg-${i}` }));
    const thread: CodexThreadRead = { thread: { id: "t1", turns: [{ id: "turn-1", startedAt: 0, items: nativeItems }] } };
    // Interleave a shadow command at position 4 (after all 4 native items):
    // total items in the turn = 4 native + 1 shadow = 5, each shadow command
    // projects to 2 HistoryItems -> 6 HistoryItems total, capped to the last 3.
    const shadow: ShadowCommandItem[] = [{ turnOrdinal: 0, positionInTurn: 4, seqInTurn: 4, command: "echo last", exitCode: 0, outputHead: "last\n" }];
    const projected = projectCodexHistory(thread, shadow, { maxItems: 3 });
    expect(projected).toHaveLength(4); // 1 marker + 3 kept
    expect(projected[0]?.kind).toBe("compact_summary");
    // The 3 kept items are the tail: msg-3, then the shadow command's call+result pair.
    expect(projected[1]).toMatchObject({ message: { content: [{ type: "text", text: "msg-3" }] } });
    expect(projected[2]).toMatchObject({ message: { content: [{ type: "tool_call", toolName: "Bash" }] } });
    expect(projected[3]).toMatchObject({ message: { role: "tool", content: [{ status: "success" }] } });
  });
});
