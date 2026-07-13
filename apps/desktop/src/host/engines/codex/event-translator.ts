/**
 * Pure W0-fixture-driven projection from Codex app-server notifications into
 * existing AgentEvent variants. It does not decide approvals, invoke tools, or
 * interpret unobserved protocol families.
 */

import type { AgentEvent, FinishReason, ToolCallOutcome, ToolCallStatus } from "@anycode/core";
import type { JsonRpcNotification } from "./protocol.js";
import type { TurnItemIndex } from "./turn-item-index.js";

/** One sub-tool-call a single native item projects to — a `fileChange` with N files projects to N of these. */
type ToolProjection = { toolCallId: string; toolName: "Bash" | "Write"; input: unknown };

export interface TurnTranslatorOptions {
  threadId: string;
  turnId: string;
  turn: number;
  /**
   * Approval-correlation index for this turn (cut §2(l)). Every `item/started`
   * of the turn is recorded here — including item types this renderer adapter
   * does not project — because an approval request names only an `itemId` and
   * the modal has to describe what is being approved.
   */
  items?: TurnItemIndex;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function matchingTurn(params: unknown, threadId: string, turnId: string): Record<string, unknown> | null {
  const value = record(params);
  return value?.threadId === threadId && value.turnId === turnId ? value : null;
}

function statusFor(itemStatus: unknown): ToolCallStatus {
  if (itemStatus === "completed") return "success";
  // The user's own deny must never read as a malfunction (C0 review Medium,
  // history-projection.ts's sibling fix — same defect, live side).
  if (itemStatus === "declined") return "denied";
  if (itemStatus === "cancelled" || itemStatus === "interrupted") return "cancelled";
  return "error";
}

/** `commandExecution` -> one projection; `fileChange` -> one projection PER changed file (multi-file, cut §2(i)). */
function projectTools(item: Record<string, unknown>): ToolProjection[] {
  const itemId = typeof item.id === "string" ? item.id : "";
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return [{
      toolCallId: itemId,
      toolName: "Bash",
      input: { command: item.command, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}) },
    }];
  }
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const projections: ToolProjection[] = [];
    item.changes.forEach((raw, index) => {
      const change = record(raw);
      if (change === null || typeof change.path !== "string") return;
      projections.push({
        toolCallId: `${itemId}:${index}`,
        toolName: "Write",
        input: { file_path: change.path, ...(typeof change.diff === "string" ? { content: change.diff } : {}) },
      });
    });
    return projections;
  }
  return [];
}

/** A one-turn translator; callers must construct a fresh one for every native turn. */
export class TurnTranslator {
  private readonly openText = new Set<string>();
  /** Keyed by the SUB toolCallId (`itemId` for commandExecution, `itemId:index` for each fileChange file). */
  private readonly tools = new Map<string, ToolProjection>();
  /** One native item can own several sub-tool-calls (multi-file fileChange) — tracked to close them all together. */
  private readonly itemToolCallIds = new Map<string, string[]>();
  /** Accumulated `item/commandExecution/outputDelta` text per itemId (cut §2(i) live command-output deltas). */
  private readonly commandOutputBuffers = new Map<string, string>();
  private finished = false;
  /** Latches the ONE terminal `{type:"error"}` event a turn may ever emit (cut §2(i)) — a live `error` notification and a fallback in `finish()` must never double-report the same failure. */
  private errorEmitted = false;

  constructor(private readonly options: TurnTranslatorOptions) {}

  onNotification(notification: JsonRpcNotification): AgentEvent[] {
    if (this.finished) return [];
    if (notification.method === "turn/completed") {
      const completed = record(notification.params);
      const turn = record(completed?.turn);
      if (completed?.threadId !== this.options.threadId || turn?.id !== this.options.turnId) return [];
      return this.finish(completed);
    }
    // `warning` notifications (cut §2(i)) are thread-scoped, not turn-scoped
    // (no `turnId` field on the wire) — they cannot pass `matchingTurn` below.
    if (notification.method === "warning") return this.onWarning(notification.params);

    const params = matchingTurn(notification.params, this.options.threadId, this.options.turnId);
    if (params === null) return [];

    switch (notification.method) {
      case "item/started":
        return this.onItemStarted(params);
      case "item/agentMessage/delta":
        return this.onAgentMessageDelta(params);
      case "item/commandExecution/outputDelta":
        return this.onCommandOutputDelta(params);
      case "item/completed":
        return this.onItemCompleted(params);
      case "thread/tokenUsage/updated":
        return this.onTokenUsage(params);
      case "error":
        return this.onError(params);
      default:
        // Requests (including approvals) and every unobserved notification are
        // deliberately not projected by this pure renderer adapter.
        return [];
    }
  }

