/**
 * Translation of AI SDK fullStream parts (hyphenated type names) into the core
 * event vocabulary (underscored). This is the only file above the SDK client
 * that touches TextStreamPart. Mapping:
 *   start                -> start
 *   text-start/delta/end -> text_start / text_delta / text_end
 *   reasoning-*          -> reasoning_*
 *   tool-input-start/delta/end -> tool_input_*
 *   tool-call            -> tool_call (id, name, raw input; part.invalid ===
 *                            true carries over as toolCall.invalid = {reason},
 *                            input left as-is — the loop, not this layer,
 *                            synthesizes the invalid_input outcome, §2.9)
 *   finish               -> finish (finishReason normalized, usage)
 *   error                -> error
 * Unmapped part types (start-step, finish-step, source, raw, ...) return null
 * and are dropped.
 */

import type { TextStreamPart, ToolSet } from "ai";
import type { FinishReason, ModelStreamEvent } from "../types/events.js";

/** Renders the SDK's part.error (unparsable JSON / unknown tool name) into a short reason string. */
function describeInvalidToolCall(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "tool call input could not be parsed";
}

/** SDK finish reasons use hyphens; ours are underscored, plus a catch-all "unknown". */
function normalizeFinishReason(sdkReason: string): FinishReason {
  switch (sdkReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    case "error":
      return "error";
    case "other":
      return "other";
    default:
      return "unknown";
  }
}

/**
 * The SDK drops raw usage when summing finish.totalUsage. model-port captures
 * the latest finish-step.usage.raw separately (one SDK step per call), scoped
 * to each attempt so retries cannot reuse abandoned usage (GitHub #11).
 * Chat Completions and Responses coerce missing cache reads to zero; only a
 * numeric cached_tokens in that transport's wire details confirms reporting.
 * Anthropic and unknown transports keep the SDK's cache-read value unchanged.
 */
interface StreamTranslationContext {
  transport?: string;
  stepRawUsage?: unknown;
}

function cacheReadTokensReported(
  cacheReadTokens: number | undefined,
  { transport, stepRawUsage }: StreamTranslationContext,
): number | undefined {
  const detailsKey = transport === "openai-chat-completions"
    ? "prompt_tokens_details"
    : transport === "openai-responses" ? "input_tokens_details" : undefined;
  if (detailsKey === undefined) return cacheReadTokens;
  if (stepRawUsage === null || typeof stepRawUsage !== "object") return undefined;
  const details = (stepRawUsage as Record<string, unknown>)[detailsKey];
  if (details === null || typeof details !== "object") return undefined;
  return typeof (details as Record<string, unknown>).cached_tokens === "number"
    ? cacheReadTokens : undefined;
}

export function translateStreamPart(
  part: TextStreamPart<ToolSet>,
  context: StreamTranslationContext = {},
): ModelStreamEvent | null {
  switch (part.type) {
    case "start":
      return { type: "start" };
    case "text-start":
      return { type: "text_start", id: part.id };
    case "text-delta":
      return { type: "text_delta", id: part.id, text: part.text };
    case "text-end":
      return { type: "text_end", id: part.id };
    case "reasoning-start":
      return { type: "reasoning_start", id: part.id };
    case "reasoning-delta":
      return { type: "reasoning_delta", id: part.id, text: part.text };
    case "reasoning-end":
      return { type: "reasoning_end", id: part.id };
    case "tool-input-start":
      return { type: "tool_input_start", id: part.id, toolName: part.toolName };
    case "tool-input-delta":
      return { type: "tool_input_delta", id: part.id, delta: part.delta };
    case "tool-input-end":
      return { type: "tool_input_end", id: part.id };
    case "tool-call":
      return {
        type: "tool_call",
        toolCall: {
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
          // SDK-level parse/lookup failure (part.dynamic with part.invalid === true):
          // not dispatchable. Raw input is surfaced as-is; sanitizing it to a
          // valid {} and synthesizing the outcome is the loop's job (§2.9/§2.10).
          ...(part.invalid === true ? { invalid: { reason: describeInvalidToolCall(part.error) } } : {}),
        },
      };
    case "finish": {
      const cachedInputTokens = cacheReadTokensReported(
        part.totalUsage.inputTokenDetails?.cacheReadTokens, context,
      );
      return {
        type: "finish",
        finishReason: normalizeFinishReason(part.finishReason),
        usage: {
          inputTokens: part.totalUsage.inputTokens,
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          ...(part.totalUsage.inputTokenDetails?.cacheWriteTokens !== undefined ? { cacheWriteTokens: part.totalUsage.inputTokenDetails.cacheWriteTokens } : {}),
          outputTokens: part.totalUsage.outputTokens,
          totalTokens: part.totalUsage.totalTokens,
        },
      };
    }
    case "error":
      return { type: "error", error: part.error };
    default:
      // start-step, finish-step, source, file, reasoning-file, tool-result,
      // tool-error, tool-output-denied, tool-approval-request/response, abort,
      // raw, custom: no core vocabulary counterpart (Phase 0 scope).
      return null;
  }
}
