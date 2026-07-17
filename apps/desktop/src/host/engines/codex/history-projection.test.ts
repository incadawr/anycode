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

  it("restores an inline image data URL as an image attachment, never transcript text", () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".repeat(100);
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
                content: [
                  { type: "text", text: "Please inspect this: " },
                  { type: "image", url: `data:image/png;base64,${base64}` },
                ],
              },
            ],
          },
        ],
      },
    };

    const message = projectCodexHistory(thread, [], { maxItems: 200 })[0]?.message;
    expect(message).toEqual({ role: "user", content: "Please inspect this: ", images: [{ mediaType: "image/png", data: base64 }] });
    expect(message?.role === "user" ? message.content : "").not.toContain(base64);
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

  it("native-only turn: a turn with items but zero shadow rows for it renders turn 0 byte-identical to the native-only golden — the extra ordinal is a tail, not a drop", () => {
    const shadow: ShadowCommandItem[] = [{ turnOrdinal: 5, positionInTurn: 0, seqInTurn: 0, command: "unrelated turn", exitCode: 0, outputHead: "out\n" }];
    const items = projectCodexHistory(RESUME_READ_THREAD, shadow, { maxItems: 200 });
    // turnOrdinal 5 does not exist in RESUME_READ_THREAD (only turn 0) — turn 0
    // renders byte-identical to the native-only golden above...
    expect(items.slice(0, 2)).toEqual([
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
    // ...and the out-of-bounds row is NEVER silently dropped (module header's
    // "Nothing is ever dropped" invariant, W7 HIGH-3): it is appended as a
    // tail pair on a synthetic turn id that can never collide with a real
    // native turn id, with createdAt continuing the cursor.
    expect(items).toHaveLength(4);
    expect(items[2]).toMatchObject({
      id: "019f554c-dd9a-7d42-bcea-0673f965508e:orphan-turn-5:shadow:0:call",
      createdAt: 1783842528002,
      message: {
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "019f554c-dd9a-7d42-bcea-0673f965508e:orphan-turn-5:shadow:0", toolName: "Bash", input: { command: "unrelated turn" } }],
      },
    });
    expect(items[3]).toMatchObject({
      id: "019f554c-dd9a-7d42-bcea-0673f965508e:orphan-turn-5:shadow:0:result",
      createdAt: 1783842528003,
      message: { role: "tool", content: [{ type: "tool_result", status: "success", text: "out\n" }] },
    });
  });

  it("multiple orphan turnOrdinals are appended sorted by (turnOrdinal, positionInTurn, seqInTurn), each on its own synthetic turn id, with a monotonically increasing createdAt across the whole tail", () => {
    const thread: CodexThreadRead = { thread: { id: "t1", turns: [{ id: "turn-0", startedAt: 0, items: [] }] } };
    const shadow: ShadowCommandItem[] = [
      { turnOrdinal: 2, positionInTurn: 0, seqInTurn: 1, command: "second-later-seq", exitCode: 0 },
      { turnOrdinal: 1, positionInTurn: 0, seqInTurn: 0, command: "first-turn", exitCode: 0 },
      { turnOrdinal: 2, positionInTurn: 0, seqInTurn: 0, command: "second-earlier-seq", exitCode: 0 },
    ];
    const items = projectCodexHistory(thread, shadow, { maxItems: 200 });

    expect(toolCallIdsOf(items)).toEqual([
      "t1:orphan-turn-1:shadow:0",
      "t1:orphan-turn-2:shadow:0",
      "t1:orphan-turn-2:shadow:1",
    ]);
    const createdAts = items.map((item) => item.createdAt);
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    expect(new Set(createdAts).size).toBe(createdAts.length);
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

  it("100 orphan rows never evict an actual native user/assistant pair under a maxItems:200 cap (architect's repro, W8 MEDIUM-2)", () => {
    // Pre-fix: orphan rows were appended AFTER real turns and the cap took
    // the LAST maxItems of that combined list — an orphan tail long enough
    // to exceed maxItems on its own evicted the real turns entirely. This is
    // the exact GUI failure mode ("after relaunch the whole conversation is
    // gone, only old commands remain").
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [
          {
            id: "turn-1",
            startedAt: 0,
            items: [
              { type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] },
              { type: "agentMessage", id: "a1", text: "hi there" },
            ],
          },
        ],
      },
    };
    // 100 orphan rows, each on its own out-of-bounds turnOrdinal (turns.length is 1).
    const shadow: ShadowCommandItem[] = Array.from({ length: 100 }, (_, i) => ({
      turnOrdinal: i + 1,
      positionInTurn: 0,
      seqInTurn: 0,
      command: `orphan-${i}`,
      exitCode: 0,
    }));

    const items = projectCodexHistory(thread, shadow, { maxItems: 200 });

    // Both native messages survive the cap. `roles.toContain("assistant")`
    // alone is a WEAK check (W9 — a truncation-marker item is also
    // assistant-rolled, and so is every orphan command's own tool_call
    // HistoryItem, so this passes even if the native assistant message were
    // dropped entirely); assert the native assistant SPECIFICALLY by its own
    // id and text so a regression that evicts it from `inBounds` cannot hide
    // behind those other assistant-rolled items.
    const roles = items.map((item) => item.message.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(items.some((item) => item.message.role === "user" && item.message.content === "hello")).toBe(true);
    const nativeAssistant = items.find((item) => item.id === "turn-1:a1");
    expect(nativeAssistant?.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "hi there" }] });

    // Only 99 of the 100 orphan rows fit the remaining budget
    // (200 - 2 native = 198 slots = 99 whole tool_call/tool_result pairs).
    const orphanCallIds = toolCallIdsOf(items).filter((id) => id.includes(":orphan-turn-"));
    expect(orphanCallIds).toHaveLength(99);

    // The leading marker must honestly say command output was discarded — it
    // is a LIE to claim "native thread retains full history" once a shadow
    // command was dropped from the projection.
    expect(items[0]?.kind).toBe("compact_summary");
    expect(items[0]?.message).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("not retained by Codex") }] });
    const markerPart = items[0]?.message.role === "assistant" ? items[0].message.content[0] : undefined;
    expect(markerPart?.type === "text" ? markerPart.text : "").not.toContain("native thread retains full history");
  });

  it("a fully-consumed in-bounds budget (0 remaining) emits no orphan tail at all (W8 MEDIUM-2)", () => {
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [
          {
            id: "turn-1",
            startedAt: 0,
            items: [
              { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] },
              { type: "agentMessage", id: "a1", text: "hello" },
            ],
          },
        ],
      },
    };
    const shadow: ShadowCommandItem[] = [{ turnOrdinal: 5, positionInTurn: 0, seqInTurn: 0, command: "orphan-cmd", exitCode: 0 }];
    const items = projectCodexHistory(thread, shadow, { maxItems: 2 });

    // budget = maxItems(2) - inBounds(2) = 0 — the orphan row must not be
    // emitted at all, not even partially.
    expect(toolCallIdsOf(items)).toEqual([]);
    const roles = items.filter((item) => item.kind !== "compact_summary").map((item) => item.message.role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("an odd leftover budget never splits a tool_call/tool_result pair — the row that doesn't fully fit is dropped whole (W8 MEDIUM-2)", () => {
    const thread: CodexThreadRead = { thread: { id: "t1", turns: [{ id: "turn-1", startedAt: 0, items: [] }] } };
    const shadow: ShadowCommandItem[] = [
      { turnOrdinal: 1, positionInTurn: 0, seqInTurn: 0, command: "older", exitCode: 0 },
      { turnOrdinal: 2, positionInTurn: 0, seqInTurn: 0, command: "newer", exitCode: 0 },
    ];
    const items = projectCodexHistory(thread, shadow, { maxItems: 3 });

    // budget = maxItems(3) - inBounds(0) = 3; only ONE whole row (2 items)
    // fits. A naive flat slice of the last 3 raw items (older's tool_call,
    // older's tool_result, newer's tool_call, newer's tool_result -> last 3)
    // would instead keep [older.tool_result, newer.tool_call,
    // newer.tool_result] — stranding a tool_result with no matching
    // tool_call. The newer (more recent) row must survive whole; the older
    // row must be dropped whole.
    expect(toolCallIdsOf(items)).toEqual(["t1:orphan-turn-2:shadow:0"]);
    const toolResultCount = items.filter((item) => item.message.role === "tool").length;
    expect(toolResultCount).toBe(1);
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
