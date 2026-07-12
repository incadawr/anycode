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
 * Maps a core AgentEvent to its wire form. Only the {type:"error"} variant is
 * transformed (error:unknown -> SerializedError); every other variant is already
 * structured-clone-safe and passes through unchanged.
 */
export function sanitizeAgentEvent(event: AgentEvent): WireAgentEvent {
  if (event.type === "error") {
    return { type: "error", error: serializeError(event.error) };
  }
  return event;
}
