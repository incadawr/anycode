/**
 * TelemetryPort (slice 6.6, design slice-6.6-cut.md §2-B1): a local, opt-in,
 * append-only observability sink. The frozen record union below IS the
 * privacy theorem — every field of every variant is a name/enum/number/
 * boolean by type, so a free-form text field (a prompt, tool args/output, an
 * error message, a description, a label, a retry reason) is structurally
 * unrepresentable here; a new/unknown AgentEvent variant is dropped
 * (fail-closed) by the mapper in telemetry/records.ts rather than widening
 * this union. Written by adapters/node/node-telemetry.ts (JsonlTelemetrySink);
 * consumed only by CLI/host wiring — CorePorts does NOT carry this port, so
 * tool handlers can never see or write to it.
 */

import type { FinishReason, LoopEndReason } from "../types/events.js";
import type { ToolCallStatus } from "../types/tools.js";
import type { PermissionMode } from "../types/permissions.js";

/** One JSONL line. EVERY field is a name/enum/number/boolean by type — no
 *  field can carry free-form text (prompts, tool args/outputs, error messages,
 *  descriptions, labels, reasons are structurally unrepresentable). */
export type TelemetryEventRecord =
  | { t: "turn_end"; turn: number; finishReason: FinishReason }
  | { t: "usage"; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { t: "tool"; tool: string; status: ToolCallStatus; durationMs: number }
  | { t: "loop_end"; reason: LoopEndReason; turns: number }
  | { t: "compaction_start"; trigger: "auto" | "manual" }
  | { t: "compaction_end"; ok: boolean; preTokens: number; postTokens?: number; durationMs: number }
  | { t: "microcompact"; clearedToolResults: number; savedTokens: number }
  | { t: "context_usage"; estimatedTokens: number; budgetTokens: number; source: "provider" | "estimate" }
  | { t: "subagent_start"; agentType: string }
  | { t: "subagent_end"; status: "completed" | "max_turns" | "cancelled" | "error"; turns: number; durationMs: number }
  | { t: "workflow_end"; status: "completed" | "failed" | "cancelled"; completedSteps: number; totalSteps: number; durationMs: number }
  | { t: "stream_retry"; attempt: number; maxAttempts: number; delayMs: number }
  | { t: "error" }
  | { t: "checkpoint_created" }
  | { t: "checkpoint_failed" };

export type TelemetryLifecycleRecord =
  | { t: "session_start"; model: string; provider: string; mode: PermissionMode; appVersion?: string }
  | { t: "session_end" };

export type TelemetryRecord = { v: 1; ts: number; session: string } & (
  | TelemetryEventRecord
  | TelemetryLifecycleRecord
);

export interface TelemetryStatus {
  filePath: string;
  /** Records successfully appended to the sink file. */
  written: number;
  /** Records dropped: full pending queue, oversized line, write failure, post-dispose. */
  dropped: number;
  /** Last sink write failure, for /telemetry display ONLY — never itself recorded. */
  lastWriteError?: string;
}

export interface TelemetryPort {
  /** Synchronous fire-and-forget enqueue. NEVER throws, NEVER blocks the caller;
   *  drops (dropped++) when the pending queue is full or after dispose(). */
  record(record: TelemetryRecord): void;
  status(): TelemetryStatus;
  /** Waits for currently in-flight appends to settle (does NOT close the sink —
   *  record() keeps working after flush() resolves). Bounded by the same
   *  TELEMETRY_DISPOSE_DEADLINE_MS race as dispose(); never rejects. */
  flush(): Promise<void>;
  /** Bounded flush-and-close (TELEMETRY_DISPOSE_DEADLINE_MS race); idempotent; never rejects. */
  dispose(): Promise<void>;
}
