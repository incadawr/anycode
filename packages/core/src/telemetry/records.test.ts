/**
 * records.test.ts (slice 6.6 B7): the whitelist theorem for
 * telemetryRecordFor, verified unit-by-unit. Every mapped AgentEvent variant
 * projects field-by-field; every unmapped variant (including a synthetic
 * future one) maps to null; and a sentinel string planted in EVERY
 * text-bearing carrier never survives into the serialized record.
 */

import { describe, expect, it } from "vitest";
import { buildTelemetryTap, telemetryRecordFor } from "./records.js";
import type { AgentEvent } from "../types/events.js";
import type { TelemetryPort, TelemetryRecord } from "../ports/telemetry.js";

const SENTINEL = "LEAK_SENTINEL_7f3a9c";

describe("telemetryRecordFor — mapped variants (whitelist, field-by-field)", () => {
  it("turn_end", () => {
    const event: AgentEvent = { type: "turn_end", turn: 3, finishReason: "stop" };
    expect(telemetryRecordFor(event)).toEqual({ t: "turn_end", turn: 3, finishReason: "stop" });
  });

  it("finish -> usage", () => {
    const event: AgentEvent = {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "usage",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
  });

  it("finish -> usage with partial fields", () => {
    const event: AgentEvent = {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 5 },
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "usage",
      inputTokens: 5,
      outputTokens: undefined,
      totalTokens: undefined,
    });
  });

  it("tool_result -> tool", () => {
    const event: AgentEvent = {
      type: "tool_result",
      outcome: {
        toolCallId: "call-1",
        toolName: "Bash",
        status: "success",
        modelText: SENTINEL,
        durationMs: 42,
      },
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "tool",
      tool: "Bash",
      status: "success",
      durationMs: 42,
    });
  });

  it("loop_end", () => {
    const event: AgentEvent = { type: "loop_end", reason: "completed", turns: 4 };
    expect(telemetryRecordFor(event)).toEqual({ t: "loop_end", reason: "completed", turns: 4 });
  });

  it("compaction_start", () => {
    const event: AgentEvent = { type: "compaction_start", trigger: "manual" };
    expect(telemetryRecordFor(event)).toEqual({ t: "compaction_start", trigger: "manual" });
  });

  it("compaction_end (error dropped)", () => {
    const event: AgentEvent = {
      type: "compaction_end",
      ok: false,
      preTokens: 1000,
      postTokens: 400,
      durationMs: 50,
      error: SENTINEL,
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "compaction_end",
      ok: false,
      preTokens: 1000,
      postTokens: 400,
      durationMs: 50,
    });
  });

  it("microcompact", () => {
    const event: AgentEvent = { type: "microcompact", clearedToolResults: 3, savedTokens: 900 };
    expect(telemetryRecordFor(event)).toEqual({
      t: "microcompact",
      clearedToolResults: 3,
      savedTokens: 900,
    });
  });

  it("context_usage", () => {
    const event: AgentEvent = {
      type: "context_usage",
      estimatedTokens: 5000,
      budgetTokens: 100000,
      source: "provider",
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "context_usage",
      estimatedTokens: 5000,
      budgetTokens: 100000,
      source: "provider",
    });
  });

  it("subagent_start (toolCallId + description dropped)", () => {
    const event: AgentEvent = {
      type: "subagent_start",
      toolCallId: "call-2",
      agentType: "sonnet",
      description: SENTINEL,
    };
    expect(telemetryRecordFor(event)).toEqual({ t: "subagent_start", agentType: "sonnet" });
  });

  it("subagent_end (toolCallId dropped)", () => {
    const event: AgentEvent = {
      type: "subagent_end",
      toolCallId: "call-2",
      status: "completed",
      turns: 2,
      durationMs: 300,
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "subagent_end",
      status: "completed",
      turns: 2,
      durationMs: 300,
    });
  });

  it("workflow_end (toolCallId dropped)", () => {
    const event: AgentEvent = {
      type: "workflow_end",
      toolCallId: "call-3",
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      durationMs: 500,
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "workflow_end",
      status: "completed",
      completedSteps: 2,
      totalSteps: 2,
      durationMs: 500,
    });
  });

  it("stream_retry (reason dropped)", () => {
    const event: AgentEvent = {
      type: "stream_retry",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1000,
      reason: SENTINEL,
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "stream_retry",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1000,
    });
  });

  it("error (value dropped, presence-only)", () => {
    const event: AgentEvent = { type: "error", error: SENTINEL };
    expect(telemetryRecordFor(event)).toEqual({ t: "error" });
  });

  it("checkpoint_created (id/label dropped, presence-only)", () => {
    const event: AgentEvent = { type: "checkpoint_created", id: "chk-1", label: SENTINEL };
    expect(telemetryRecordFor(event)).toEqual({ t: "checkpoint_created" });
  });

  it("checkpoint_failed (reason dropped, presence-only)", () => {
    const event: AgentEvent = { type: "checkpoint_failed", reason: SENTINEL };
    expect(telemetryRecordFor(event)).toEqual({ t: "checkpoint_failed" });
  });
});

