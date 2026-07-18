/**
 * Pure W0-fixture-driven projection from the `claude` CLI's stream-json output
 * into EXISTING AgentEvent variants (cut §1.4 translation table). Every right-
 * hand form below already exists in core's vocabulary — this slice invents no
 * protocol variant, and the core loop itself never emits the engine-only ones
 * (`engine_notice`).
 *
 * It decides nothing: approvals live in approval-bridge.ts, the ctx meter is
 * pulled by claude-engine.ts from `get_context_usage` ($0) AFTER `result` —
 * deliberately NOT summed here out of `result.usage` (cut §0.3-5; the codex
 * C-bug-1 lesson: a self-made sum is a plausible-looking meter that is wrong).
 */

import type { AgentEvent, FinishReason, LoopEndReason, ToolCallOutcome, ToolCallStatus } from "@anycode/core";
import type {
  ClaudeAssistantMessage,
  ClaudeRateLimitEventMessage,
  ClaudeResultMessage,
  ClaudeStreamEventMessage,
  ClaudeStreamMessage,
  ClaudeSystemInitMessage,
  ClaudeUserMessage,
  SDKAssistantMessageError,
} from "./protocol.js";
import { isClaudeSystemInitMessage } from "./protocol.js";

export interface ClaudeTurnTranslatorOptions {
  /** AnyCode's own turn ordinal for this turn (never the CLI's `num_turns`). */
  turn: number;
  /**
   * `system/init` is NOT an event (cut §1.4 table): it is engine STATE, and it
   * is re-emitted on EVERY turn (probe #1), so repeated inits for the same
   * session silently refresh that state instead of producing UI noise.
   */
  onInit?(init: ClaudeSystemInitMessage): void;
  /**
   * The terminal `result` frame, handed over verbatim for cost accounting
   * (`total_cost_usd`) and for the engine's post-result `get_context_usage`
   * pull. Custody: the engine accumulates the number, it is never logged or
   * written to a transcript (cut §0.2 invariant 2).
   */
  onResult?(result: ClaudeResultMessage): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Human-readable message for a `SDKAssistantMessageError`. `authentication_failed`
 * terminalizes the turn honestly (cut §1.4 table); an error code this build has
 * never heard of degrades to a generic notice rather than being swallowed
 * (residual R-W0-4: the live "limit exhausted" form was never captured).
 */
const ASSISTANT_ERROR_MESSAGES: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: "Claude Code is not signed in for this profile — sign in and start a new Claude session.",
  oauth_org_not_allowed: "This Claude account's organization does not permit this request.",
  billing_error: "Claude reported a billing problem with this account.",
  rate_limit: "Claude's rate limit was reached; the turn stopped.",
  overloaded: "Claude is overloaded; the turn stopped.",
  invalid_request: "Claude rejected the request as invalid.",
  model_not_found: "The selected Claude model is not available for this account.",
  server_error: "Claude reported a server error.",
  max_output_tokens: "Claude reached the maximum output length for this turn.",
};

function assistantErrorMessage(error: string): string {
  return ASSISTANT_ERROR_MESSAGES[error as SDKAssistantMessageError] ?? `Claude reported an error: ${error}`;
}

/**
 * The terminal `result` frame's own account of how the turn ended.
 * `terminal_reason` is canonical (cut §1.4 table); `subtype` is only the
 * fallback — and specifically NOT `is_error`, which lies in the signed-out
 * case (`subtype:"success"` WITH `is_error:true`, probe #12; the truth there
 * arrives earlier, on `assistant.error`, and has already been latched).
 */
function resultOutcome(result: ClaudeResultMessage): { loop: LoopEndReason; finish: FinishReason } {
  const reason = result.terminal_reason;
  if (reason === "aborted_streaming" || reason === "aborted_tools") {
    return { loop: "cancelled", finish: "other" };
  }
  if (reason === "max_turns") return { loop: "max_turns", finish: "length" };
  if (result.subtype === "success") return { loop: "completed", finish: "stop" };
  return { loop: "error", finish: "error" };
}

function toolStatus(isError: unknown): ToolCallStatus {
  return isError === true ? "error" : "success";
}

