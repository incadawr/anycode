/**
 * Provider-failure classification for the model port (TASK.33 W7a).
 *
 * `isModelOutputEvent` is the retry gate: a model step is safe to replay ONLY
 * while nothing MODEL-DERIVED has reached the consumer yet. The AI SDK's
 * `fullStream` unconditionally enqueues a synthetic `{type:"start"}` during
 * stream construction — synchronously, before any network I/O — so gating retry
 * on "any event yielded" closes the gate before a genuine connect/reset/HTTP-
 * error-before-content failure can ever be observed (the W7 verify finding: 0
 * `stream_retry`, exactly one TCP attempt, on every transport). Gating on "model
 * output yielded" instead keeps `start` (a transport artifact) and a same-attempt
 * `error` (the failure descriptor itself) from closing the gate, so those
 * before-content failures retry — while content/reasoning/tool-input/tool_call/
 * finish still close it, because replaying after real output would double-dispatch
 * a tool call, duplicate partial text, or re-bill a completed step (TASK.33
 * invariant #1).
 *
 * `stream_retry` is emitted by the adapter itself, outside an attempt, and never
 * flows through this predicate; it is listed only for union exhaustiveness.
 *
 * W7b will add the failure classifier (`classifyProviderFailure`) alongside this
 * predicate; this file is the single source of the model-output definition shared
 * by the port's retry gate, the loop's terminal metadata, and the Try-again gate.
 */

import type { ModelStreamEvent } from "../types/events.js";

/** True when `e` is model-generated output (content/reasoning/tool/finish), false for `start`/`error`/`stream_retry`. */
export function isModelOutputEvent(e: ModelStreamEvent): boolean {
  switch (e.type) {
    case "text_start":
    case "text_delta":
    case "text_end":
    case "reasoning_start":
    case "reasoning_delta":
    case "reasoning_end":
    case "tool_input_start":
    case "tool_input_delta":
    case "tool_input_end":
    case "tool_call":
    case "finish":
      return true;
    case "start":
    case "error":
    case "stream_retry":
      return false;
    default: {
      // Compile-time exhaustiveness: a new ModelStreamEvent variant must be
      // classified explicitly above rather than defaulting silently.
      const unknown: never = e;
      throw new Error(`Unclassified model stream event: ${JSON.stringify(unknown)}`);
    }
  }
}
