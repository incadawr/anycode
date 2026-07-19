import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { TurnTranslator } from "./event-translator.js";
import type { JsonRpcNotification } from "./protocol.js";
import { TurnItemIndex, fileChangesOf } from "./turn-item-index.js";

const THREAD_ID = "synthetic-thread";
const TURN_ID = "synthetic-turn";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "contract", "fixtures");

/**
 * Loads a REAL captured app-server trace (contract/fixtures/*.jsonl, cut §2(h))
 * and replays it through a translator scoped to the turn the fixture's FIRST
 * `threadId`+`turnId`-bearing message names — a fixture may contain more than
 * one native turn (e.g. w1-p1-command-decline.jsonl's second, tool-free turn),
 * and `matchingTurn` inside the translator already discards everything
 * addressed to any other turn, so replaying every notification here is safe.
 */
function translateLiveFixture(fileName: string): AgentEvent[] {
  const raw = readFileSync(join(FIXTURES_DIR, fileName), "utf8");
  const messages = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: unknown; id?: unknown; params?: unknown });
  // Notifications only (server requests/client responses also carry an "id").
  const notifications: JsonRpcNotification[] = messages
    .filter((message) => typeof message.method === "string" && message.id === undefined)
    .map((message) => ({ method: message.method as string, params: message.params }));
  let turnKey: { threadId: string; turnId: string } | undefined;
  for (const message of notifications) {
    const params = message.params as Record<string, unknown> | undefined;
    if (typeof params?.threadId === "string" && typeof params?.turnId === "string") {
      turnKey = { threadId: params.threadId, turnId: params.turnId };
      break;
    }
  }
  if (!turnKey) throw new Error(`fixture ${fileName} has no threadId+turnId-bearing notification`);
  const translator = new TurnTranslator({ threadId: turnKey.threadId, turnId: turnKey.turnId, turn: 1 });
  return notifications.flatMap((message) => translator.onNotification(message));
}

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
    expect(types(events)).toEqual([
      "text_start",
      "tool_call",
      "tool_execution_start",
      "text_end",
      "tool_result",
      "turn_end",
      "loop_end",
    ]);
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

  it("projects a declined commandExecution as denied, not error (C0 review Medium, live side)", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    translator.onNotification({ method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "x", command: "rm -rf /" } } });
    const events = translator.onNotification({
      method: "item/completed",
      params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "x", status: "declined" } },
    });
    // Pre-fix: statusFor had no "declined" branch, so this fell into the
    // catch-all `error` case — a user's own deny read as a malfunction.
    expect(events).toEqual([{ type: "tool_result", outcome: expect.objectContaining({ status: "denied" }) }]);
  });

  it("projects EVERY file of a multi-file fileChange as its own tool_execution_start/tool_result pair", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const started = translator.onNotification({
      method: "item/started",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "fileChange", id: "fc", changes: [{ path: "a.txt", diff: "+a" }, { path: "b.txt", diff: "+b" }] },
      },
    });
    // Pre-fix: projectTool() only ever read `item.changes[0]`, so only ONE
    // tool_execution_start would have been emitted here — b.txt would never
    // appear.
    // Each projection now emits its own tool_call/tool_execution_start pair
    // (W17): 2 files -> 4 events, tool_call immediately before its matching
    // tool_execution_start.
    expect(started).toHaveLength(4);
    expect(types(started)).toEqual(["tool_call", "tool_execution_start", "tool_call", "tool_execution_start"]);
    expect(
      started.filter((event) => event.type === "tool_call").map((event) => (event as { toolCall: { id: string } }).toolCall.id),
    ).toEqual(["fc:0", "fc:1"]);
    expect(
      started.filter((event) => event.type === "tool_execution_start").map((event) => (event as { toolCallId: string }).toolCallId),
    ).toEqual(["fc:0", "fc:1"]);

    const completed = translator.onNotification({
      method: "item/completed",
      params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "fileChange", id: "fc", status: "completed" } },
    });
    expect(completed).toHaveLength(2);
    expect(completed.map((event) => (event as { outcome: { toolCallId: string } }).outcome.toolCallId)).toEqual(["fc:0", "fc:1"]);
  });

  it("accumulates live commandExecution output deltas and falls back to them when aggregatedOutput is missing at completion", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    translator.onNotification({ method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "x", command: "echo hi" } } });
    // Pre-fix: "item/commandExecution/outputDelta" was not in the switch, so
    // it hit the `default` case and was silently discarded — the deltas
    // below would be lost, and modelText would be "" at completion.
    translator.onNotification({ method: "item/commandExecution/outputDelta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "x", delta: "hi" } });
    translator.onNotification({ method: "item/commandExecution/outputDelta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "x", delta: "\n" } });
    const events = translator.onNotification({
      method: "item/completed",
      params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "x", status: "completed", aggregatedOutput: null } },
    });
    expect((events[0] as { outcome: { modelText: string } }).outcome.modelText).toBe("hi\n");
  });

  it("aggregatedOutput still wins over the accumulated delta buffer when both are present", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    translator.onNotification({ method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "x", command: "echo hi" } } });
    translator.onNotification({ method: "item/commandExecution/outputDelta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "x", delta: "partial" } });
    const events = translator.onNotification({
      method: "item/completed",
      params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "x", status: "completed", aggregatedOutput: "full output\n" } },
    });
    expect((events[0] as { outcome: { modelText: string } }).outcome.modelText).toBe("full output\n");
  });
});

