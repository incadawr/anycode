/**
 * Tests for the fullStream part -> core event translator. Fake TextStreamPart
 * values are constructed as plain objects (type-only import of the SDK type,
 * no runtime dependency) to exercise every mapped case plus the drop path for
 * unmapped part types.
 */

import { describe, expect, it } from "vitest";
import type { TextStreamPart, ToolSet } from "ai";
import { translateStreamPart } from "./stream-translator.js";

type Part = TextStreamPart<ToolSet>;

describe("translateStreamPart", () => {
  it("maps start", () => {
    expect(translateStreamPart({ type: "start" } as Part)).toEqual({ type: "start" });
  });

  it("maps text-start / text-delta / text-end", () => {
    expect(translateStreamPart({ type: "text-start", id: "t1" } as Part)).toEqual({
      type: "text_start",
      id: "t1",
    });
    expect(translateStreamPart({ type: "text-delta", id: "t1", text: "hello" } as Part)).toEqual({
      type: "text_delta",
      id: "t1",
      text: "hello",
    });
    expect(translateStreamPart({ type: "text-end", id: "t1" } as Part)).toEqual({
      type: "text_end",
      id: "t1",
    });
  });

  it("maps reasoning-start / reasoning-delta / reasoning-end", () => {
    expect(translateStreamPart({ type: "reasoning-start", id: "r1" } as Part)).toEqual({
      type: "reasoning_start",
      id: "r1",
    });
    expect(
      translateStreamPart({ type: "reasoning-delta", id: "r1", text: "thinking" } as Part),
    ).toEqual({ type: "reasoning_delta", id: "r1", text: "thinking" });
    expect(translateStreamPart({ type: "reasoning-end", id: "r1" } as Part)).toEqual({
      type: "reasoning_end",
      id: "r1",
    });
  });

  it("maps tool-input-start / tool-input-delta / tool-input-end", () => {
    expect(
      translateStreamPart({ type: "tool-input-start", id: "c1", toolName: "Read" } as Part),
    ).toEqual({ type: "tool_input_start", id: "c1", toolName: "Read" });
    expect(
      translateStreamPart({ type: "tool-input-delta", id: "c1", delta: '{"file' } as Part),
    ).toEqual({ type: "tool_input_delta", id: "c1", delta: '{"file' });
    expect(translateStreamPart({ type: "tool-input-end", id: "c1" } as Part)).toEqual({
      type: "tool_input_end",
      id: "c1",
    });
  });

  it("maps tool-call to tool_call with a ProposedToolCall (raw, unvalidated input)", () => {
    const part = {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "Read",
      input: { file_path: "/tmp/a.txt" },
    } as Part;
    expect(translateStreamPart(part)).toEqual({
      type: "tool_call",
      toolCall: { id: "call-1", name: "Read", input: { file_path: "/tmp/a.txt" } },
    });
  });

  it("maps an invalid tool-call (unparsable JSON input) to toolCall.invalid with the raw input", () => {
    const cause = new Error("could not parse tool input as JSON");
    const part = {
      type: "tool-call",
      toolCallId: "call-2",
      toolName: "Read",
      input: "{not valid json",
      dynamic: true,
      invalid: true,
      error: cause,
    } as unknown as Part;
    expect(translateStreamPart(part)).toEqual({
      type: "tool_call",
      toolCall: {
        id: "call-2",
        name: "Read",
        input: "{not valid json",
        invalid: { reason: "could not parse tool input as JSON" },
      },
    });
  });

  it("maps an invalid tool-call (unknown tool name) using a fallback reason when error is not an Error/string", () => {
    const part = {
      type: "tool-call",
      toolCallId: "call-3",
      toolName: "NoSuchTool",
      input: { anything: true },
      dynamic: true,
      invalid: true,
      error: undefined,
    } as unknown as Part;
    expect(translateStreamPart(part)).toEqual({
      type: "tool_call",
      toolCall: {
        id: "call-3",
        name: "NoSuchTool",
        input: { anything: true },
        invalid: { reason: "tool call input could not be parsed" },
      },
    });
  });

  it("leaves valid (non-invalid) tool-call parts untouched — no invalid field at all", () => {
    const part = {
      type: "tool-call",
      toolCallId: "call-4",
      toolName: "Read",
      input: { file_path: "/tmp/b.txt" },
      dynamic: false,
      invalid: false,
    } as unknown as Part;
    const event = translateStreamPart(part);
    expect(event).toEqual({
      type: "tool_call",
      toolCall: { id: "call-4", name: "Read", input: { file_path: "/tmp/b.txt" } },
    });
    expect(event && "toolCall" in event ? "invalid" in event.toolCall : false).toBe(false);
  });

  it("maps finish, normalizing finishReason and usage", () => {
    const part = {
      type: "finish",
      finishReason: "tool-calls",
      totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as Part;
    expect(translateStreamPart(part)).toEqual({
      type: "finish",
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it("preserves provider-reported prompt-cache reads on finish usage", () => {
    const part = {
      type: "finish",
      finishReason: "stop",
      totalUsage: {
        inputTokens: 91_700,
        inputTokenDetails: { cacheReadTokens: 87_115 },
        outputTokens: 99,
        totalTokens: 91_799,
      },
    } as Part;
    expect(translateStreamPart(part)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 91_700, cachedInputTokens: 87_115, outputTokens: 99, totalTokens: 91_799 },
    });
  });

  it("normalizes every known SDK finish reason to the underscored vocabulary", () => {
    const cases: Array<[string, string]> = [
      ["stop", "stop"],
      ["length", "length"],
      ["content-filter", "content_filter"],
      ["tool-calls", "tool_calls"],
      ["error", "error"],
      ["other", "other"],
    ];
    for (const [sdkReason, expected] of cases) {
      const part = {
        type: "finish",
        finishReason: sdkReason,
        totalUsage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      } as Part;
      expect(translateStreamPart(part)).toMatchObject({ type: "finish", finishReason: expected });
    }
  });

  it("falls back to unknown for an unrecognized finish reason", () => {
    const part = {
      type: "finish",
      finishReason: "something-new",
      totalUsage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
    } as unknown as Part;
    expect(translateStreamPart(part)).toMatchObject({ type: "finish", finishReason: "unknown" });
  });

  it("maps error, passing the raw error value through", () => {
    const err = new Error("boom");
    expect(translateStreamPart({ type: "error", error: err } as Part)).toEqual({
      type: "error",
      error: err,
    });
  });

  it("drops unmapped part types", () => {
    const droppedTypes = [
      "start-step",
      "finish-step",
      "source",
      "raw",
      "file",
      "reasoning-file",
      "tool-result",
      "tool-error",
      "tool-output-denied",
      "tool-approval-request",
      "tool-approval-response",
      "abort",
      "custom",
    ];
    for (const type of droppedTypes) {
      expect(translateStreamPart({ type } as unknown as Part)).toBeNull();
    }
  });
});