describe("telemetryRecordFor — unmapped variants -> null (fail-closed)", () => {
  const unmapped: AgentEvent[] = [
    { type: "start" },
    { type: "text_start", id: "1" },
    { type: "text_delta", id: "1", text: SENTINEL },
    { type: "text_end", id: "1" },
    { type: "reasoning_start", id: "1" },
    { type: "reasoning_delta", id: "1", text: SENTINEL },
    { type: "reasoning_end", id: "1" },
    { type: "tool_input_start", id: "1", toolName: "Bash" },
    { type: "tool_input_delta", id: "1", delta: SENTINEL },
    { type: "tool_input_end", id: "1" },
    { type: "tool_call", toolCall: { id: "1", name: "Bash", input: { cmd: SENTINEL } } },
    { type: "tool_execution_start", toolCallId: "1", toolName: "Bash", input: { cmd: SENTINEL } },
    { type: "turn_start", turn: 1 },
    { type: "subagent_progress", toolCallId: "1", turns: 1, toolCalls: 1, lastTool: SENTINEL },
    { type: "workflow_start", toolCallId: "1", workflow: SENTINEL, totalSteps: 2 },
    { type: "workflow_step_start", toolCallId: "1", stepId: "s1", agentType: "sonnet" },
    {
      type: "workflow_step_progress",
      toolCallId: "1",
      stepId: "s1",
      turns: 1,
      toolCalls: 1,
      lastTool: SENTINEL,
    },
    {
      type: "workflow_step_end",
      toolCallId: "1",
      stepId: "s1",
      status: "completed",
      turns: 1,
      durationMs: 10,
    },
  ];

  it.each(unmapped.map((event) => [event.type, event] as const))("%s -> null", (_label, event) => {
    expect(telemetryRecordFor(event)).toBeNull();
  });

  it("a synthetic/future variant -> null (fail-closed default)", () => {
    const futureEvent = { type: "some_future_event_kind", data: SENTINEL } as unknown as AgentEvent;
    expect(telemetryRecordFor(futureEvent)).toBeNull();
  });
});

describe("telemetryRecordFor — sentinel-leak invariant across every text carrier", () => {
  function assertNoLeak(event: AgentEvent): void {
    const rec = telemetryRecordFor(event);
    const serialized = JSON.stringify(rec);
    expect(serialized === undefined ? "null" : serialized).not.toContain(SENTINEL);
  }

  it("text_delta.text", () => assertNoLeak({ type: "text_delta", id: "1", text: SENTINEL }));
  it("reasoning_delta.text", () => assertNoLeak({ type: "reasoning_delta", id: "1", text: SENTINEL }));
  it("tool_execution_start.input", () =>
    assertNoLeak({ type: "tool_execution_start", toolCallId: "1", toolName: "Bash", input: SENTINEL }));
  it("tool_result.outcome.modelText", () =>
    assertNoLeak({
      type: "tool_result",
      outcome: {
        toolCallId: "1",
        toolName: "Bash",
        status: "success",
        modelText: SENTINEL,
        durationMs: 1,
      },
    }));
  it("compaction_end.error", () =>
    assertNoLeak({
      type: "compaction_end",
      ok: false,
      preTokens: 1,
      durationMs: 1,
      error: SENTINEL,
    }));
  it("subagent_start.description", () =>
    assertNoLeak({ type: "subagent_start", toolCallId: "1", agentType: "clean-agent", description: SENTINEL }));
  it("checkpoint_created.label", () =>
    assertNoLeak({ type: "checkpoint_created", id: "chk-1", label: SENTINEL }));
  it("checkpoint_failed.reason", () => assertNoLeak({ type: "checkpoint_failed", reason: SENTINEL }));
  it("stream_retry.reason", () =>
    assertNoLeak({ type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 100, reason: SENTINEL }));
  it("error.error", () => assertNoLeak({ type: "error", error: SENTINEL }));
  it("workflow_start.workflow (name)", () =>
    assertNoLeak({ type: "workflow_start", toolCallId: "1", workflow: SENTINEL, totalSteps: 1 }));
});

describe("buildTelemetryTap", () => {
  function makeRecordingPort(): { port: TelemetryPort; records: TelemetryRecord[] } {
    const records: TelemetryRecord[] = [];
    const port: TelemetryPort = {
      record: (record) => {
        records.push(record);
      },
      status: () => ({ filePath: "/tmp/x.jsonl", written: records.length, dropped: 0 }),
      flush: async () => {},
      dispose: async () => {},
    };
    return { port, records };
  }

  it("forwards a mapped event to port.record with v/ts/session envelope + whitelist fields", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildTelemetryTap(port, "session-abc");
    tap({ type: "turn_end", turn: 1, finishReason: "stop" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ v: 1, session: "session-abc", t: "turn_end", turn: 1, finishReason: "stop" });
    expect(typeof records[0]!.ts).toBe("number");
  });

  it("does not call port.record for an unmapped event", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildTelemetryTap(port, "session-abc");
    tap({ type: "text_delta", id: "1", text: SENTINEL });
    expect(records).toHaveLength(0);
  });
});
