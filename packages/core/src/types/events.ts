/**
 * Core event vocabulary. ModelStreamEvent mirrors the AI SDK fullStream part
 * types translated from hyphenated to underscored names at the ModelPort
 * boundary, so nothing above the provider layer depends on SDK types.
 * AgentEvent adds loop-level events (turns, tool execution) on top.
 */

import type { ToolCallOutcome } from "./tools.js";
import type { WorkspaceTransition } from "../ports/worktrees.js";

export interface TokenUsage {
  inputTokens?: number;
  /** Input tokens served from the provider prompt cache; included in inputTokens. */
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "other"
  | "unknown";

/** A tool invocation proposed by the model. Input is raw and unvalidated; the dispatcher validates it. */
export interface ProposedToolCall {
  /** Provider-assigned tool call id, echoed back in the tool result message. */
  id: string;
  name: string;
  input: unknown;
  /**
   * Input failed to parse at the SDK level (part.invalid) — must NOT be
   * dispatched. The loop synthesizes an invalid_input outcome and writes the
   * assistant tool_call with input sanitized to {} (design §2.9).
   */
  invalid?: { reason: string };
}

/** Events yielded by ModelPort.streamText for a single model step. */
export type ModelStreamEvent =
  | { type: "start" }
  | { type: "text_start"; id: string }
  | { type: "text_delta"; id: string; text: string }
  | { type: "text_end"; id: string }
  | { type: "reasoning_start"; id: string }
  | { type: "reasoning_delta"; id: string; text: string }
  | { type: "reasoning_end"; id: string }
  | { type: "tool_input_start"; id: string; toolName: string }
  | { type: "tool_input_delta"; id: string; delta: string }
  | { type: "tool_input_end"; id: string }
  | { type: "tool_call"; toolCall: ProposedToolCall }
  | { type: "finish"; finishReason: FinishReason; usage: TokenUsage }
  /**
   * `retry` (TASK.33 W7b) is additive-optional terminal-retry metadata the loop
   * attaches to every passing error event: `attemptsMade` is the count of
   * `stream_retry` events already seen this turn, `maxAttempts` comes from the
   * last `stream_retry` event (absent when the turn never retried — the port
   * owns the policy, not the loop), `retryable`/`code` come from
   * `classifyProviderFailure` (provider/failure.ts), and `hadModelOutput` from
   * `isModelOutputEvent`. `code` is a plain string (not the provider/failure.ts
   * union) to keep this file free of a dependency on the provider layer.
   */
  | {
      type: "error";
      /**
       * RAW thrown value — in-process ONLY. Diagnosable at host-local sinks
       * (session.ts process log, CLI ANYCODE_DEBUG_ERRORS) but NEVER serialized
       * across a process boundary: a provider error can embed a response body or
       * auth header in its `.message`/`.stack`. Every trust-boundary surface (wire
       * serializer, CLI stdout/stream-json, renderer) renders from `safe`, never
       * this field (TASK.33 W7b-FIX #2).
       */
      error: unknown;
      retry?: {
        attemptsMade: number;
        maxAttempts?: number;
        /**
         * Whether a MANUAL retry (W8's Try-again button) may succeed — NOT the
         * auto-retry decision (that is `isRetryableStreamError`, observable via
         * `attemptsMade`). The two intentionally diverge; see
         * `classifyProviderFailure` in provider/failure.ts.
         */
        retryable: boolean;
        hadModelOutput: boolean;
        code: string;
      };
      /**
       * Whitelist-derived redacted descriptor (`ProviderFailureSafe` in
       * provider/failure.ts) the loop attaches alongside `retry` from ONE
       * `classifyProviderFailure` call. This is the ONLY field a trust boundary
       * may surface: `message` is a fixed per-code string (never raw text),
       * `code`/`statusCode` are safe by construction. Additive-optional and typed
       * inline (string `code`, not the provider union) to keep this file free of a
       * provider-layer dependency, same precedent as `retry.code`.
       */
      safe?: { code: string; message: string; statusCode?: number };
    }
  /** Emitted by the provider adapter before each retry of a not-yet-started stream (design §2.9). */
  | { type: "stream_retry"; attempt: number; maxAttempts: number; delayMs: number; reason: string };

/**
 * Why a loop stopped. `max_turns` means BUDGET EXHAUSTED — either the turn cap
 * or, for a subagent child, the wall-clock deadline (AgentLoopConfig.deadlineAt);
 * both leave a balanced history and an unfinished task, and every consumer
 * treats them identically, so they share one reason rather than splitting the
 * union across the ~10 files that map it.
 */
export type LoopEndReason = "completed" | "max_turns" | "cancelled" | "error" | "workspace_transition";

/** Full event stream produced by the agent loop; superset of the model stream vocabulary. */
export type AgentEvent =
  | ModelStreamEvent
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number; finishReason: FinishReason }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_result"; outcome: ToolCallOutcome }
  | { type: "workspace_transition"; transition: WorkspaceTransition }
  | { type: "loop_end"; reason: LoopEndReason; turns: number }
  /** trigger "manual" is reserved for the Phase 2 /compact command. */
  | { type: "compaction_start"; trigger: "auto" | "manual" }
  | {
      type: "compaction_end";
      ok: boolean;
      preTokens: number;
      postTokens?: number;
      durationMs: number;
      error?: string;
    }
  | { type: "microcompact"; clearedToolResults: number; savedTokens: number }
  /**
   * One granted extension of the turn ceiling (TASK.124 cut-1). Additive: it
   * rides the existing agent_event envelope on the desktop wire with no
   * protocol change (protocol.ts projects new AgentEvent variants
   * automatically), same precedent as `engine_notice` above. Emitted ONLY when
   * a grant was actually issued — a refused round needs no event, the existing
   * `loop_end`/`max_turns` already says the run stopped. `round` counts from 1
   * and never exceeds MAX_CEILING_ROUNDS; `totalGranted` is the running sum of
   * turns this session's ladder has handed out (bounded by the loop's
   * maxGrantedTurns); `remaining`/`nextAction` come verbatim from the model's
   * structured verdict.
   */
  | {
      type: "ceiling_grant";
      round: number;
      granted: number;
      totalGranted: number;
      remaining: string[];
      nextAction?: string;
    }
  /** Emitted after each finish (design §2.5): provider usage wins over the local estimate. */
  | {
      type: "context_usage";
      estimatedTokens: number;
      budgetTokens: number;
      source: "provider" | "estimate";
    }
  // Subagent coarse-progress events (Phase 3, design §3.3). Additive: they ride
  // the existing agent_event envelope on the desktop wire with no protocol
  // change. The full child result arrives in the Agent tool's tool_result;
  // these carry only the toolCallId + counters (no nested stream forwarding).
  | {
      type: "subagent_start";
      toolCallId: string;
      agentType: string;
      description: string;
      /**
       * REQUESTED child model id (request override, else the persona's own
       * `model:`) — what we put in the request, not the constructed port's
       * own identity (TASK.171, reverses TASK.161's port-identity readback:
       * see `subagent_end.model` below for the same field on the other end
       * of a run). Absent ⇒ the child inherited the parent's model.
       */
      model?: string;
      /**
       * Set only for an engine persona (md-profile `engine:`) — a one-shot
       * foreign CLI run (Codex or Claude Code) in place of an in-process
       * child (mirrors SubagentProgress's `start` variant, ports/subagent.ts).
       * Additive: absent on a replay from before this field existed, which
       * falls back to legacy (engine-agnostic) rendering — never infer the
       * engine from `agentType` (TASK.97 R5, wave2-cut §5.4).
       */
      engine?: "codex" | "claude";
    }
  | {
      type: "subagent_progress";
      toolCallId: string;
      turns: number;
      toolCalls: number;
      lastTool?: string;
    }
  | {
      type: "subagent_end";
      toolCallId: string;
      status: "completed" | "max_turns" | "cancelled" | "error";
      turns: number;
      durationMs: number;
      /**
       * Count of subagent_activity events the runner withheld past
       * SUBAGENT_ACTIVITY_MAX_EVENTS this run (TASK.102 slice S1 W2, CUT-S1
       * §0.5). Additive-optional: absent on a replay from before this field
       * existed (falls back to the pre-S1 "silently bounded" behavior), and
       * absent whenever the run never actually crossed the cap. Feeds the
       * persisted card's honest `activity.dropped` count alongside the
       * reducer's own ring/byte-cap evictions (card-snapshot.ts).
       */
      activitySuppressed?: number;
      /**
       * REQUESTED child model id — same value and precedence as
       * `subagent_start.model` above, echoed again here (TASK.171) so a
       * completed run's `subagent_end` record is self-describing on its own,
       * without needing to correlate back to an earlier `subagent_start`
       * line (telemetry's whitelist projection carries no toolCallId to join
       * on). Absent ⇒ the child inherited the parent's model.
       */
      model?: string;
      /**
       * Provider-reported model id observed on the child's port after its
       * final model call (including the wrap-up rescue call). Absent for
       * engine children, session-tier children, children that inherited the
       * parent's port, and providers that expose no raw claim. This is the
       * provider's CLAIM, not proof of serving — a SEPARATE datum from
       * `model` above (TASK.171 owner's ruling: the request, not the
       * provider's claim, decides "which model did the child run on"); kept
       * distinct because it is the only instrument for the open z.ai
       * accounting investigation (TASK.174).
       */
      responseModel?: string;
    }
  /**
   * Permission-broker gate crossing for a session-tier subagent (TASK.102
   * CUT-S2 §2.2/§0.8). Additive-optional: rides the existing agent_event
   * envelope on the desktop wire with no protocol change (mirrors
   * subagent_start/progress/end's precedent), and is a structured-clone
   * passthrough — the wire format is unaffected. ONLY a session-tier
   * `Agent` call ever produces it (bridged from SubagentProgress's
   * `attention` variant, ports/subagent.ts); an inline subagent never does.
   * The S1 durable-card reducer (subagents/card-snapshot.ts) treats this as
   * a no-op for the PERSISTED snapshot — attention is transient live-only
   * state, not part of the terminal record (CUT-S1 §2.1).
   */
  | { type: "subagent_attention"; toolCallId: string; waiting: boolean }
  /**
   * Stall report (TASK.148 slice 1, subagents/stall-clock.ts). REPORTS ONLY —
   * the child keeps running; nothing about this event ever kills, aborts or
   * ends the loop. Fired at most once per unbroken silent stretch past
   * SUBAGENT_STALL_TIMEOUT_MS (re-armed only by a genuine later sign of life),
   * for either subagent tier. `agentType`/`description` ride the event itself
   * (not just correlated via toolCallId) so a consumer never has to join back
   * to an earlier subagent_start record to read what stalled — same
   * self-describing precedent as `subagent_end.model` (TASK.171).
   * `waitingForApproval` is always false as produced by SubagentStallClock: a
   * report is only ever emitted while UNPAUSED (an unanswered permission ask
   * pauses the detector rather than ever producing a report for it) — the
   * field still rides the wire so a consumer never special-cases its absence.
   */
  | {
      type: "subagent_stalled";
      toolCallId: string;
      agentType: string;
      description: string;
      /** Ms since the child's last confirmed sign of life (excludes any paused/waiting-for-human interval). */
      silentMs: number;
      /** Last tool name / activity label observed before the silence began, if any. */
      lastActivity?: string;
      waitingForApproval: boolean;
    }
  // Per-child-tool activity (Phase 7 slice P7.18/F16b). Additive: rides the same
  // agent_event envelope on the desktop wire with no protocol change (protocol.ts
  // projects new AgentEvent variants automatically). One bounded one-liner per
  // child tool call for the live activity feed — `summary` is pre-capped and
  // sanitized (never raw child input); still no nested child-stream forwarding.
  | { type: "subagent_activity"; toolCallId: string; toolName: string; summary: string }
  // Workflow coarse-progress events (Phase 3 slice 3.4, design §2.3). Additive:
  // they ride the same agent_event envelope on the desktop wire with no protocol
  // change (protocol.ts projects new AgentEvent variants automatically). Coarse

  // progress surfaces as workflow_step_progress, not subagent_*.
  | { type: "workflow_start"; toolCallId: string; workflow: string; totalSteps: number }
  | { type: "workflow_step_start"; toolCallId: string; stepId: string; agentType: string }
  | {
      type: "workflow_step_progress";
      toolCallId: string;
      stepId: string;
      turns: number;
      toolCalls: number;
      lastTool?: string;
    }
  | {
      type: "workflow_step_end";
      toolCallId: string;
      stepId: string;
      status: "completed" | "max_turns" | "cancelled" | "error" | "skipped";
      turns: number;
      durationMs: number;
    }
  | {
      type: "workflow_end";
      toolCallId: string;
      status: "completed" | "failed" | "cancelled";
      completedSteps: number;
      totalSteps: number;
      durationMs: number;
    }
  // Checkpoint coarse events (Phase 4 slice 4.7, design §2.3). Additive: they
  // ride the existing agent_event envelope on the desktop wire with no protocol
  // change (protocol.ts projects new AgentEvent variants automatically). They
  // surface only when the wiring supplied a capturer (prod REPL); the desktop
  // host and headless print never do, so these are dormant by construction.
  | { type: "checkpoint_created"; id: string; label: string }
  | { type: "checkpoint_failed"; reason: string }
  /**
   * External-engine notice (codex-fixes TASK.42, cut §2(i)/§3.4): a warning,
   * retry, or informational notice from an engine that owns its own runtime
   * outside AnyCode's core loop (e.g. Codex app-server auth/quota/network
   * retries). Additive — the core loop itself NEVER emits this variant, so
   * every existing scripted-model-port core-loop test sequence is unaffected
   * (cut §7 test-hazard #3); only an external engine's own translator
   * constructs one.
   */
  | { type: "engine_notice"; level: "warning" | "retry" | "info"; message: string }
  /**
   * External-engine subscription quota snapshot (codex-profiles cut §3.4/§6):
   * pushed live during a turn AND as a boot snapshot. Additive — the core
   * loop NEVER emits this variant (same test-hazard #3 discipline as
   * `engine_notice` above, restated at codex-profiles cut §3.4); only
   * Codex's own translator constructs one, from `account/rateLimits/read`
   * (pull) or `account/rateLimits/updated` (push, sparse-merged before this
   * event is built — see shared/codex-quota.ts's `mergeCodexRateLimits`).
   */
  | { type: "engine_quota"; quota: CodexRateLimitsWire }
  /**
   * External-engine cumulative session token usage (codex-profiles cut
   * §3.4/§5.3). SEMANTICS ARE REPLACE, NOT ACCUMULATE: `thread/tokenUsage/
   * updated.total` on the Codex wire is ALREADY cumulative, whereas the
   * store's `accumulateSessionTokens` (store.ts) SUMS every `finish` event it
   * receives — reusing `finish`'s accumulate path for an already-cumulative
   * number would double (then triple, then quadruple...) the displayed
   * total. This is a DELIBERATELY SEPARATE event variant so the store can
   * dispatch it to a distinct, non-accumulating reducer path instead of
   * silently reusing `finish`'s. Additive — the core loop NEVER emits this
   * variant (same test-hazard #3 discipline as `engine_notice`/
   * `engine_quota` above); only Codex's own translator constructs one.
   */
  | {
      type: "engine_session_tokens";
      input: number;
      output: number;
      total: number;
      cachedInput?: number;
      reasoningOutput?: number;
    }
  /**
   * Preview-window console/pageerror forward (night-track wave-1 cut
   * §2.3/§2.4): additive AgentEvent variant the core loop never emits — only
   * the desktop host's preview control-plane bridge (apps/desktop/src/host/
   * index.ts) constructs one, translating a main-process `PREVIEW_EVENT_TYPE`
   * control message (apps/desktop/src/shared/preview.ts) as it crosses into
   * the outbound wire. NOT scoped to any turn: a preview window can emit
   * console output long after its opening turn ended, or with no turn ever
   * having run at all — the renderer's turn-scoped drop guard exempts this
   * variant by type (same exemption shape as `context_usage`, store.ts).
   * `suppressed` is present ONLY on a pure throttle-window summary (every
   * entry in that window was dropped, main's forwarding cap is ≤20 forwarded
   * per preview per rolling 10s); a normal forwarded entry never carries it.
   * `message` is pre-capped to 500 chars main-side.
   */
  | {
      type: "preview_console";
      previewId: string;
      level: "log" | "warn" | "error" | "pageerror";
      message: string;
      suppressed?: number;
    };

/**
 * Wire shape of a Codex quota/rate-limit snapshot, as carried by
 * `engine_quota` above. Structurally identical to (and kept in sync with)
 * `apps/desktop/src/shared/codex-quota.ts`'s `CodexRateLimits` — redeclared
 * here rather than imported so `packages/core` never depends on
 * `apps/desktop`'s shared layer (the desktop shell depends on core, never
 * the reverse). `byLimitId` is recursive (self-referential minus itself),
 * mirroring the wire's multi-bucket view.
 */
export interface CodexRateLimitsWire {
  primary?: { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null } | null;
  secondary?: { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null } | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null;
  planType?: string | null;
  limitName?: string | null;
  byLimitId?: Record<string, Omit<CodexRateLimitsWire, "byLimitId">>;
  observedAt: string;
}
