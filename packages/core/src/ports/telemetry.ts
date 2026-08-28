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
 *
 * Telemetry track (TASK.158/159/160) additions: `session_start.engine` /
 * `.parentSession`, `subagent_start.model` / `.engine`, and the envelope's
 * `sub` are all names/enums/ids by type — the privacy theorem above still
 * holds, no free-text field was added.
 *
 * TASK.171 addition: `subagent_end.model` (the REQUESTED child model id,
 * closing the gap where a completed child's model attribution never reached
 * this whitelist at all) and `subagent_end.responseModel` (the provider's
 * own model CLAIM, a separate id-typed datum — never free text, and never
 * conflated with `model`). Owner's ruling: the request is authoritative for
 * "which model did the child run on"; the provider's claim is kept only as
 * distinct evidence for the open z.ai accounting investigation (TASK.174).
 *
 * S9 addendum: `session_start.enginePreset` — an id from a closed,
 * host-validated preset table (same shape as `engine`: a name, never free
 * text). WARNING for any future reader of `mode`: the short window between
 * S5 landing and this fix shipped `session_start` records that carried an
 * engine preset id INSIDE `mode` (via an `as PermissionMode` cast) on
 * codex/claude boots. A reader of `mode` MUST check membership in
 * `PERMISSION_MODES` and treat any non-member value as absent rather than
 * trusting the type.
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
  | { t: "subagent_start"; agentType: string; model?: string; engine?: string }
  | {
      t: "subagent_end";
      status: "completed" | "max_turns" | "cancelled" | "error";
      turns: number;
      durationMs: number;
      /** REQUESTED child model id — TASK.171, same value as `subagent_start.model`. */
      model?: string;
      /** Provider's own model CLAIM — TASK.171/TASK.174, distinct from `model`. */
      responseModel?: string;
    }
  | { t: "workflow_end"; status: "completed" | "failed" | "cancelled"; completedSteps: number; totalSteps: number; durationMs: number }
  | { t: "stream_retry"; attempt: number; maxAttempts: number; delayMs: number }
  | { t: "error" }
  | { t: "checkpoint_created" }
  | { t: "checkpoint_failed" };

export type TelemetryLifecycleRecord =
  | {
      t: "session_start";
      model: string;
      provider: string;
      /** Core's own permission mode. Present exactly when `engine` is
       *  absent — a codex/claude engine session has no core PermissionMode
       *  by construction (`supportsCorePermissions` is false for both), so
       *  the field is never written on an engine boot. */
      mode?: PermissionMode;
      appVersion?: string;
      /** Which runtime produced this session. Absent = core (the AgentLoop
       *  path) — correct by construction for every pre-existing file, since
       *  codex/claude engine boots wrote no records before this field
       *  existed (TASK.159). */
      engine?: "codex" | "claude";
      /** Present exactly when `engine` is present: the engine's own
       *  permission-preset id (codex: `ask|approve-for-me|full-access|
       *  read-only`; claude: `read-only|ask|workspace`) — a name from a
       *  closed, host-validated preset table, never free text. Deliberately
       *  its own field rather than being smuggled through `mode`: the two
       *  vocabularies overlap on some ids with different semantics and must
       *  not be conflated in the type system. Precedent:
       *  `apps/desktop/src/host/session.ts`'s `SessionPersistence.touch`. */
      enginePreset?: string;
      /** Set only when this boot is a session-tier child (TASK.102/145):
       *  the parent session's id, ties the child file back to its parent. */
      parentSession?: string;
    }
  | { t: "session_end" };

export type TelemetryRecord = { v: 1; ts: number; session: string; sub?: { agentType: string; model?: string } } & (
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