/**
 * A `tool_result` block's `content` is a string on the happy path and a
 * content-block array when the tool returned structured output; both are
 * flattened to the text the model itself saw.
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const value = record(block);
      return typeof value?.text === "string" ? value.text : "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

type OpenBlock = { kind: "text" | "thinking"; id: string };

/**
 * A ONE-TURN translator; a fresh instance is required per turn (mirrors
 * codex/event-translator.ts's `TurnTranslator`, whose `finish()` guarantees
 * this class reproduces: close every open block, cancel every dangling tool,
 * emit at most one terminal `error`, and ALWAYS end with `turn_end`+`loop_end`).
 */
export class ClaudeTurnTranslator {
  /** Open streamed blocks of the CURRENT assistant message, keyed by wire block index. */
  private readonly openBlocks = new Map<number, OpenBlock>();
  /** Tool calls announced this turn and not yet resulted, keyed by `tool_use_id`. */
  private readonly tools = new Map<string, { toolName: string; input: unknown }>();
  /** `uuid`s already consumed — dedups the `--replay-user-messages` echo class (CC-B hazard (д)). */
  private readonly seenUuids = new Set<string>();
  /** Assistant message ids whose text already streamed as deltas — their final `assistant` text block is then a DUPLICATE, not a fallback (hazard (з)). */
  private readonly streamedTextMessages = new Set<string>();
  /** Current `message.id` from `message_start`; block ids are `${messageId}:${index}`. */
  private currentMessageId = "claude-message";
  private finished = false;
  /** Latches the ONE terminal `{type:"error"}` a turn may emit. */
  private errorEmitted = false;

  constructor(private readonly options: ClaudeTurnTranslatorOptions) {}

  /** Feeds one inbound stream frame. Never throws on an unrecognized shape — an unknown subtype is dropped, by design (contract §4 subset semantics). */
  onMessage(message: ClaudeStreamMessage): AgentEvent[] {
    if (this.finished) return [];
    // Subagent noise (cut §1.4 table + hazard (ж)): a message BELONGING to a
    // subagent is folded away under its parent `Task` tool card. The filter is
    // strictly on the field — the root `Task` tool's own tool_use/tool_result
    // carry `parent_tool_use_id: null` and must survive.
    if (typeof message.parent_tool_use_id === "string") return [];
    switch (message.type) {
      case "system":
        return this.onSystem(message);
      case "assistant":
        return this.onAssistant(message);
      case "user":
        return this.onUser(message);
      case "stream_event":
        return this.onStreamEvent(message);
      case "rate_limit_event":
        return this.onRateLimitEvent(message);
      case "result":
        return this.onResult(message);
      default:
        return [];
    }
  }

  /** Terminal closure for a turn whose transport died or was cancelled before `result` arrived. */
  finishTerminal(reason: "cancelled" | "error"): AgentEvent[] {
    if (this.finished) return [];
    return this.finish(
      reason === "cancelled" ? { loop: "cancelled", finish: "other" } : { loop: "error", finish: "error" },
    );
  }

  private onSystem(message: ClaudeStreamMessage & { subtype?: string }): AgentEvent[] {
    if (isClaudeSystemInitMessage(message as never)) {
      this.options.onInit?.(message as unknown as ClaudeSystemInitMessage);
      return [];
    }
    const frame = message as unknown as Record<string, unknown>;
    switch (message.subtype) {
      case "status": {
        // A light progress ping — engine state, not an event. `compacting` is
        // the one status worth surfacing (the turn visibly stalls otherwise).
        return frame.status === "compacting"
          ? [{ type: "engine_notice", level: "info", message: "Claude is compacting the conversation context." }]
          : [];
      }
      case "permission_denied": {
        // Structured auto-deny signal (`dontAsk`/`auto` modes), emitted ALONGSIDE
        // a `tool_result{is_error:true}` — the reason is read from THIS frame,
        // never parsed out of the tool_result's prose (cut §1.4 table).
        const tool = text(frame.tool_name) ?? "a tool";
        return [{ type: "engine_notice", level: "warning", message: `Claude was denied permission to use ${tool}.` }];
      }
      case "api_retry": {
        // typed-only in v2.1.212 (no natural retry occurred during W0) — mapped
        // because the turn keeps running and the user deserves to know why it stalled.
        const detail = text(frame.error) ?? text(frame.message);
        return [{
          type: "engine_notice",
          level: "retry",
          message: detail === undefined ? "Claude is retrying an API request." : `Claude is retrying an API request: ${detail}`,
        }];
      }
      default:
        // `thinking_tokens`, `hook_started`/`hook_response`, and any subtype a
        // later CLI adds: silently dropped. An unknown subtype is never a throw
        // (that is the whole point of the drift gate's translator sweep).
        return [];
    }
  }