describe("TurnTranslator — errors and retries (cut §2(i))", () => {
  it("a terminal error notification (willRetry:false) surfaces with its ORIGINAL safe message, followed by an honest loop_end reason", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    // Real fixture shape: contract/fixtures/w1-p6-start-echo-and-error.jsonl.
    const errorEvents = translator.onNotification({
      method: "error",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        error: { message: "The 'bogus-model' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: "other", additionalDetails: null },
        willRetry: false,
      },
    });
    // Pre-fix: "error" was not in the switch, so this notification was
    // silently discarded — no {type:"error"} event would ever be emitted here.
    expect(errorEvents).toEqual([{ type: "error", error: expect.any(Error) }]);
    expect((errorEvents[0] as { error: Error }).error.message).toBe(
      "The 'bogus-model' model is not supported when using Codex with a ChatGPT account.",
    );

    const finishEvents = translator.onNotification({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "failed" } },
    });
    // Honest reason, not a faceless "error" with no prior explanation — and no
    // SECOND {type:"error"} duplicating the one already emitted above.
    expect(finishEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(finishEvents.at(-1)).toEqual({ type: "loop_end", reason: "error", turns: 1 });
  });

  it("a terminal turn/completed with no preceding error notification still surfaces the error (fallback in finish())", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const events = translator.onNotification({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "failed", error: { message: "sandbox denied this operation" } } },
    });
    // Pre-fix: finish() never inspected turn.error at all — this would have
    // been a completely faceless loop_end:"error" with zero explanation.
    expect(events[0]).toEqual({ type: "error", error: expect.any(Error) });
    expect((events[0] as { error: Error }).error.message).toBe("sandbox denied this operation");
    expect(events.at(-1)).toEqual({ type: "loop_end", reason: "error", turns: 1 });
  });

  it("willRetry:true routes to engine_notice (level retry), never a terminal error, and the turn keeps running", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const events = translator.onNotification({
      method: "error",
      params: { threadId: THREAD_ID, turnId: TURN_ID, error: { message: "network hiccup, retrying" }, willRetry: true },
    });
    // Pre-fix: unhandled -> []. A retry must never look like a failure.
    expect(events).toEqual([{ type: "engine_notice", level: "retry", message: "network hiccup, retrying" }]);
    expect(events.some((event) => event.type === "error")).toBe(false);

    // The turn is still alive afterwards — completes normally.
    const finishEvents = translator.onNotification({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } } });
    expect(finishEvents.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
  });

  it("a thread-scoped `warning` notification (no turnId on the wire) surfaces as engine_notice level warning", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    // Real fixture shape: contract/fixtures/w1-p6-start-echo-and-error.jsonl —
    // `warning` carries only {threadId, message}, no turnId at all.
    const events = translator.onNotification({
      method: "warning",
      params: { threadId: THREAD_ID, message: "Model metadata not found; defaulting to fallback metadata." },
    });
    // Pre-fix: matchingTurn() required turnId === this turn's id, which a
    // warning notification never carries — it would be dropped as "foreign".
    expect(events).toEqual([{ type: "engine_notice", level: "warning", message: "Model metadata not found; defaulting to fallback metadata." }]);
  });

  it("ignores a warning addressed to a foreign thread", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    expect(translator.onNotification({ method: "warning", params: { threadId: "other-thread", message: "irrelevant" } })).toEqual([]);
  });
});

