/**
 * Pure W0-fixture-driven projection from Codex app-server notifications into
 * existing AgentEvent variants. It does not decide approvals, invoke tools, or
 * interpret unobserved protocol families.
 */

import type { AgentEvent, FinishReason, ToolCallOutcome, ToolCallStatus } from "@anycode/core";
import type { JsonRpcNotification } from "./protocol.js";

type ToolProjection = { toolName: "Bash" | "Write"; input: unknown };

export interface TurnTranslatorOptions {
  threadId: string;
  turnId: string;
  turn: number;
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
  if (itemStatus === "cancelled" || itemStatus === "interrupted") return "cancelled";
  return "error";
}

function projectTool(item: Record<string, unknown>): ToolProjection | null {
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return { toolName: "Bash", input: { command: item.command, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}) } };
  }
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const change = record(item.changes[0]);
    if (change?.path === undefined || typeof change.path !== "string") return null;
    return {
      toolName: "Write",
      input: { file_path: change.path, ...(typeof change.diff === "string" ? { content: change.diff } : {}) },
    };
  }
  return null;
}

function toolOutcome(itemId: string, projection: ToolProjection, item: Record<string, unknown>): ToolCallOutcome {
  const status = statusFor(item.status);
  const modelText = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  return {
    toolCallId: itemId,
    toolName: projection.toolName,
    status,
    modelText,
    durationMs: typeof item.durationMs === "number" && item.durationMs >= 0 ? item.durationMs : 0,
    ...(status === "success" ? { result: { ok: true, output: modelText } } : { result: { ok: false, error: "Codex tool did not complete" } }),
  };
}

/** A one-turn translator; callers must construct a fresh one for every native turn. */
export class TurnTranslator {
  private readonly openText = new Set<string>();
  private readonly tools = new Map<string, ToolProjection>();
  private finished = false;

  constructor(private readonly options: TurnTranslatorOptions) {}

  onNotification(notification: JsonRpcNotification): AgentEvent[] {
    if (this.finished) return [];
    if (notification.method === "turn/completed") {
      const completed = record(notification.params);
      const turn = record(completed?.turn);
      if (completed?.threadId !== this.options.threadId || turn?.id !== this.options.turnId) return [];
      return this.finish(completed);
    }
    const params = matchingTurn(notification.params, this.options.threadId, this.options.turnId);
    if (params === null) return [];

    switch (notification.method) {
      case "item/started":
        return this.onItemStarted(params);
      case "item/agentMessage/delta":
        return this.onAgentMessageDelta(params);
      case "item/completed":
        return this.onItemCompleted(params);
      case "thread/tokenUsage/updated":
        return this.onTokenUsage(params);
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
    if (item.type === "agentMessage") {
      this.openText.add(item.id);
      return [{ type: "text_start", id: item.id }];
    }
    const projection = projectTool(item);
    if (projection === null) return [];
    this.tools.set(item.id, projection);
    return [{ type: "tool_execution_start", toolCallId: item.id, toolName: projection.toolName, input: projection.input }];
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

  private onItemCompleted(params: Record<string, unknown>): AgentEvent[] {
    const item = record(params.item);
    if (item === null || typeof item.id !== "string") return [];
    if (item.type === "agentMessage" && this.openText.delete(item.id)) {
      return [{ type: "text_end", id: item.id }];
    }
    const projection = this.tools.get(item.id);
    if (projection === undefined) return [];
    this.tools.delete(item.id);
    return [{ type: "tool_result", outcome: toolOutcome(item.id, projection, item) }];
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

  private finish(params: Record<string, unknown>): AgentEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const turn = record(params.turn);
    const status = turn?.status;
    const loopReason = status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "error";
    const finishReason: FinishReason = status === "completed" ? "stop" : status === "interrupted" ? "other" : "error";
    const events: AgentEvent[] = [];
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
    events.push({ type: "turn_end", turn: this.options.turn, finishReason });
    events.push({ type: "loop_end", reason: loopReason, turns: this.options.turn });
    return events;
  }
}
