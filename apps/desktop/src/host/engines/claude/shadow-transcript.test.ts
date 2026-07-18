/**
 * cut §1.5 DoD-2 (transcript resume) / DoD-5 (sentinel-leak). `projectClaudeTurn`
 * is the write side of the shadow transcript mirror: it turns one turn's
 * already-translated `AgentEvent` stream into ready `HistoryItem` PROJECTIONS
 * (cut §1.5) — never raw wire bytes, which is what makes DoD-5 true by
 * construction rather than by redaction: `initialize`'s `account`
 * (email/tokens) and `get_context_usage.memoryFiles[]` (the 0-token home-path
 * metadata, C2) never reach `AgentEvent` at all, so `projectClaudeTurn` has
 * no way to persist either sentinel class even if fed a message that carries
 * them.
 *
 * `ClaudeShadowTranscriptEngine` is exercised against a scripted fake engine
 * (no real child process) — the same seam-testing style claude-engine.test.ts
 * uses for its own transport double.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, HistoryItem } from "@anycode/core";
import type { RunTurnOptions } from "../session-engine.js";
import {
  ClaudeShadowTranscriptEngine,
  projectClaudeTurn,
  type ClaudeShadowTranscriptPort,
} from "./shadow-transcript.js";
import { ClaudeTurnTranslator } from "./event-translator.js";
import type { ClaudeSystemInitMessage } from "./protocol.js";

function tick(): () => number {
  let n = 0;
  return () => n++;
}

describe("projectClaudeTurn (cut §1.5, shadow-transcript write side)", () => {
  it("projects the user input, streamed assistant text, and a tool_call/tool_result pair, in order", () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "text_start", id: "m1:0" },
      { type: "text_delta", id: "m1:0", text: "Hel" },
      { type: "text_delta", id: "m1:0", text: "lo" },
      { type: "text_end", id: "m1:0" },
      { type: "tool_call", toolCall: { id: "call-1", name: "Bash", input: { command: "echo hi" } } },
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", input: { command: "echo hi" } },
      {
        type: "tool_result",
        outcome: { toolCallId: "call-1", toolName: "Bash", status: "success", modelText: "hi\n", durationMs: 5 },
      },
      { type: "turn_end", turn: 1, finishReason: "stop" },
      { type: "loop_end", reason: "completed", turns: 1 },
    ];

    const items = projectClaudeTurn("remember: parusnik", events, tick());

    expect(items.map((item) => item.message)).toEqual([
      { role: "user", content: "remember: parusnik" },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "tool_call", toolCallId: "call-1", toolName: "Bash", input: { command: "echo hi" } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call-1", toolName: "Bash", text: "hi\n", status: "success" }] },
    ]);
    // createdAt strictly increases — resume ordering (history-projection.ts)
    // depends on turnOrdinal/positionInTurn, not on this value, but a turn's
    // own items must never sort out of wire order on ties.
    const createdAts = items.map((item) => item.createdAt);
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    expect(new Set(createdAts).size).toBe(createdAts.length);
  });

  it("drops reasoning and engine-state events — core's ChatMessage has no assistant slot for thinking", () => {
    const events: AgentEvent[] = [
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "thinking..." },
      { type: "reasoning_end", id: "r1" },
      { type: "engine_notice", level: "info", message: "Claude is compacting the conversation context." },
      { type: "context_usage", estimatedTokens: 10, budgetTokens: 100, source: "provider" },
      { type: "turn_end", turn: 1, finishReason: "stop" },
      { type: "loop_end", reason: "completed", turns: 1 },
    ];
    const items = projectClaudeTurn("hello", events, tick());
    expect(items).toHaveLength(1); // only the synthesized user item
    expect(items[0]!.message).toEqual({ role: "user", content: "hello" });
  });

  it("skips an empty final text buffer (a text_start/text_end pair with no delta)", () => {
    const events: AgentEvent[] = [
      { type: "text_start", id: "m1:0" },
      { type: "text_end", id: "m1:0" },
    ];
    const items = projectClaudeTurn("hi", events, tick());
    expect(items).toHaveLength(1);
  });

  it("DoD-5 sentinel-leak: a system/init frame carrying account/memory-path PII never reaches the projection", () => {
    // A raw system/init frame is turn-scoped and IS observed by the same
    // translator whose output feeds projectClaudeTurn — but see custody:
    // `onInit` never turns into an AgentEvent (event-translator.ts's onSystem
    // returns [] for the init subtype), so nothing derived from it can ever
    // reach the mirror.
    const initWithPii = {
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-opus-4-8",
      permissionMode: "default",
      cwd: "/Users/testuser/projects/app",
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      capabilities: ["interrupt_receipt_v1"],
      claude_code_version: "2.1.212",
      account: { email: "owner@example.com", tokenSource: "keychain", subscriptionType: "max" },
      memory_paths: { auto: "/Users/testuser/.claude/projects/-Users-testuser-app/memory/" },
    } as unknown as ClaudeSystemInitMessage;

    const translator = new ClaudeTurnTranslator({ turn: 1 });
    const fromInit = translator.onMessage(initWithPii);
    expect(fromInit).toEqual([]);

    const events: AgentEvent[] = [
      ...fromInit,
      { type: "text_start", id: "m1:0" },
      { type: "text_delta", id: "m1:0", text: "ok" },
      { type: "text_end", id: "m1:0" },
    ];
    const items = projectClaudeTurn("hi", events, tick());
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("/Users/testuser");
    expect(serialized).not.toContain("-Users-testuser");
    expect(serialized).not.toContain("keychain");
  });
});

/** Minimal scripted engine double — no real child process, mirrors claude-engine.test.ts's transport-seam style. */
function fakeEngine(turnEvents: AgentEvent[][], resolved: { model: string | null; permissionMode: string | null }) {
  let call = 0;
  return {
    id: "claude" as const,
    capabilities: {
      supportsCorePermissions: false,
      supportsRewind: false,
      supportsWorkflow: false,
      supportsGitMutations: false,
      supportsContextUsage: true,
      supportsContextBreakdown: false,
      supportsInteractiveApprovals: false,
      costAccounting: true,
      supportsModelSelection: true,
      supportsReasoningEffort: true,
      supportsImages: false,
      supportsTasks: false,
      supportsFileSnapshots: false,
    },
    mode: () => "build" as const,
    reasoningEffort: () => undefined,
    setReasoningEffort: () => {},
    historyItems: () => [] as readonly HistoryItem[],
    async *runTurn(_input: string, _options: RunTurnOptions): AsyncIterable<AgentEvent> {
      const events = turnEvents[call++] ?? [];
      for (const event of events) yield event;
    },
    dispose: async () => {},
    resolvedModel: () => resolved.model,
    resolvedPermissionMode: () => resolved.permissionMode,
  };
}

