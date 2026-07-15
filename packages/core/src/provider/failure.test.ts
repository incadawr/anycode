/**
 * `isModelOutputEvent` — the W7a retry gate (TASK.33). Pins the full table so a
 * new ModelStreamEvent variant cannot silently change which events keep the gate
 * open (retryable before-content window) vs close it (no auto-retry). The
 * behavioral consequences are exercised end-to-end in model-port.test.ts and
 * transport-contract.integration.test.ts; this pins the classification directly.
 */

import { describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "../types/events.js";
import { isModelOutputEvent } from "./failure.js";

const MODEL_OUTPUT: ModelStreamEvent[] = [
  { type: "text_start", id: "t1" },
  { type: "text_delta", id: "t1", text: "hi" },
  { type: "text_end", id: "t1" },
  { type: "reasoning_start", id: "r1" },
  { type: "reasoning_delta", id: "r1", text: "because" },
  { type: "reasoning_end", id: "r1" },
  { type: "tool_input_start", id: "c1", toolName: "Read" },
  { type: "tool_input_delta", id: "c1", delta: "{" },
  { type: "tool_input_end", id: "c1" },
  { type: "tool_call", toolCall: { id: "c1", name: "Read", input: {} } },
  { type: "finish", finishReason: "stop", usage: {} },
];

const NOT_MODEL_OUTPUT: ModelStreamEvent[] = [
  { type: "start" },
  { type: "error", error: new Error("boom") },
  { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 1, reason: "reset" },
];

describe("isModelOutputEvent", () => {
  it.each(MODEL_OUTPUT)("closes the gate (true) for $type", (event) => {
    expect(isModelOutputEvent(event)).toBe(true);
  });

  it.each(NOT_MODEL_OUTPUT)("keeps the gate open (false) for $type", (event) => {
    expect(isModelOutputEvent(event)).toBe(false);
  });
});
