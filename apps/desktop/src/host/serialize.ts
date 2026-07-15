/**

 *
 * Every message the host posts to the renderer must be structured-clone-safe.
 * The core's `AgentEvent` is almost entirely wire-safe already; the single
 * exception is the {type:"error"} variant, whose `error` field is `unknown`
 * (an Error instance, a rejected promise value, anything). `sanitizeAgentEvent`
 * flattens that one field into a plain `SerializedError`. The remaining
 * catch-all serialization safety net lives in the Outbound writer (session.ts).
 */

import type { AgentEvent } from "@anycode/core";
import type { SerializedError, WireAgentEvent } from "../shared/protocol.js";
import { parseUsageLimitNotice } from "../shared/usage-limit.js";

/** Short human-readable description of an arbitrary thrown value (for fatal/diagnostic text). */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Flattens any thrown value into a JSON-safe SerializedError (name/message/optional stack). */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "Error";
    const message = typeof record.message === "string" ? record.message : String(error);
    return { name, message };
  }
  return { name: "Error", message: String(error) };
}

/**
 * Wire error built EXCLUSIVELY from the core event's whitelist-derived `safe`
 * descriptor (TASK.33 W7b-FIX #2): the raw provider error can embed a response
 * body or auth header in its message/stack, so it NEVER crosses. `name` is the
 * constant "ProviderError" (raw `error.name` is provider-controlled text);
 * diagnostic identity rides `retry.code` and the host process log. Stack is
 * never populated. Fails closed to a constant when `safe` is absent (a legacy
 * or foreign producer) — never falls back to the raw error.
 */
function redactedWireError(
  safe: { code: string; message: string; statusCode?: number } | undefined,
): SerializedError {
  if (safe === undefined) {
    return { name: "ProviderError", message: "request failed" };
  }
  return {
    name: "ProviderError",
    message: safe.statusCode !== undefined ? `${safe.message} (HTTP ${safe.statusCode})` : safe.message,
  };
}

/**
 * Maps a core AgentEvent to its wire form. Only the {type:"error"} variant is
 * transformed: its raw `error` is replaced by a redacted SerializedError built
 * from `event.safe`, and a numbers-only `usage_limit` notice is parsed from the
 * RAW message here (host-side) and attached — the renderer can no longer parse
 * it off the redacted wire message (W7b-FIX #2 feature migration). Every other
 * variant is already structured-clone-safe and passes through unchanged.
 */
export function sanitizeAgentEvent(event: AgentEvent): WireAgentEvent {
  if (event.type === "error") {
    const notice = parseUsageLimitNotice(describeError(event.error));
    return {
      type: "error",
      error: redactedWireError(event.safe),
      ...(event.retry !== undefined ? { retry: event.retry } : {}),
      ...(notice !== null ? { notice } : {}),
    };
  }
  return event;
}