describe("TurnTranslator — engine_session_tokens (cut §5.3, REPLACE semantics)", () => {
  const usage = (lastTotal: number, cumulative: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number }): JsonRpcNotification => ({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      tokenUsage: { last: { totalTokens: lastTotal }, total: cumulative, modelContextWindow: 353_400 },
    },
  });

  it("carries the wire's CUMULATIVE totals verbatim on every update — never per-update deltas, never a `finish` event", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const first = translator.onNotification(usage(100, { inputTokens: 80, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 100 }));
    const second = translator.onNotification(usage(150, { inputTokens: 190, cachedInputTokens: 60, outputTokens: 60, reasoningOutputTokens: 15, totalTokens: 250 }));

    expect(first).toContainEqual({
      type: "engine_session_tokens",
      input: 80,
      output: 20,
      total: 100,
      cachedInput: 10,
      reasoningOutput: 5,
    });
    // REPLACE red-proof (cut §13.2 C / hazard §14.3): `tokenUsage.total` is
    // ALREADY cumulative on the wire, so the second event must carry 250 —
    // a translator rolled back to emit per-update deltas for a summing
    // consumer would carry 150 here, and this assertion goes red.
    expect(second).toContainEqual({
      type: "engine_session_tokens",
      input: 190,
      output: 60,
      total: 250,
      cachedInput: 60,
      reasoningOutput: 15,
    });
    // The other half of the same rollback: reusing `finish` would route the
    // cumulative number into the store's accumulateSessionTokens (a SUM) and
    // double it. No finish-shaped event may ever appear here.
    expect([...first, ...second].some((event) => event.type === "finish")).toBe(false);
  });

  it("still emits context_usage alone when the wire carries no usable `total` (old fixture shape)", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const events = translator.onNotification({
      method: "thread/tokenUsage/updated",
      params: { threadId: THREAD_ID, turnId: TURN_ID, tokenUsage: { last: { totalTokens: 13_495 }, modelContextWindow: 353_400 } },
    });
    expect(types(events)).toEqual(["context_usage"]);
  });

  it("emits engine_session_tokens even when the context fields are unusable (no modelContextWindow)", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const events = translator.onNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: { last: { totalTokens: 10 }, total: { inputTokens: 8, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 10 } },
      },
    });
    expect(types(events)).toEqual(["engine_session_tokens"]);
  });
});

