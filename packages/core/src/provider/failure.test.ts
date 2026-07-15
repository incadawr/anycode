/**
 * `isModelOutputEvent` — the W7a retry gate (TASK.33). Pins the full table so a
 * new ModelStreamEvent variant cannot silently change which events keep the gate
 * open (retryable before-content window) vs close it (no auto-retry). The
 * behavioral consequences are exercised end-to-end in model-port.test.ts and
 * transport-contract.integration.test.ts; this pins the classification directly.
 */

import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "../types/events.js";
import { classifyProviderFailure, isModelOutputEvent } from "./failure.js";
import { isRetryableStreamError } from "./retry.js";

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

/**
 * `classifyProviderFailure` (TASK.33 W7b) — layers over `isRetryableStreamError`
 * (retry.ts): known buckets never disagree with it (asserted per case below),
 * except `quota`, the one deliberate override (a 429 quota-exhaustion response
 * would otherwise fall into the generically-retryable rate-limit bucket).
 */
function apiCallError(opts: {
  message: string;
  statusCode?: number;
  isRetryable?: boolean;
  data?: unknown;
}): APICallError {
  return new APICallError({
    message: opts.message,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: opts.statusCode,
    isRetryable: opts.isRetryable ?? false,
    data: opts.data,
  });
}

describe("classifyProviderFailure", () => {
  it("classifies a real connect-timeout APICallError (TASK.33 owner dogfood) as connect_timeout/retryable", () => {
    const error = apiCallError({
      message: "Cannot connect to API: Connect Timeout Error",
      isRetryable: true,
    });

    const result = classifyProviderFailure(error);

    expect(result.code).toBe("connect_timeout");
    expect(result.retryable).toBe(true);
    expect(isRetryableStreamError(error)).toBe(true);
    // safe.message is the whitelisted per-code string, not the raw provider text (W7b-FIX #1).
    expect(result.safe).toEqual({ code: "connect_timeout", message: "connect timeout" });
  });

  it("never leaks a raw response body/headers into `safe`", () => {
    const error = new APICallError({
      message: "server blew up",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: { secret: "do-not-leak" },
      statusCode: 500,
      responseHeaders: { authorization: "Bearer sk-should-not-leak" },
      responseBody: '{"leak":"raw-body-should-not-leak"}',
      isRetryable: true,
    });

    const result = classifyProviderFailure(error);

    const serialized = JSON.stringify(result.safe);
    expect(serialized).not.toContain("do-not-leak");
    expect(serialized).not.toContain("sk-should-not-leak");
    expect(serialized).not.toContain("raw-body-should-not-leak");
  });

  it("derives safe.message from the code and never leaks a secret embedded in the raw error message (W7b-FIX #1)", () => {
    // A provider/custom error that embeds a response body or auth header directly
    // in its `.message` must never reach `safe` — the redaction derives the human
    // string from the classified `code`, not the raw text.
    const secret = "Bearer sk-leak-9f3a2b";
    const error = apiCallError({
      message: `HTTP 500 upstream body={"token":"x"} Authorization: ${secret}`,
      statusCode: 500,
      isRetryable: true,
    });

    const result = classifyProviderFailure(error);

    // The whitelisted per-code string, never the raw provider text.
    expect(result.safe.message).toBe("server error");
    // The secret is absent from the message AND the entire serialized descriptor.
    expect(result.safe.message).not.toContain(secret);
    const serialized = JSON.stringify(result.safe);
    expect(serialized).not.toContain("sk-leak-9f3a2b");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("Authorization");
  });

  it("classifies 401 as auth, non-retryable — consistent with isRetryableStreamError", () => {
    const error = apiCallError({ message: "invalid api key", statusCode: 401 });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "auth", retryable: false });
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("classifies 403 as forbidden, non-retryable — consistent with isRetryableStreamError", () => {
    const error = apiCallError({ message: "access denied", statusCode: 403 });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "forbidden", retryable: false });
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("classifies a 400 schema-validation error as unknown, non-retryable — consistent with isRetryableStreamError", () => {
    const error = apiCallError({ message: "invalid request: schema validation failed", statusCode: 400 });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "unknown", retryable: false });
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("classifies a quota-exhaustion 429 (code 1308) as quota, non-retryable — the deliberate override", () => {
    const error = apiCallError({
      message: "Insufficient quota for this account (code 1308)",
      statusCode: 429,
    });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "quota", retryable: false });
    // The override: isRetryableStreamError sees a bare 429 as retryable, but a
    // quota-exhaustion response can never succeed on retry.
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("classifies a quota error carrying the code only in structured `data`, not the message", () => {
    const error = apiCallError({
      message: "request failed",
      statusCode: 429,
      data: { error: { code: "1308", message: "quota exceeded" } },
    });

    expect(classifyProviderFailure(error)).toMatchObject({ code: "quota", retryable: false });
  });

  it("classifies a plain rate-limit 429 (no quota indicator) as rate_limited, retryable", () => {
    const error = apiCallError({ message: "too many requests", statusCode: 429 });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "rate_limited", retryable: true });
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it.each([500, 502, 503, 504, 529])("classifies HTTP %d as server, retryable", (statusCode) => {
    const error = apiCallError({ message: "server error", statusCode });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "server", retryable: true });
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("classifies a network-level fetch failure (ECONNRESET) as network, retryable", () => {
    const error = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "network", retryable: true });
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("classifies an unrelated plain error as unknown, non-retryable", () => {
    const error = new Error("boom");

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "unknown", retryable: false });
    expect(isRetryableStreamError(error)).toBe(false);
  });
});

/**
 * The three cases where `retryable` (manual-retry worthiness — the Try-again
 * gate) INTENTIONALLY diverges from `isRetryableStreamError` (the auto-retry
 * decision), per Fable ruling (D). Each is a DOUBLE assert so it goes red if
 * EITHER side is later "fixed" to match the other: the divergence is the
 * contract, not a bug (W7b-FIX #2).
 */
describe("classifyProviderFailure — intentional divergence from isRetryableStreamError (W7b-FIX #2 pins)", () => {
  it("(a) quota-429: manual retry is hopeless (retryable:false) yet the port auto-retries a 429 (isRetryableStreamError:true)", () => {
    const error = apiCallError({
      message: "request failed",
      statusCode: 429,
      data: { error: { code: "1308", message: "quota exceeded" } },
    });

    expect(classifyProviderFailure(error)).toMatchObject({ code: "quota", retryable: false });
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("(b) plain connect-timeout Error: transient so a manual retry may succeed (retryable:true) yet the port cannot auto-retry a shapeless Error (isRetryableStreamError:false)", () => {
    const error = new Error("Cannot connect to API: Connect Timeout Error");

    expect(classifyProviderFailure(error)).toMatchObject({ code: "connect_timeout", retryable: true });
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("(c) 400 with isRetryable:true: deterministic so a manual retry is hopeless (retryable:false) yet the port honors the provider flag (isRetryableStreamError:true)", () => {
    const error = apiCallError({ message: "invalid request", statusCode: 400, isRetryable: true });

    expect(classifyProviderFailure(error)).toMatchObject({ code: "unknown", retryable: false });
    expect(isRetryableStreamError(error)).toBe(true);
  });
});