function fakeOptions(): RunTurnOptions {
  return { signal: new AbortController().signal };
}

async function drain(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe("ClaudeShadowTranscriptEngine (cut §1.5 D1/D2)", () => {
  it("forwards every event unchanged and records the projected turn fire-and-forget", async () => {
    const turn1: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "text_start", id: "m1:0" },
      { type: "text_delta", id: "m1:0", text: "parusnik" },
      { type: "text_end", id: "m1:0" },
      { type: "turn_end", turn: 1, finishReason: "stop" },
      { type: "loop_end", reason: "completed", turns: 1 },
    ];
    const engine = fakeEngine([turn1], { model: null, permissionMode: null });
    const recorded: { sessionRef: string; items: unknown }[] = [];
    const sink: ClaudeShadowTranscriptPort = {
      record: (sessionRef, items) => recorded.push({ sessionRef, items }),
      list: async () => [],
    };
    const wrapped = new ClaudeShadowTranscriptEngine(engine, sink, "session-ref-1", [], 0, undefined, tick());

    const forwarded = await drain(wrapped.runTurn("remember: parusnik", fakeOptions()));
    expect(forwarded).toEqual(turn1);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.sessionRef).toBe("session-ref-1");
    const items = recorded[0]!.items as { turnOrdinal: number; positionInTurn: number; itemId: string; data: HistoryItem }[];
    expect(items.map((i) => i.turnOrdinal)).toEqual([0, 0]);
    expect(items.map((i) => i.positionInTurn)).toEqual([0, 1]);
    expect(items.map((i) => i.itemId)).toEqual(["0:0", "0:1"]);
    expect(items[1]!.data.message).toEqual({ role: "assistant", content: [{ type: "text", text: "parusnik" }] });
  });

  it("historyItems() returns the boot-time mirror read, not the underlying (always-empty) engine's own", () => {
    const engine = fakeEngine([], { model: null, permissionMode: null });
    const sink: ClaudeShadowTranscriptPort = { record: () => {}, list: async () => [] };
    const bootHistory: HistoryItem[] = [{ id: "prior-turn", createdAt: 0, message: { role: "user", content: "earlier" } }];
    const wrapped = new ClaudeShadowTranscriptEngine(engine, sink, "session-ref-1", bootHistory);
    expect(wrapped.historyItems()).toBe(bootHistory);
  });

  it("continues turnOrdinal from the resume-supplied starting value, never restarting at 0", async () => {
    const engine = fakeEngine([[{ type: "turn_end", turn: 1, finishReason: "stop" }, { type: "loop_end", reason: "completed", turns: 1 }]], {
      model: null,
      permissionMode: null,
    });
    const recorded: { turnOrdinal: number }[] = [];
    const sink: ClaudeShadowTranscriptPort = {
      record: (_ref, items) => recorded.push(...items.map((i) => ({ turnOrdinal: i.turnOrdinal }))),
      list: async () => [],
    };
    const wrapped = new ClaudeShadowTranscriptEngine(engine, sink, "session-ref-1", [], 3, undefined, tick());
    await drain(wrapped.runTurn("next", fakeOptions()));
    expect(recorded.every((r) => r.turnOrdinal === 3)).toBe(true);
  });

  it("fires onFirstTurnSettled exactly once, with the resolved model/permissionMode, after the first turn completes", async () => {
    const engine = fakeEngine(
      [
        [{ type: "turn_end", turn: 1, finishReason: "stop" }, { type: "loop_end", reason: "completed", turns: 1 }],
        [{ type: "turn_end", turn: 2, finishReason: "stop" }, { type: "loop_end", reason: "completed", turns: 1 }],
      ],
      { model: "claude-opus-4-8", permissionMode: "plan" },
    );
    const sink: ClaudeShadowTranscriptPort = { record: () => {}, list: async () => [] };
    const settled = vi.fn();
    const wrapped = new ClaudeShadowTranscriptEngine(engine, sink, "session-ref-1", [], 0, settled, tick());

    await drain(wrapped.runTurn("first", fakeOptions()));
    await drain(wrapped.runTurn("second", fakeOptions()));

    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({ model: "claude-opus-4-8", permissionMode: "plan" });
  });

  it("never calls onFirstTurnSettled when the resolved model/permissionMode are still null (no system/init observed)", async () => {
    const engine = fakeEngine([[{ type: "turn_end", turn: 1, finishReason: "stop" }, { type: "loop_end", reason: "completed", turns: 1 }]], {
      model: null,
      permissionMode: null,
    });
    const sink: ClaudeShadowTranscriptPort = { record: () => {}, list: async () => [] };
    const settled = vi.fn();
    const wrapped = new ClaudeShadowTranscriptEngine(engine, sink, "session-ref-1", [], 0, settled, tick());
    await drain(wrapped.runTurn("first", fakeOptions()));
    expect(settled).not.toHaveBeenCalled();
  });
});