describe("TurnTranslator — engine_quota (cut §6, amendment §A3)", () => {
  /** The engine-owned tracker seam, recorded: the translator must APPLY it, never build a snapshot itself. */
  function quotaSink(): { applied: unknown[]; applyUpdate(params: unknown): { primary: { usedPercent: number }; planType: string; observedAt: string } | null } {
    return {
      applied: [],
      applyUpdate(params: unknown) {
        this.applied.push(params);
        const rateLimits = (params as { rateLimits?: { primary?: { usedPercent?: number } } } | undefined)?.rateLimits;
        const usedPercent = rateLimits?.primary?.usedPercent;
        if (typeof usedPercent !== "number") return null;
        // The MERGED snapshot: fields the push omitted survive from the seed —
        // the exact sparse-merge outcome shared/codex-quota.ts red-proofs.
        return { primary: { usedPercent }, planType: "plus", observedAt: "t2" };
      },
    };
  }

  it("routes the account-scoped push (NO threadId/turnId on the wire) through the tracker and emits the MERGED snapshot", () => {
    const quota = quotaSink();
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1, quota });
    const events = translator.onNotification({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 41 } } },
    });
    // The emitted snapshot is the tracker's merge result — planType came from
    // the earlier seed, NOT from this push. A translator that built the
    // snapshot from the push alone could not carry it, and this goes red.
    expect(events).toEqual([
      { type: "engine_quota", quota: { primary: { usedPercent: 41 }, planType: "plus", observedAt: "t2" } },
    ]);
    expect(quota.applied).toEqual([{ rateLimits: { primary: { usedPercent: 41 } } }]);
  });

  it("an undecodable push (tracker returns null) emits nothing and never fabricates a snapshot", () => {
    const quota = quotaSink();
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1, quota });
    expect(translator.onNotification({ method: "account/rateLimits/updated", params: { nonsense: true } })).toEqual([]);
  });

  it("without a tracker seam the push is silently dropped (no crash, no invented event)", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    expect(translator.onNotification({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 41 } } } })).toEqual([]);
  });
});

/**
 * W17 red-first: replays REAL captured live traces (not synthetic fixtures)
 * through the translator and proves the renderer's documented lifecycle
 * (store.ts:1436 `tool_call -> tool_execution_start -> tool_result`) actually
 * holds on the wire. Before the fix, `onItemStarted` never emitted
 * `{type:"tool_call"}` at all — these assertions were failing (no tool_call
 * event existed to find) on both fixtures, ALLOW and DECLINE alike.
 */
describe("TurnTranslator — live wire: tool_call precedes tool_execution_start (W17)", () => {
  it("w0-command-accept.jsonl (ALLOW): tool_call precedes its tool_execution_start with matching id/name/input", () => {
    const events = translateLiveFixture("w0-command-accept.jsonl");
    const toolCallIndex = events.findIndex((event) => event.type === "tool_call");
    const startIndex = events.findIndex((event) => event.type === "tool_execution_start");
    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(toolCallIndex).toBeLessThan(startIndex);

    const toolCall = events[toolCallIndex] as Extract<AgentEvent, { type: "tool_call" }>;
    const start = events[startIndex] as Extract<AgentEvent, { type: "tool_execution_start" }>;
    expect(toolCall.toolCall.id).toBe(start.toolCallId);
    expect(toolCall.toolCall.name).toBe(start.toolName);
    expect(toolCall.toolCall.input).toEqual(start.input);
    expect(start).toMatchObject({ toolName: "Bash", input: { command: expect.stringContaining("w0-command-sentinel.txt") } });

    const result = events.find((event) => event.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(result?.outcome).toMatchObject({ toolCallId: toolCall.toolCall.id, status: "success" });
  });

  it("w1-p1-command-decline.jsonl (DECLINE): tool_call precedes its tool_execution_start with matching id/name/input, and the outcome is denied", () => {
    const events = translateLiveFixture("w1-p1-command-decline.jsonl");
    const toolCallIndex = events.findIndex((event) => event.type === "tool_call");
    const startIndex = events.findIndex((event) => event.type === "tool_execution_start");
    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(toolCallIndex).toBeLessThan(startIndex);

    const toolCall = events[toolCallIndex] as Extract<AgentEvent, { type: "tool_call" }>;
    const start = events[startIndex] as Extract<AgentEvent, { type: "tool_execution_start" }>;
    expect(toolCall.toolCall.id).toBe(start.toolCallId);
    expect(toolCall.toolCall.name).toBe(start.toolName);
    expect(toolCall.toolCall.input).toEqual(start.input);
    expect(start).toMatchObject({ toolName: "Bash", input: { command: expect.stringContaining("w1-sentinel.txt") } });

    const result = events.find((event) => event.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(result?.outcome).toMatchObject({ toolCallId: toolCall.toolCall.id, status: "denied" });
  });
});

/**
 * W18 (external review MEDIUM, REAL post-W17): a redelivered `item/started`
 * for an id this translator has already started must create ZERO new
 * blocks. Pre-W17 the redelivery was a harmless no-op (onItemStarted never
 * created anything); post-W17 it would append a SECOND tool_call/text_start
 * for the same id — a live duplicate card, since the store appends
 * tool_call without dedup and every later patch keyed by that id updates
 * ALL blocks sharing it.
 */
describe("TurnTranslator — onItemStarted redelivery is idempotent (W18)", () => {
  it("a re-delivered commandExecution item/started creates ZERO additional tool_call/tool_execution_start events", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const startNotification: JsonRpcNotification = {
      method: "item/started",
      params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "x", command: "echo hi" } },
    };
    const first = translator.onNotification(startNotification);
    const redelivered = translator.onNotification(startNotification);

    expect(types(first)).toEqual(["tool_call", "tool_execution_start"]);
    // The redelivery is a pure no-op — not a second tool_call/tool_execution_start pair.
    expect(redelivered).toEqual([]);

    const all = [...first, ...redelivered];
    expect(all.filter((event) => event.type === "tool_call")).toHaveLength(1);
  });

  it("a re-delivered agentMessage item/started creates ZERO additional text_start events", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const startNotification: JsonRpcNotification = {
      method: "item/started",
      params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "agentMessage", id: "message" } },
    };
    const first = translator.onNotification(startNotification);
    const redelivered = translator.onNotification(startNotification);

    expect(first).toEqual([{ type: "text_start", id: "message" }]);
    expect(redelivered).toEqual([]);
  });
});