  finishTerminal(reason: "cancelled" | "error"): AgentEvent[] {
    if (this.finished) return [];
    return this.finish({ turn: { status: reason === "cancelled" ? "interrupted" : "failed" } });
  }

  private onItemStarted(params: Record<string, unknown>): AgentEvent[] {
    const item = record(params.item);
    if (item === null || typeof item.id !== "string") return [];
    this.options.items?.record(item);
    if (item.type === "agentMessage") {
      this.openText.add(item.id);
      return [{ type: "text_start", id: item.id }];
    }
    const projections = projectTools(item);
    if (projections.length === 0) return [];
    this.itemToolCallIds.set(item.id, projections.map((projection) => projection.toolCallId));
    const events: AgentEvent[] = [];
    for (const projection of projections) {
      this.tools.set(projection.toolCallId, projection);
      events.push({ type: "tool_execution_start", toolCallId: projection.toolCallId, toolName: projection.toolName, input: projection.input });
    }
    return events;
  }

  private onAgentMessageDelta(params: Record<string, unknown>): AgentEvent[] {
    if (typeof params.itemId !== "string" || typeof params.delta !== "string") return [];
    const events: AgentEvent[] = [];
    if (!this.openText.has(params.itemId)) {
      this.openText.add(params.itemId);
      events.push({ type: "text_start", id: params.itemId });
    }
    events.push({ type: "text_delta", id: params.itemId, text: params.delta });
    return events;
  }

  /**
   * `item/commandExecution/outputDelta` (schema-evidenced: `codex app-server
   * generate-json-schema` against the installed codex-cli 0.144.3 — no W0/W1
   * fixture ever captured one, every probed command completed inside a
   * single chunk). No dedicated live wire event exists for partial tool
   * output (cut §2(i) — zero new AgentEvent fields), so the accumulated text
   * is consumed as a fallback in `toolOutcome` below: the terminal item's own
   * `aggregatedOutput` still wins when present, but a command whose
   * completion snapshot is unexpectedly empty never loses output that WAS
   * streamed live. File changes deliberately do NOT get this treatment
   * (`item/fileChange/outputDelta`/`patchUpdated` exist in the same schema
   * but are never consumed) — a documented choice, not an oversight: a file
   * diff is only ever meaningful once complete.
   */
  private onCommandOutputDelta(params: Record<string, unknown>): AgentEvent[] {
    if (typeof params.itemId !== "string" || typeof params.delta !== "string") return [];
    const buffered = this.commandOutputBuffers.get(params.itemId) ?? "";
    this.commandOutputBuffers.set(params.itemId, buffered + params.delta);
    return [];
  }

  private onItemCompleted(params: Record<string, unknown>): AgentEvent[] {
    const item = record(params.item);
    if (item === null || typeof item.id !== "string") return [];
    if (item.type === "agentMessage" && this.openText.delete(item.id)) {
      return [{ type: "text_end", id: item.id }];
    }
    const toolCallIds = this.itemToolCallIds.get(item.id);
    if (toolCallIds === undefined) return [];
    this.itemToolCallIds.delete(item.id);
    const events: AgentEvent[] = [];
    for (const toolCallId of toolCallIds) {
      const projection = this.tools.get(toolCallId);
      if (projection === undefined) continue;
      this.tools.delete(toolCallId);
      events.push({ type: "tool_result", outcome: this.toolOutcome(toolCallId, projection, item) });
    }
    return events;
  }

