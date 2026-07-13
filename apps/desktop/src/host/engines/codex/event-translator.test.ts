import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { TurnTranslator } from "./event-translator.js";
import type { JsonRpcNotification } from "./protocol.js";
import { TurnItemIndex, fileChangesOf } from "./turn-item-index.js";

const THREAD_ID = "synthetic-thread";
const TURN_ID = "synthetic-turn";

function started(): JsonRpcNotification {
  return { method: "turn/started", params: { threadId: THREAD_ID, turn: { id: TURN_ID } } };
}

function completed(status: "completed" | "interrupted"): JsonRpcNotification {
  return { method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status } } };
}

const basicFixture: JsonRpcNotification[] = [
  started(),
  { method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "agentMessage", id: "message" } } },
  { method: "thread/tokenUsage/updated", params: { threadId: THREAD_ID, turnId: TURN_ID, tokenUsage: { last: { totalTokens: 13_495 }, modelContextWindow: 353_400 } } },
  { method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "message", delta: "SYNTHETIC_TEXT_OK" } },
  { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "agentMessage", id: "message" } } },
  completed("completed"),
];

const commandFixture: JsonRpcNotification[] = [
  started(),
  { method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "command", command: "printf synthetic-command" } } },
  { method: "thread/tokenUsage/updated", params: { threadId: THREAD_ID, turnId: TURN_ID, tokenUsage: { last: { totalTokens: 13_601 }, modelContextWindow: 353_400 } } },
  { method: "thread/tokenUsage/updated", params: { threadId: THREAD_ID, turnId: TURN_ID, tokenUsage: { last: { totalTokens: 13_669 }, modelContextWindow: 353_400 } } },
  { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "command", status: "completed", aggregatedOutput: "ok", durationMs: 0 } } },
  completed("completed"),
];

const fileChangeFixture: JsonRpcNotification[] = [
  started(),
  { method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "fileChange", id: "write", changes: [{ path: "synthetic-file.txt", diff: "SYNTHETIC_FILE_OK\n" }] } } },
  { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "fileChange", id: "write", status: "completed" } } },
  completed("completed"),
];

const interruptFixture: JsonRpcNotification[] = [started(), completed("interrupted")];

function translatorFor(messages: JsonRpcNotification[]): TurnTranslator {
  const turnStarted = messages.find((message) => message.method === "turn/started");
  const params = turnStarted?.params as { threadId: string; turn: { id: string } } | undefined;
  if (!params) throw new Error("fixture has no turn/started notification");
  return new TurnTranslator({ threadId: params.threadId, turnId: params.turn.id, turn: 1 });
}

function translate(messages: JsonRpcNotification[]): AgentEvent[] {
  const translator = translatorFor(messages);
  return messages.flatMap((message) => translator.onNotification(message));
}

function types(events: AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("TurnTranslator — synthetic protocol fixtures", () => {
  it("preserves the basic text-delta sequence, provider token usage, and terminal closure", () => {
    const events = translate(basicFixture);
    expect(events.filter((event) => event.type === "text_delta").map((event) => (event as { text: string }).text).join(""))
      .toBe("SYNTHETIC_TEXT_OK");
    expect(events).toContainEqual({ type: "context_usage", estimatedTokens: 13_495, budgetTokens: 353_400, source: "provider" });
    expect(types(events).slice(-2)).toEqual(["turn_end", "loop_end"]);
    expect(events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
  });

  it("projects a command card into a paired Bash lifecycle", () => {
    const events = translate(commandFixture);
    const start = events.find((event) => event.type === "tool_execution_start");
    const result = events.find((event) => event.type === "tool_result");
    expect(start).toMatchObject({ type: "tool_execution_start", toolName: "Bash", input: { command: expect.stringContaining("synthetic-command") } });
    expect(result).toMatchObject({ type: "tool_result", outcome: { toolName: "Bash", status: "success", durationMs: 0 } });
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(1);
    // The latest request usage, rather than a cumulative counter, drives
    // context accounting.
    expect(events.filter((event) => event.type === "context_usage").map((event) => (event as { estimatedTokens: number }).estimatedTokens))
      .toEqual([13_601, 13_669]);
  });

  it("projects a file-change card into a paired diffable Write lifecycle", () => {
    const events = translate(fileChangeFixture);
    const start = events.find((event) => event.type === "tool_execution_start");
    const result = events.find((event) => event.type === "tool_result");
    expect(start).toMatchObject({
      type: "tool_execution_start",
      toolName: "Write",
      input: { file_path: expect.stringContaining("synthetic-file.txt"), content: "SYNTHETIC_FILE_OK\n" },
    });
    expect(result).toMatchObject({ type: "tool_result", outcome: { toolName: "Write", status: "success" } });
  });

  it("closes an interrupted turn with the renderer's cancelled terminal state", () => {
    const events = translate(interruptFixture);
    expect(events).toEqual([
      { type: "turn_end", turn: 1, finishReason: "other" },
      { type: "loop_end", reason: "cancelled", turns: 1 },
    ]);
  });
});

describe("TurnTranslator — renderer invariants", () => {
  it("pairs every opened tool card and text block when a turn ends early", () => {
    const translator = new TurnTranslator({ threadId: "thread", turnId: "turn", turn: 3 });
    const events = [
      ...translator.onNotification({
        method: "item/started",
        params: { threadId: "thread", turnId: "turn", item: { type: "agentMessage", id: "text" } },
      }),
      ...translator.onNotification({
        method: "item/started",
        params: { threadId: "thread", turnId: "turn", item: { type: "commandExecution", id: "tool", command: "sleep 1" } },
      }),
      ...translator.finishTerminal("cancelled"),
    ];
    expect(types(events)).toEqual(["text_start", "tool_execution_start", "text_end", "tool_result", "turn_end", "loop_end"]);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({ outcome: { toolCallId: "tool", status: "cancelled" } });
  });

  it("records every started item of THIS turn into the approval-correlation index", () => {
    const items = new TurnItemIndex();
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1, items });
    // Everything the live turn announces BEFORE its approval request lands.
    for (const message of fileChangeFixture.filter((entry) => entry.method === "item/started")) {
      translator.onNotification(message);
    }
    // An item type this renderer adapter does not project must still be indexed:
    // approvals name an itemId, not a projection.
    translator.onNotification({
      method: "item/started",
      params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "reasoning", id: "rs_1", summary: [] } },
    });
    // A foreign turn's item must never leak into this turn's index.
    translator.onNotification({
      method: "item/started",
      params: { threadId: THREAD_ID, turnId: "other-turn", item: { type: "fileChange", id: "foreign", changes: [] } },
    });

    expect(fileChangesOf(items.get("write"))).toEqual([{ path: "synthetic-file.txt", diff: "SYNTHETIC_FILE_OK\n" }]);
    expect(items.get("rs_1")).toMatchObject({ type: "reasoning" });
    expect(items.get("foreign")).toBeUndefined();
  });

  it("ignores foreign and unrecognized notifications without inventing cards or grants", () => {
    const translator = new TurnTranslator({ threadId: "thread", turnId: "turn", turn: 1 });
    expect(translator.onNotification({
      method: "item/started",
      params: { threadId: "other", turnId: "turn", item: { type: "commandExecution", id: "x", command: "rm -rf /" } },
    })).toEqual([]);
    expect(translator.onNotification({
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread", turnId: "turn", itemId: "x" },
    })).toEqual([]);
    expect(translator.onNotification({
      method: "mcpServer/startupStatus/updated",
      params: { threadId: "thread", turnId: "turn" },
    })).toEqual([]);
  });
});
