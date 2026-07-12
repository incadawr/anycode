/**
 * Unit table for the ignorable-stream-artifact classifier (slice 3.7 R1, §3.1).
 * Proves the fail-closed boundary: content-block-level and unknown top-level
 * chunk-parse failures are droppable; message-level failures and any
 * non-chunk-parse error stay fatal.
 */

import { APICallError, TypeValidationError } from "ai";
import { describe, expect, it } from "vitest";
import { describeStreamArtifact, isIgnorableStreamArtifact } from "./stream-artifacts.js";

/** Builds a real chunk-parse TypeValidationError whose `.value` is the raw failed chunk. */
function chunkError(value: unknown): TypeValidationError {
  return new TypeValidationError({ value, cause: new Error("validation failed") });
}

describe("isIgnorableStreamArtifact — ignorable (true)", () => {
  it("content_block_start (z.ai `tool_result` non-standard block)", () => {
    const error = chunkError({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_result", tool_use_id: "srv_1", content: "..." },
    });
    expect(isIgnorableStreamArtifact(error)).toBe(true);
  });

  it("content_block_delta", () => {
    expect(isIgnorableStreamArtifact(chunkError({ type: "content_block_delta", index: 0 }))).toBe(true);
  });

  it("content_block_stop", () => {
    expect(isIgnorableStreamArtifact(chunkError({ type: "content_block_stop", index: 0 }))).toBe(true);
  });

  it("a value.type of `tool_result` at the top level (unknown top-level type)", () => {
    expect(isIgnorableStreamArtifact(chunkError({ type: "tool_result" }))).toBe(true);
  });

  it("an unknown top-level event type `foo_bar` (forward-compat)", () => {
    expect(isIgnorableStreamArtifact(chunkError({ type: "foo_bar" }))).toBe(true);
  });
});

describe("isIgnorableStreamArtifact — fatal (false)", () => {
  it.each([
    "message_start",
    "message_delta",
    "message_stop",
    "error",
    "ping",
  ])("keeps a message-level chunk-parse failure fatal: %s", (type) => {
    expect(isIgnorableStreamArtifact(chunkError({ type }))).toBe(false);
  });

  it("a plain Error is not a chunk-parse artifact", () => {
    expect(isIgnorableStreamArtifact(new Error("boom"))).toBe(false);
  });

  it("an APICallError is not a chunk-parse artifact", () => {
    const error = new APICallError({
      message: "overloaded",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 529,
      isRetryable: true,
    });
    expect(isIgnorableStreamArtifact(error)).toBe(false);
  });

  it("undefined", () => {
    expect(isIgnorableStreamArtifact(undefined)).toBe(false);
  });

  it("a TypeValidationError whose value has no string type", () => {
    expect(isIgnorableStreamArtifact(chunkError({ foo: "bar" }))).toBe(false);
  });

  it("a TypeValidationError whose value is not an object", () => {
    expect(isIgnorableStreamArtifact(chunkError("not-an-object"))).toBe(false);
  });
});

describe("describeStreamArtifact — dedup signature", () => {
  it("joins top type and nested block type: `content_block_start/tool_result`", () => {
    const error = chunkError({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_result" },
    });
    expect(describeStreamArtifact(error)).toBe("content_block_start/tool_result");
  });

  it("uses the delta discriminator when present", () => {
    const error = chunkError({ type: "content_block_delta", index: 0, delta: { type: "weird_delta" } });
    expect(describeStreamArtifact(error)).toBe("content_block_delta/weird_delta");
  });

  it("empty sub-type when the chunk has no block/delta discriminator", () => {
    expect(describeStreamArtifact(chunkError({ type: "foo_bar" }))).toBe("foo_bar/");
  });

  it("is stable across two failures of the same shape (drives warn dedup)", () => {
    const a = chunkError({ type: "content_block_start", content_block: { type: "tool_result" } });
    const b = chunkError({ type: "content_block_start", content_block: { type: "tool_result" } });
    expect(describeStreamArtifact(a)).toBe(describeStreamArtifact(b));
  });

  it("falls back to the error name for non-chunk-parse inputs", () => {
    expect(describeStreamArtifact(new Error("boom"))).toBe("Error");
    expect(describeStreamArtifact(undefined)).toBe("undefined");
  });
});
