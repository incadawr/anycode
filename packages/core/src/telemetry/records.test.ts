/**
 * records.test.ts (slice 6.6 B7): the whitelist theorem for
 * telemetryRecordFor, verified unit-by-unit. Every mapped AgentEvent variant
 * projects field-by-field; every unmapped variant (including a synthetic
 * future one) maps to null; and a sentinel string planted in EVERY
 * text-bearing carrier never survives into the serialized record.
 */

import { describe, expect, it } from "vitest";
import { buildEngineTelemetryTap, buildSubagentTelemetryTap, buildTelemetryTap, telemetryRecordFor } from "./records.js";
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

  it("subagent_start with model+engine (toolCallId + description still dropped)", () => {
    const event: AgentEvent = {
      type: "subagent_start",
      toolCallId: "call-2",
      agentType: "pb-glm-flash-builder",
      description: SENTINEL,
      model: "glm-5.3-flash",
      engine: "codex",
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "subagent_start",
      agentType: "pb-glm-flash-builder",
      model: "glm-5.3-flash",
      engine: "codex",
    });
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

  // TASK.171: closes the gap where a completed child's model attribution
  // never reached telemetry at all — `model` (the REQUESTED id) and
  // `responseModel` (the provider's own claim) are now whitelisted onto
  // subagent_end, field-by-field, same as every other case in this file.
  it("subagent_end with model+responseModel (toolCallId still dropped, TASK.171 gap closed)", () => {
    const event: AgentEvent = {
      type: "subagent_end",
      toolCallId: "call-2",
      status: "completed",
      turns: 2,
      durationMs: 300,
      model: "glm-5.3-flash",
      responseModel: "glm-5.3",
    };
    expect(telemetryRecordFor(event)).toEqual({
      t: "subagent_end",
      status: "completed",
      turns: 2,
      durationMs: 300,
      model: "glm-5.3-flash",
      responseModel: "glm-5.3",
    });
  });

  it("subagent_end with model but no responseModel — a provider that reported nothing back never fabricates a claim", () => {
    const event: AgentEvent = {
      type: "subagent_end",
      toolCallId: "call-2",
      status: "completed",
      turns: 2,
      durationMs: 300,
      model: "glm-5.3-flash",
    };
    const rec = telemetryRecordFor(event);
    expect(rec).toEqual({
      t: "subagent_end",
      status: "completed",
      turns: 2,
      durationMs: 300,
      model: "glm-5.3-flash",
    });
    expect(rec && "responseModel" in rec).toBe(false);
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
  it("subagent_start.description (with model+engine present)", () =>
    assertNoLeak({
      type: "subagent_start",
      toolCallId: "1",
      agentType: "clean-agent",
      description: SENTINEL,
      model: "sonnet",
      engine: "claude",
    }));
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

describe("buildSubagentTelemetryTap", () => {
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

  it("stamps sub on a usage record", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildSubagentTelemetryTap(port, "parent-session", { agentType: "pb-glm-flash-builder" });
    tap({ type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      v: 1,
      session: "parent-session",
      sub: { agentType: "pb-glm-flash-builder" },
      t: "usage",
      totalTokens: 15,
    });
  });

  it("stamps sub on a tool record and includes model when the spawn overrode it", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildSubagentTelemetryTap(port, "parent-session", {
      agentType: "pb-claude-reviewer",
      model: "claude-sonnet5-high",
    });
    tap({
      type: "tool_result",
      outcome: { toolCallId: "c1", toolName: "Bash", status: "success", modelText: SENTINEL, durationMs: 7 },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sub: { agentType: "pb-claude-reviewer", model: "claude-sonnet5-high" },
      t: "tool",
      tool: "Bash",
    });
  });

  it("stamps sub on a turn_end record", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildSubagentTelemetryTap(port, "parent-session", { agentType: "explore" });
    tap({ type: "turn_end", turn: 2, finishReason: "stop" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sub: { agentType: "explore" }, t: "turn_end", turn: 2 });
  });

  it("does not record (and so does not stamp sub) for a null-mapped event", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildSubagentTelemetryTap(port, "parent-session", { agentType: "explore" });
    tap({ type: "text_delta", id: "1", text: SENTINEL });
    expect(records).toHaveLength(0);
  });

  it("omits sub.model entirely when the spawn did not override the model", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildSubagentTelemetryTap(port, "parent-session", { agentType: "explore" });
    tap({ type: "turn_end", turn: 1, finishReason: "stop" });
    expect(records[0]).toEqual(
      expect.objectContaining({ sub: { agentType: "explore" } }),
    );
    expect((records[0] as { sub?: { model?: string } }).sub).not.toHaveProperty("model");
  });
});

