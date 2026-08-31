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
      return {
        t: "subagent_start",
        agentType: event.agentType,
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.engine !== undefined ? { engine: event.engine } : {}),
      };
    case "subagent_end":
      // TASK.171: closes the known gap where a completed child's model
      // attribution never reached telemetry at all. `model` (the REQUESTED
      // id, owner's ruling: "модель никогда не ответит, главное какие
      // запросы мы шлем") and `responseModel` (the provider's own claim,
      // kept as separate evidence for TASK.174) are added field-by-field,
      // same whitelist discipline as every other case here — this stays a
      // projection, never a spread of the raw event.
      return {
        t: "subagent_end",
        status: event.status,
        turns: event.turns,
        durationMs: event.durationMs,
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.responseModel !== undefined ? { responseModel: event.responseModel } : {}),
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
    case "degeneration":
      return {
        t: "degeneration",
        channel: event.channel,
        period: event.period,
        repeats: event.repeats,
        turn: event.turn,
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

/**
 * Telemetry track (TASK.160): the tap an inline subagent's child AgentLoop
 * gets, so its usage/tool/turn_end records land in the PARENT's sink
 * (decision §2.2 option а — same file, marked by tier) with the child's
 * `agentType`/`model` stamped as the envelope's `sub`. Same whitelist as
 * buildTelemetryTap (telemetryRecordFor) — a null-mapped event is never
 * stamped or recorded.
 */
export function buildSubagentTelemetryTap(
  port: TelemetryPort,
  session: string,
  spawn: { agentType: string; model?: string },
): (event: AgentEvent) => void {
  const sub = {
    agentType: spawn.agentType,
    ...(spawn.model !== undefined ? { model: spawn.model } : {}),
  };
  return (event) => {
    const rec = telemetryRecordFor(event);
    if (rec !== null) {
      port.record({ v: 1, ts: Date.now(), session, sub, ...rec });
    }
  };
}

/** `d = cur >= prev ? cur - prev : cur` — shared by all three engine-tap
 *  counters (total/input/output): a drop means THAT counter's own reset, so
 *  the lower value becomes its next baseline rather than going negative. */
function deltaSince(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

/**
 * Telemetry track (TASK.159 §2.3): the tap a codex/claude engine boot passes
 * as its Session.eventTap. `engine_session_tokens` is NOT in
 * telemetryRecordFor's whitelist (it is CUMULATIVE — replace, not
 * accumulate, per events.ts ~:283-302) and is intercepted here BEFORE the
 * whitelist: this stateful shim converts it to a standard additive
 * `t:"usage"` record holding only the delta since the previous snapshot.
 * `total`/`input`/`output` are three INDEPENDENT cumulative counters on the
 * wire — each gets its own baseline and its own `deltaSince` (a reset of
 * `total` alone does not reset `input`/`output`, and vice versa) — matching
 * the core path (`finish` -> `usage`, ~:20-26) which always carries both
 * halves when present. `inputTokens`/`outputTokens` are set on the record
 * only when the source event actually carried that part (key absent, never
 * `undefined`, when it didn't); `totalTokens` is always present. Record
 * emission is gated ONLY on the `total` delta being nonzero (a no-op turn
 * emits nothing) — the input/output deltas ride along whatever that decision
 * is, even a zero per-field delta, as long as the field was present. Every
 * other event passes through telemetryRecordFor unchanged, so
 * engine_quota/preview_console/etc. still fail-closed to null exactly as
 * buildTelemetryTap does.
 *
 * `opts.baselineFromFirstEvent` (default false): a codex RESUME boot's first
 * `engine_session_tokens` snapshot already includes pre-restart history that
 * was recorded in this same file on the earlier boot — pass `true` so that
 * first snapshot only SETS the baseline for ALL THREE counters (emits
 * nothing) instead of being recorded as a fresh delta. Fresh boots (and
 * claude, whose accumulator is per-process) pass `false`/omit — the implicit
 * baseline is 0 for all three, so the first snapshot's deltas equal their
 * totals.
 */
export function buildEngineTelemetryTap(
  port: TelemetryPort,
  session: string,
  opts?: { baselineFromFirstEvent?: boolean },
): (event: AgentEvent) => void {
  let prevTotal = 0;
  let prevInput = 0;
  let prevOutput = 0;
  let awaitingBaseline = opts?.baselineFromFirstEvent === true;
  return (event) => {
    if (event.type === "engine_session_tokens") {
      const total = event.total;
      const input = event.input;
      const output = event.output;
      if (awaitingBaseline) {
        prevTotal = total;
        if (typeof input === "number") prevInput = input;
        if (typeof output === "number") prevOutput = output;
        awaitingBaseline = false;
        return;
      }
      const totalDelta = deltaSince(total, prevTotal);
      prevTotal = total;
      if (totalDelta === 0) return;
      let inputDelta: number | undefined;
      if (typeof input === "number") {
        inputDelta = deltaSince(input, prevInput);
        prevInput = input;
      }
      let outputDelta: number | undefined;
      if (typeof output === "number") {
        outputDelta = deltaSince(output, prevOutput);
        prevOutput = output;
      }
      port.record({
        v: 1,
        ts: Date.now(),
        session,
        t: "usage",
        ...(inputDelta !== undefined ? { inputTokens: inputDelta } : {}),
        ...(outputDelta !== undefined ? { outputTokens: outputDelta } : {}),
        totalTokens: totalDelta,
      });
      return;
    }
    const rec = telemetryRecordFor(event);
    if (rec !== null) {
      port.record({ v: 1, ts: Date.now(), session, ...rec });
    }
  };
}
