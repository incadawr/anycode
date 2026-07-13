/**
 * Golden tests for the pure `thread/read` -> `HistoryItem[]` projection (cut
 * §2(e)/§3.6). The "resume" case is the literal W0-evidenced shape (scrubbed
 * copy also committed at contract/fixtures/resume-read.jsonl, cut §2(h)) —
 * pinning it here as an inline golden keeps this test independent of that
 * fixture file's exact on-disk path/format.
 */

import { describe, expect, it } from "vitest";
import { projectCodexHistory, type CodexThreadRead } from "./history-projection.js";

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

describe("projectCodexHistory", () => {
  it("projects the W0 resume-read golden turn verbatim (user + assistant text)", () => {
    const items = projectCodexHistory(RESUME_READ_THREAD, { maxItems: 200 });
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

  it("projects a commandExecution item into an assistant tool_call + tool tool_result pair (Bash)", () => {
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
    const items = projectCodexHistory(thread, { maxItems: 200 });
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
    const items = projectCodexHistory(thread, { maxItems: 200 });
    const toolCallIds = items
      .map((item) => item.message)
      .filter((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((part): part is Extract<typeof part, { type: "tool_call" }> => part.type === "tool_call")
      .map((part) => part.toolCallId);
    expect(toolCallIds).toEqual(["fc-1:0", "fc-1:1"]);
  });

  it("degrades an unmapped item type (e.g. reasoning) to a deterministic text block instead of dropping it", () => {
    const thread: CodexThreadRead = {
      thread: {
        id: "t1",
        turns: [{ id: "turn-1", startedAt: 0, items: [{ type: "reasoning", id: "rs-1" }] }],
      },
    };
    const items = projectCodexHistory(thread, { maxItems: 200 });
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "[Codex reasoning item — not represented in AnyCode's transcript format]" }],
    });
  });

  it("caps to the last maxItems and prepends exactly one truncation marker", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      type: "agentMessage" as const,
      id: `item-${i}`,
      text: `msg-${i}`,
    }));
    const thread: CodexThreadRead = { thread: { id: "t1", turns: [{ id: "turn-1", startedAt: 0, items }] } };
    const projected = projectCodexHistory(thread, { maxItems: 2 });
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
    expect(projectCodexHistory({ thread: { id: "t1" } }, { maxItems: 200 })).toEqual([]);
  });
});