describe("buildEngineTelemetryTap", () => {
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

  it("double-count pin: cumulative (100, 250) -> usage deltas (100, 150), sum 250 NOT 350 — input/output symmetric", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex");
    tap({ type: "engine_session_tokens", input: 80, output: 20, total: 100 });
    tap({ type: "engine_session_tokens", input: 200, output: 50, total: 250 });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ t: "usage", inputTokens: 80, outputTokens: 20, totalTokens: 100 });
    expect(records[1]).toMatchObject({ t: "usage", inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    const sumTotal = records.reduce((acc, r) => acc + (r as { totalTokens?: number }).totalTokens!, 0);
    const sumInput = records.reduce((acc, r) => acc + (r as { inputTokens?: number }).inputTokens!, 0);
    const sumOutput = records.reduce((acc, r) => acc + (r as { outputTokens?: number }).outputTokens!, 0);
    expect(sumTotal).toBe(250);
    expect(sumTotal).not.toBe(350);
    expect(sumInput).toBe(200);
    expect(sumInput).not.toBe(280);
    expect(sumOutput).toBe(50);
    expect(sumOutput).not.toBe(70);
  });

  it("reset pin: a symmetric drop (total 250->40, input 200->30, output 50->10) starts a new baseline for all three, none negative", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex");
    tap({ type: "engine_session_tokens", input: 200, output: 50, total: 250 });
    tap({ type: "engine_session_tokens", input: 30, output: 10, total: 40 });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ t: "usage", inputTokens: 200, outputTokens: 50, totalTokens: 250 });
    expect(records[1]).toMatchObject({ t: "usage", inputTokens: 30, outputTokens: 10, totalTokens: 40 });
  });

  it("reset pin: total resets (250->40) while input does NOT (200->210) — each counter independent, none negative", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex");
    tap({ type: "engine_session_tokens", input: 200, output: 50, total: 250 });
    tap({ type: "engine_session_tokens", input: 210, output: 5, total: 40 });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ t: "usage", inputTokens: 200, outputTokens: 50, totalTokens: 250 });
    // total reset (40 < 250) -> delta = 40; input NOT reset (210 >= 200) -> delta = 10; output reset (5 < 50) -> delta = 5.
    expect(records[1]).toMatchObject({ t: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 40 });
    for (const r of records) {
      expect((r as { inputTokens?: number }).inputTokens).toBeGreaterThanOrEqual(0);
      expect((r as { outputTokens?: number }).outputTokens).toBeGreaterThanOrEqual(0);
      expect((r as { totalTokens?: number }).totalTokens).toBeGreaterThanOrEqual(0);
    }
  });

  it("skips a zero delta (no-op snapshot emits nothing, gated on total only)", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex");
    tap({ type: "engine_session_tokens", input: 80, output: 20, total: 100 });
    tap({ type: "engine_session_tokens", input: 80, output: 20, total: 100 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ t: "usage", inputTokens: 80, outputTokens: 20, totalTokens: 100 });
  });

  it("baselineFromFirstEvent:true — first snapshot emits nothing, second emits deltas for all three counters", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex-resume", { baselineFromFirstEvent: true });
    tap({ type: "engine_session_tokens", input: 800, output: 200, total: 1000 });
    expect(records).toHaveLength(0);
    tap({ type: "engine_session_tokens", input: 824, output: 206, total: 1030 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ t: "usage", inputTokens: 24, outputTokens: 6, totalTokens: 30 });
  });

  it("baselineFromFirstEvent omitted (fresh boot) — first snapshot's deltas equal their totals for all three counters", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex-fresh");
    tap({ type: "engine_session_tokens", input: 40, output: 10, total: 50 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ t: "usage", inputTokens: 40, outputTokens: 10, totalTokens: 50 });
  });

  it("event carrying total without input/output -> record has totalTokens only, inputTokens/outputTokens keys absent", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex");
    const malformed = { type: "engine_session_tokens", total: 100 } as unknown as AgentEvent;
    tap(malformed);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ t: "usage", totalTokens: 100 });
    expect(records[0]).not.toHaveProperty("inputTokens");
    expect(records[0]).not.toHaveProperty("outputTokens");
  });

  it("passes non-engine events through telemetryRecordFor unchanged, tagged with no sub", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex");
    tap({ type: "turn_end", turn: 1, finishReason: "stop" });
    tap({
      type: "tool_result",
      outcome: { toolCallId: "c1", toolName: "Bash", status: "success", modelText: SENTINEL, durationMs: 3 },
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ t: "turn_end", turn: 1 });
    expect(records[0]).not.toHaveProperty("sub");
    expect(records[1]).toMatchObject({ t: "tool", tool: "Bash" });
  });

  it("still fail-closed for an unmapped/unwhitelisted non-token event (e.g. a future variant)", () => {
    const { port, records } = makeRecordingPort();
    const tap = buildEngineTelemetryTap(port, "session-codex");
    tap({ type: "text_delta", id: "1", text: SENTINEL });
    expect(records).toHaveLength(0);
  });
});
