import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { sanitizeAgentEvent, serializeError } from "./serialize.js";

/**
 * Poisoned repro from Fable's ruling §5 (secrets in message/stack/cause/
 * headers/body). Built as a plain Error rather than `ai`'s APICallError — the
 * desktop package does not depend on `ai`, and the serializer redacts by
 * building the wire error from `event.safe`, so the concrete error class is
 * irrelevant to what this pins. `.stack` embeds the message, so a serializer
 * that forwarded the stack would leak `sk-test`.
 */
function poisonedError(): Error {
  const err = new Error("HTTP 500 Authorization: Bearer sk-test");
  (err as { requestBodyValues?: unknown }).requestBodyValues = { apiKey: "sk-test" };
  (err as { responseHeaders?: unknown }).responseHeaders = { authorization: "Bearer sk-test" };
  (err as { cause?: unknown }).cause = new Error("cause sk-test");
  return err;
}

describe("sanitizeAgentEvent", () => {
  it("builds the wire error EXCLUSIVELY from the safe descriptor — the raw provider text never crosses (W7b-FIX #2)", () => {
    const event: AgentEvent = {
      type: "error",
      error: poisonedError(),
      safe: { code: "server", message: "server error", statusCode: 500 },
    };
    const wire = sanitizeAgentEvent(event);
    expect(wire).toEqual({
      type: "error",
      error: { name: "ProviderError", message: "server error (HTTP 500)" },
    });
    // No stack for provider errors (it crosses for nothing and can leak).
    expect(wire.type === "error" && wire.error.stack).toBeUndefined();
    expect(JSON.stringify(wire)).not.toContain("sk-test");
  });

  it("THE discriminator: an error event with NO safe (legacy/foreign producer) fails closed — never the raw error", () => {
    // Exactly what a pre-fix loop emitted: raw error, no `safe` field.
    const event = { type: "error", error: poisonedError(), retry: { attemptsMade: 0, retryable: false, hadModelOutput: false, code: "server" } } as AgentEvent;
    const wire = sanitizeAgentEvent(event);
    // Fail-closed to a constant; the raw message/stack are gone.
    expect(wire).toMatchObject({ type: "error", error: { name: "ProviderError", message: "request failed" } });
    expect(JSON.stringify(wire)).not.toContain("sk-test");
    expect(wire.type === "error" && wire.error.stack).toBeUndefined();
  });

  it("parses a numeric usage_limit notice off the RAW message and attaches it (feature migrated host-side)", () => {
    const event: AgentEvent = {
      type: "error",
      error: new Error("[1308] Usage limit reached. Your limit will reset at 2026-07-12 19:07:09"),
      safe: { code: "quota", message: "quota exhausted" },
    };
    const wire = sanitizeAgentEvent(event);
    expect(wire).toEqual({
      type: "error",
      error: { name: "ProviderError", message: "quota exhausted" },
      notice: { kind: "usage_limit", code: 1308, resetAt: Date.UTC(2026, 6, 12, 11, 7, 9) },
    });
  });

  it("forwards TASK.33 W7b retry metadata onto the wire error event unchanged", () => {
    const event: AgentEvent = {
      type: "error",
      error: new Error("Cannot connect to API: Connect Timeout Error"),
      retry: { attemptsMade: 3, maxAttempts: 3, retryable: true, hadModelOutput: false, code: "connect_timeout" },
      safe: { code: "connect_timeout", message: "connect timeout" },
    };
    const wire = sanitizeAgentEvent(event);
    expect(wire).toEqual({
      type: "error",
      error: { name: "ProviderError", message: "connect timeout" },
      retry: { attemptsMade: 3, maxAttempts: 3, retryable: true, hadModelOutput: false, code: "connect_timeout" },
    });
  });

  it("omits retry entirely when the core event carries none (byte parity for non-retried failures)", () => {
    const event: AgentEvent = { type: "error", error: new Error("plain"), safe: { code: "unknown", message: "request failed" } };
    const wire = sanitizeAgentEvent(event);
    expect(wire.type).toBe("error");
    expect("retry" in wire).toBe(false);
  });

  it("passes every other event variant through unchanged", () => {
    const event: AgentEvent = { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 500, reason: "connect refused" };
    expect(sanitizeAgentEvent(event)).toBe(event);
  });

  it("serializeError itself is untouched — host-local errors still serialize raw for diagnostics", () => {
    const err = new Error("host-local boom");
    expect(serializeError(err)).toMatchObject({ name: "Error", message: "host-local boom" });
  });
});