/**
 * `turn/plan/updated` — Codex's own todo list (the `update_plan` tool's
 * effect). Wire shape is schema-authoritative (codex-cli 0.144.5
 * `TurnPlanUpdatedNotification`): `{threadId, turnId, plan: TurnPlanStep[],
 * explanation?}` where a step is `{step: string, status: "pending" |
 * "inProgress" | "completed"}` — a TURN-scoped notification, NOT a thread
 * item, which is why nothing in the item-projection path ever saw it.
 */
describe("TurnTranslator — turn/plan/updated (Codex plan -> todo card)", () => {
  function planUpdate(plan: unknown, extra: Record<string, unknown> = {}): JsonRpcNotification {
    return { method: "turn/plan/updated", params: { threadId: THREAD_ID, turnId: TURN_ID, plan, ...extra } };
  }

  function inputOf(events: AgentEvent[]): unknown {
    const call = events.find((event) => event.type === "tool_call");
    return (call as { toolCall: { input: unknown } } | undefined)?.toolCall.input;
  }

  it("projects a plan update as a settled TodoWrite card, normalizing inProgress -> in_progress", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const events = translator.onNotification(planUpdate([
      { step: "read the config", status: "completed" },
      { step: "wire the translator", status: "inProgress" },
      { step: "run the gate", status: "pending" },
    ]));

    // The renderer's TodoPanel reads `{todos:[{content,status}]}` off a
    // SUCCESSFUL TodoWrite tool_call block — that shape is the whole contract.
    expect(types(events)).toEqual(["tool_call", "tool_execution_start", "tool_result"]);
    expect(inputOf(events)).toEqual({
      todos: [
        { content: "read the config", status: "completed" },
        { content: "wire the translator", status: "in_progress" },
        { content: "run the gate", status: "pending" },
      ],
    });
    const call = events[0] as { toolCall: { id: string; name: string } };
    expect(call.toolCall.name).toBe("TodoWrite");
    const outcome = (events[2] as { outcome: { toolCallId: string; toolName: string; status: string } }).outcome;
    expect(outcome.status).toBe("success");
    expect(outcome.toolName).toBe("TodoWrite");
    expect(outcome.toolCallId).toBe(call.toolCall.id);
  });

  it("emits a NEW card per revision so the panel's last-wins selection tracks the newest plan", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const first = translator.onNotification(planUpdate([{ step: "one", status: "pending" }]));
    const second = translator.onNotification(planUpdate([{ step: "one", status: "completed" }]));

    const firstId = (first[0] as { toolCall: { id: string } }).toolCall.id;
    const secondId = (second[0] as { toolCall: { id: string } }).toolCall.id;
    // Same id would PATCH the first card (store.ts keys blocks by toolCallId)
    // and leave the panel showing a stale plan forever.
    expect(secondId).not.toBe(firstId);
    expect(inputOf(second)).toEqual({ todos: [{ content: "one", status: "completed" }] });
  });

  it("drops a re-sent identical plan instead of stacking a duplicate card", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const plan = [{ step: "one", status: "inProgress" }];
    translator.onNotification(planUpdate(plan));
    expect(translator.onNotification(planUpdate(plan))).toEqual([]);
  });

  it("keeps a step whose status is an unknown future enum member, degrading it to pending", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    const events = translator.onNotification(planUpdate([{ step: "one", status: "blocked" }]));
    // Dropping the step would silently shrink the plan's N/M counters; the
    // panel would then report progress against a plan the user never wrote.
    expect(inputOf(events)).toEqual({ todos: [{ content: "one", status: "pending" }] });
  });

  it("emits nothing for an empty, malformed, or step-less plan", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    expect(translator.onNotification(planUpdate([]))).toEqual([]);
    expect(translator.onNotification(planUpdate("not-an-array"))).toEqual([]);
    expect(translator.onNotification(planUpdate([{ step: 42, status: "pending" }]))).toEqual([]);
    expect(translator.onNotification(planUpdate([{ step: "", status: "pending" }]))).toEqual([]);
  });

  it("ignores a plan addressed to another turn", () => {
    const translator = new TurnTranslator({ threadId: THREAD_ID, turnId: TURN_ID, turn: 1 });
    expect(translator.onNotification({
      method: "turn/plan/updated",
      params: { threadId: THREAD_ID, turnId: "some-other-turn", plan: [{ step: "one", status: "pending" }] },
    })).toEqual([]);
  });
});