  private onAssistant(message: ClaudeAssistantMessage): AgentEvent[] {
    const events: AgentEvent[] = [];
    // The signed-out trap (probe #12): `result` will claim `subtype:"success"`,
    // so THIS is where a turn's real failure becomes visible.
    if (typeof message.error === "string" && !this.errorEmitted) {
      this.errorEmitted = true;
      events.push({ type: "error", error: new Error(assistantErrorMessage(message.error)) });
    }
    const content = message.message?.content;
    if (!Array.isArray(content)) return events;
    const messageId = text(record(message.message)?.id) ?? this.currentMessageId;
    for (const raw of content) {
      const block = record(raw);
      if (block === null) continue;
      if (block.type === "tool_use") {
        const id = text(block.id);
        const name = text(block.name);
        if (id === undefined || name === undefined) continue;
        const input = block.input ?? {};
        this.tools.set(id, { toolName: name, input });
        // BOTH forms are mandatory (W17): store.ts creates a tool-call block
        // ONLY on `tool_call`; `tool_execution_start` is patch-only and is a
        // silent no-op without it — a card that never renders at all.
        events.push({ type: "tool_call", toolCall: { id, name, input } });
        events.push({ type: "tool_execution_start", toolCallId: id, toolName: name, input });
        continue;
      }
      if (block.type === "text") {
        // `--include-partial-messages` delivers this text TWICE: as
        // `content_block_delta`s and again in this final frame (hazard (з)).
        // The deltas are the live path; this block is only a fallback for a
        // message that never streamed one.
        if (this.streamedTextMessages.has(messageId)) continue;
        const body = text(block.text);
        if (body === undefined) continue;
        const id = `${messageId}:fallback`;
        events.push({ type: "text_start", id });
        events.push({ type: "text_delta", id, text: body });
        events.push({ type: "text_end", id });
      }
    }
    return events;
  }

  private onUser(message: ClaudeUserMessage): AgentEvent[] {
    // Echo class, TWO live sources, one filter (contract §8, hazards (д)/(и)):
    // (1) `--replay-user-messages` returns our own input with `isReplay:true`;
    // (2) a SUCCESSFUL `set_model` emits an unrequested `<local-command-stdout>`
    // user frame — with `isReplay:true` even when the replay flag is OFF.
    // Rendering either paints a phantom user reply into the transcript.
    if (message.isReplay === true) return [];
    const content = message.message?.content;
    // A bare-string user frame is our own input coming back (or a
    // `<local-command-stdout>` notice that slipped through without the replay
    // marker): it is already in the transcript locally, so it projects nothing.
    if (!Array.isArray(content)) return [];
    const uuid = text(message.uuid);
    if (uuid !== undefined) {
      if (this.seenUuids.has(uuid)) return [];
      this.seenUuids.add(uuid);
    }
    const events: AgentEvent[] = [];
    for (const raw of content) {
      const block = record(raw);
      if (block === null || block.type !== "tool_result") continue;
      const toolUseId = text(block.tool_use_id);
      if (toolUseId === undefined) continue;
      const projection = this.tools.get(toolUseId);
      this.tools.delete(toolUseId);
      const status = toolStatus(block.is_error);
      const modelText = toolResultText(block.content);
      const outcome: ToolCallOutcome = {
        toolCallId: toolUseId,
        toolName: projection?.toolName ?? "Tool",
        status,
        modelText,
        durationMs: 0,
        ...(status === "success"
          ? { result: { ok: true, output: modelText } }
          : { result: { ok: false, error: modelText === "" ? "Claude tool failed" : modelText } }),
      };
      events.push({ type: "tool_result", outcome });
    }
    return events;
  }

  private onStreamEvent(message: ClaudeStreamEventMessage): AgentEvent[] {
    const event = message.event;
    if (record(event) === null) return [];
    switch (event.type) {
      case "message_start": {
        const id = text(record(event.message)?.id);
        if (id !== undefined) this.currentMessageId = id;
        // A new assistant message supersedes the previous one's blocks; any
        // still-open block is closed so a lost `content_block_stop` cannot
        // strand it (its id can never be patched again).
        return this.closeOpenBlocks();
      }
      case "content_block_start":
        return this.onBlockStart(event);
      case "content_block_delta":
        return this.onBlockDelta(event);
      case "content_block_stop": {
        const index = typeof event.index === "number" ? event.index : -1;
        const open = this.openBlocks.get(index);
        if (open === undefined) return [];
        this.openBlocks.delete(index);
        return [open.kind === "text" ? { type: "text_end", id: open.id } : { type: "reasoning_end", id: open.id }];
      }
      default:
        // `message_delta`/`message_stop` and any future inner event: dropped.
        return [];
    }
  }