  private toolOutcome(toolCallId: string, projection: ToolProjection, item: Record<string, unknown>): ToolCallOutcome {
    const status = statusFor(item.status);
    const aggregated = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
    const buffered = this.commandOutputBuffers.get(toolCallId);
    this.commandOutputBuffers.delete(toolCallId);
    const modelText = aggregated ?? buffered ?? "";
    return {
      toolCallId,
      toolName: projection.toolName,
      status,
      modelText,
      durationMs: typeof item.durationMs === "number" && item.durationMs >= 0 ? item.durationMs : 0,
      ...(status === "success" ? { result: { ok: true, output: modelText } } : { result: { ok: false, error: "Codex tool did not complete" } }),
    };
  }

  private onTokenUsage(params: Record<string, unknown>): AgentEvent[] {
    const usage = record(params.tokenUsage);
    // W0 command fixture proves `total` is cumulative across updates, while
    // `last` is the current model request's usage and matches AgentEvent's
    // per-step context accounting semantics.
    const last = record(usage?.last);
    const totalTokens = last?.totalTokens;
    const contextWindow = usage?.modelContextWindow;
    if (
      typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0 ||
      typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0
    ) return [];
    return [{ type: "context_usage", estimatedTokens: totalTokens, budgetTokens: contextWindow, source: "provider" }];
  }

  /**
   * `warning` notifications (cut §2(i)): thread-scoped, not turn-scoped —
   * routed to the additive `engine_notice` variation, never a terminal
   * `error`. Core's own loop never emits `engine_notice` (zero core wire
   * delta, cut test hazard #3).
   */
  private onWarning(params: unknown): AgentEvent[] {
    const value = record(params);
    if (value?.threadId !== this.options.threadId) return [];
    const message = typeof value.message === "string" && value.message.length > 0 ? value.message : "Codex reported a warning.";
    return [{ type: "engine_notice", level: "warning", message }];
  }

  /**
   * `error` notifications (cut §2(i)): `willRetry` is the discriminator
   * between a retry (routed to `engine_notice`, level "retry" — the turn
   * keeps running) and a terminal error (the ORIGINAL safe message from
   * Codex — auth/quota/network/sandbox stay distinguishable — surfaced as
   * `{type:"error"}`, followed by `finish()`'s honest `turn_end`/`loop_end`
   * once `turn/completed` arrives; never a faceless `loop_end:"error"` alone).
   */
  private onError(params: Record<string, unknown>): AgentEvent[] {
    const errorValue = record(params.error);
    const message = typeof errorValue?.message === "string" && errorValue.message.length > 0 ? errorValue.message : "Codex reported an error.";
    if (params.willRetry === true) {
      return [{ type: "engine_notice", level: "retry", message }];
    }
    if (this.errorEmitted) return [];
    this.errorEmitted = true;
    return [{ type: "error", error: new Error(message) }];
  }

  private finish(params: Record<string, unknown>): AgentEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const turn = record(params.turn);
    const status = turn?.status;
    const loopReason = status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "error";
    const finishReason: FinishReason = status === "completed" ? "stop" : status === "interrupted" ? "other" : "error";
    const events: AgentEvent[] = [];
    // A terminal failure surfaces with its ORIGINAL safe message even when no
    // separate `error` notification preceded `turn/completed` (cut §2(i)) —
    // never just a faceless loop_end:"error". `errorEmitted` prevents a
    // double-report when the live `error` notification already fired.
    if (loopReason === "error" && !this.errorEmitted) {
      const turnError = record(turn?.error);
      if (turnError !== null) {
        const message = typeof turnError.message === "string" && turnError.message.length > 0 ? turnError.message : "Codex turn failed.";
        this.errorEmitted = true;
        events.push({ type: "error", error: new Error(message) });
      }
    }
    for (const id of this.openText) events.push({ type: "text_end", id });
    this.openText.clear();
    for (const [id, projection] of this.tools) {
      events.push({
        type: "tool_result",
        outcome: {
          toolCallId: id,
          toolName: projection.toolName,
          status: "cancelled",
          modelText: "Codex turn ended before this tool completed",
          durationMs: 0,
          result: { ok: false, error: "Codex turn ended before this tool completed", errorKind: "cancelled" },
        },
      });
    }
    this.tools.clear();
    this.itemToolCallIds.clear();
    events.push({ type: "turn_end", turn: this.options.turn, finishReason });
    events.push({ type: "loop_end", reason: loopReason, turns: this.options.turn });
    return events;
  }
}
