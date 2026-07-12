/**
 * records.ts (slice 6.6, design slice-6.6-cut.md §2-B2): the whitelist
 * projection AgentEvent -> telemetry record, and the tap closure that wires a
 * TelemetryPort into AgentLoopConfig.eventTap.
 */

import type { AgentEvent } from "../types/events.js";
import type { TelemetryEventRecord, TelemetryPort } from "../ports/telemetry.js";

/** Pure whitelist projection AgentEvent -> telemetry record (slice 6.6).
 *  Fields are copied ONE BY ONE and never spread from the event; every event
 *  variant not listed — including any FUTURE variant — maps to null
 *  (fail-closed). Text-bearing fields (deltas, inputs, outputs, error
 *  messages, descriptions, labels, retry reasons, workflow names) are
 *  deliberately dropped. */
export function telemetryRecordFor(event: AgentEvent): TelemetryEventRecord | null {
  switch (event.type) {
    case "turn_end":
      return { t: "turn_end", turn: event.turn, finishReason: event.finishReason };
    case "finish":
      return {
        t: "usage",
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        totalTokens: event.usage.totalTokens,
      };
    case "tool_result":
      return {
        t: "tool",
        tool: event.outcome.toolName,
        status: event.outcome.status,
        durationMs: event.outcome.durationMs,
      };
    case "loop_end":
      return { t: "loop_end", reason: event.reason, turns: event.turns };
    case "compaction_start":
      return { t: "compaction_start", trigger: event.trigger };
    case "compaction_end":
      return {
        t: "compaction_end",
        ok: event.ok,
        preTokens: event.preTokens,
        postTokens: event.postTokens,
        durationMs: event.durationMs,
      };
    case "microcompact":
      return {
        t: "microcompact",
        clearedToolResults: event.clearedToolResults,
        savedTokens: event.savedTokens,
      };
    case "context_usage":
      return {
        t: "context_usage",
        estimatedTokens: event.estimatedTokens,
        budgetTokens: event.budgetTokens,
        source: event.source,
      };
    case "subagent_start":
      return { t: "subagent_start", agentType: event.agentType };
    case "subagent_end":
      return {
        t: "subagent_end",
        status: event.status,
        turns: event.turns,
        durationMs: event.durationMs,
      };
    case "workflow_end":
      return {
        t: "workflow_end",
        status: event.status,
        completedSteps: event.completedSteps,
        totalSteps: event.totalSteps,
        durationMs: event.durationMs,
      };
    case "stream_retry":
      return {
        t: "stream_retry",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      };
    case "error":
      return { t: "error" };
    case "checkpoint_created":
      return { t: "checkpoint_created" };
    case "checkpoint_failed":
      return { t: "checkpoint_failed" };
    default:
      return null;
  }
}

/** Composes the mapper with a sink into an AgentLoopConfig.eventTap closure —
 *  the ONE shared tap both wiring paths (cli/main.ts, desktop host) attach. */
export function buildTelemetryTap(
  port: TelemetryPort,
  session: string,
): (event: AgentEvent) => void {
  return (event) => {
    const rec = telemetryRecordFor(event);
    if (rec !== null) {
      port.record({ v: 1, ts: Date.now(), session, ...rec });
    }
  };
}