  private onBlockStart(event: Record<string, unknown>): AgentEvent[] {
    const index = typeof event.index === "number" ? event.index : -1;
    const block = record(event.content_block);
    if (block === null || index < 0) return [];
    const id = `${this.currentMessageId}:${index}`;
    if (block.type === "text") {
      this.openBlocks.set(index, { kind: "text", id });
      this.streamedTextMessages.add(this.currentMessageId);
      return [{ type: "text_start", id }];
    }
    if (block.type === "thinking") {
      // store.ts renders `reasoning_*` generically for any engine (its
      // reasoning reducer is engine-agnostic), so thinking is projected
      // rather than dropped — the cut left this to the reducer's actual shape.
      this.openBlocks.set(index, { kind: "thinking", id });
      return [{ type: "reasoning_start", id }];
    }
    // `tool_use` blocks are NOT projected from the stream: the `assistant`
    // frame carries the COMPLETE input, whereas the streamed
    // `input_json_delta`s are a partial JSON string. Recording nothing here
    // keeps the matching `content_block_stop` a clean no-op.
    return [];
  }

  private onBlockDelta(event: Record<string, unknown>): AgentEvent[] {
    const index = typeof event.index === "number" ? event.index : -1;
    const delta = record(event.delta);
    const open = this.openBlocks.get(index);
    if (delta === null || open === undefined) return [];
    if (delta.type === "text_delta" && open.kind === "text") {
      const body = typeof delta.text === "string" ? delta.text : "";
      return body === "" ? [] : [{ type: "text_delta", id: open.id, text: body }];
    }
    if (delta.type === "thinking_delta" && open.kind === "thinking") {
      const body = typeof delta.thinking === "string" ? delta.thinking : "";
      return body === "" ? [] : [{ type: "reasoning_delta", id: open.id, text: body }];
    }
    // `input_json_delta` (partial tool input) and `signature_delta` (thinking
    // block signature) carry nothing the UI consumes.
    return [];
  }

  private onRateLimitEvent(message: ClaudeRateLimitEventMessage): AgentEvent[] {
    const info = message.rate_limit_info;
    if (record(info) === null || info.status === "allowed") return [];
    // `credits_required` is the known "limit exhausted" form (R-W0-4); any
    // other non-allowed status still surfaces, generically.
    const detail =
      info.errorCode === "credits_required"
        ? "Claude usage limit reached — usage credits are required to continue."
        : `Claude rate limit status: ${String(info.status)}.`;
    return [{ type: "engine_notice", level: "warning", message: detail }];
  }

  private onResult(message: ClaudeResultMessage): AgentEvent[] {
    this.options.onResult?.(message);
    return this.finish(resultOutcome(message));
  }

  private closeOpenBlocks(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const open of this.openBlocks.values()) {
      events.push(open.kind === "text" ? { type: "text_end", id: open.id } : { type: "reasoning_end", id: open.id });
    }
    this.openBlocks.clear();
    return events;
  }

  /** The one terminal path: every open block closed, every dangling tool cancelled, then always `turn_end`+`loop_end`. */
  private finish(outcome: { loop: LoopEndReason; finish: FinishReason }): AgentEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const events: AgentEvent[] = [...this.closeOpenBlocks()];
    for (const [toolCallId, projection] of this.tools) {
      events.push({
        type: "tool_result",
        outcome: {
          toolCallId,
          toolName: projection.toolName,
          status: "cancelled",
          modelText: "Claude turn ended before this tool completed",
          durationMs: 0,
          result: { ok: false, error: "Claude turn ended before this tool completed", errorKind: "cancelled" },
        },
      });
    }
    this.tools.clear();
    events.push({ type: "turn_end", turn: this.options.turn, finishReason: outcome.finish });
    events.push({ type: "loop_end", reason: outcome.loop, turns: this.options.turn });
    return events;
  }
}