/**
 * Replay of a REAL captured trace (`w2-p1-plan-updated.jsonl`, codex-cli
 * 0.144.5, read-only sandbox): the synthetic tests above encode the schema's
 * promise, this one encodes what the binary actually sent — two `update_plan`
 * revisions of the same three-step plan, `explanation` null on the first and a
 * string on the second, statuses in camelCase.
 */
describe("TurnTranslator — turn/plan/updated against a live capture", () => {
  it("projects both real plan revisions into readable TodoWrite cards", () => {
    const events = translateLiveFixture("w2-p1-plan-updated.jsonl");
    const todoCalls = events.filter(
      (event) => event.type === "tool_call" && (event as { toolCall: { name: string } }).toolCall.name === "TodoWrite",
    ) as unknown as { toolCall: { id: string; input: { todos: { content: string; status: string }[] } } }[];

    expect(todoCalls).toHaveLength(2);
    expect(todoCalls[0]!.toolCall.input.todos.map((todo) => todo.status)).toEqual(["in_progress", "pending", "pending"]);
    expect(todoCalls[1]!.toolCall.input.todos.map((todo) => todo.status)).toEqual(["completed", "in_progress", "pending"]);
    // The plan text is carried verbatim — the panel renders `content`.
    expect(todoCalls[0]!.toolCall.input.todos[0]!.content).toContain("Read the TypeScript file");
    // Distinct ids: a second revision must APPEND a card, not patch the first.
    expect(todoCalls[0]!.toolCall.id).not.toBe(todoCalls[1]!.toolCall.id);

    // Each card settles successfully, which is what makes the panel select it.
    const settled = events.filter(
      (event) => event.type === "tool_result" && (event as { outcome: { toolName: string } }).outcome.toolName === "TodoWrite",
    ) as unknown as { outcome: { status: string } }[];
    expect(settled.map((event) => event.outcome.status)).toEqual(["success", "success"]);
  });
});
