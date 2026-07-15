import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { sanitizeAgentEvent, serializeError } from "./serialize.js";

describe("sanitizeAgentEvent", () => {
  it("flattens the error field into a SerializedError", () => {
    const event: AgentEvent = { type: "error", error: new Error("boom") };
    const wire = sanitizeAgentEvent(event);
    expect(wire).toEqual({ type: "error", error: serializeError(event.error) });
  });

  it("forwards TASK.33 W7b retry metadata onto the wire error event unchanged", () => {
    const event: AgentEvent = {
      type: "error",
      error: new Error("Cannot connect to API: Connect Timeout Error"),
      retry: { attemptsMade: 3, maxAttempts: 3, retryable: true, hadModelOutput: false, code: "connect_timeout" },
    };
    const wire = sanitizeAgentEvent(event);
    expect(wire).toEqual({
      type: "error",
      error: serializeError(event.error),
      retry: { attemptsMade: 3, maxAttempts: 3, retryable: true, hadModelOutput: false, code: "connect_timeout" },
    });
  });

  it("omits retry entirely when the core event carries none (pre-W7b byte parity)", () => {
    const event: AgentEvent = { type: "error", error: new Error("plain") };
    const wire = sanitizeAgentEvent(event);
    expect(wire.type).toBe("error");
    expect("retry" in wire).toBe(false);
  });

  it("passes every other event variant through unchanged", () => {
    const event: AgentEvent = { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 500, reason: "connect refused" };
    expect(sanitizeAgentEvent(event)).toBe(event);
  });
});
