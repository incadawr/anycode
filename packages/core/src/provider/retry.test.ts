/**
 * Tests for stream error classification and backoff delay computation
 * (design §2.9, phase-1 §4 row 1.6 test plan).
 */

import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_AFTER_CAP_MS, DEFAULT_STREAM_STALL_TIMEOUT_MS } from "../types/config.js";
import { DEFAULT_RETRY_POLICY, isRetryableStreamError, retryDelayMs, type RetryPolicy } from "./retry.js";

function apiCallError(opts: {
  statusCode?: number;
  isRetryable?: boolean;
  responseHeaders?: Record<string, string>;
}): APICallError {
  return new APICallError({
    message: "boom",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: opts.statusCode,
    isRetryable: opts.isRetryable ?? false,
    responseHeaders: opts.responseHeaders,
  });
}

describe("isRetryableStreamError", () => {
  it("is true for APICallError.isRetryable", () => {
    expect(isRetryableStreamError(apiCallError({ isRetryable: true, statusCode: 400 }))).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504, 529])(
    "is true for APICallError with HTTP status %d",
    (statusCode) => {
      expect(isRetryableStreamError(apiCallError({ statusCode, isRetryable: false }))).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 422])(
    "is false for APICallError with non-retryable HTTP status %d",
    (statusCode) => {
      expect(isRetryableStreamError(apiCallError({ statusCode, isRetryable: false }))).toBe(false);
    },
  );

  it("is true for a network-level fetch failure (TypeError: fetch failed)", () => {
    const error = new TypeError("fetch failed");
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("is true for a fetch failure whose cause carries ECONNRESET", () => {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = { code: "ECONNRESET" };
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("is true for a raw error object carrying an ECONNRESET code", () => {
    const error = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("is false for a plain unrelated error", () => {
    expect(isRetryableStreamError(new Error("boom"))).toBe(false);
  });

  it("is false for undefined/null/non-error values", () => {
    expect(isRetryableStreamError(undefined)).toBe(false);
    expect(isRetryableStreamError(null)).toBe(false);
    expect(isRetryableStreamError("boom")).toBe(false);
  });

  it("is true for a plain object carrying a retryable statusCode (non-APICallError)", () => {
    expect(isRetryableStreamError({ statusCode: 529 })).toBe(true);
  });
});

describe("retryDelayMs", () => {
  const policy: RetryPolicy = {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    retryAfterCapMs: DEFAULT_RETRY_AFTER_CAP_MS,
    stallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS,
  };

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("honors a numeric (seconds) retry-after header over backoff", () => {
    const error = apiCallError({ statusCode: 429, responseHeaders: { "retry-after": "2" } });
    expect(retryDelayMs(0, error, policy)).toBe(2_000);
  });

  it("is case-insensitive when reading the retry-after header", () => {
    const error = apiCallError({ statusCode: 429, responseHeaders: { "Retry-After": "5" } });
    expect(retryDelayMs(0, error, policy)).toBe(5_000);
  });

  it("honors an HTTP-date retry-after header, clamped to non-negative", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const error = apiCallError({ statusCode: 429, responseHeaders: { "retry-after": future } });
    const delay = retryDelayMs(0, error, policy);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(10_000);
  });

  it("clamps a past HTTP-date retry-after header to 0", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    const error = apiCallError({ statusCode: 429, responseHeaders: { "retry-after": past } });
    expect(retryDelayMs(0, error, policy)).toBe(0);
  });

  it("falls back to exponential backoff with full jitter when no retry-after header is present", () => {
    // Math.random mocked to 0.5: delay = 0.5 * min(base * 2^attempt, maxDelayMs).
    const error = apiCallError({ statusCode: 500 });
    expect(retryDelayMs(0, error, policy)).toBe(500); // 0.5 * (1000 * 2^0)
    expect(retryDelayMs(1, error, policy)).toBe(1_000); // 0.5 * (1000 * 2^1)
    expect(retryDelayMs(2, error, policy)).toBe(2_000); // 0.5 * (1000 * 2^2)
  });

  it("caps the exponential backoff at maxDelayMs before applying jitter", () => {
    const error = apiCallError({ statusCode: 500 });
    expect(retryDelayMs(10, error, policy)).toBe(15_000); // 0.5 * min(huge, 30_000)
  });

  it("ignores a malformed retry-after header and falls back to backoff", () => {
    const error = apiCallError({ statusCode: 500, responseHeaders: { "retry-after": "not-a-value" } });
    expect(retryDelayMs(0, error, policy)).toBe(500);
  });

  it("uses backoff for errors with no response headers at all", () => {
    expect(retryDelayMs(0, new Error("boom"), policy)).toBe(500);
  });

  it("matches DEFAULT_RETRY_POLICY shape (maxRetries 3, base 1000ms, max 30000ms)", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxRetries: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      retryAfterCapMs: DEFAULT_RETRY_AFTER_CAP_MS,
      stallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS,
    });
  });
});

describe("retryDelayMs — retry-after cap (design slice-2.3-cut.md, tail 4)", () => {
  const policy: RetryPolicy = {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    retryAfterCapMs: 60_000,
    stallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS,
  };

  it("caps a retry-after header well above the cap down to retryAfterCapMs", () => {
    const error = apiCallError({ statusCode: 429, responseHeaders: { "retry-after": "300" } });
    expect(retryDelayMs(0, error, policy)).toBe(60_000);
  });

  it("leaves a retry-after header below the cap untouched", () => {
    const error = apiCallError({ statusCode: 429, responseHeaders: { "retry-after": "5" } });
    expect(retryDelayMs(0, error, policy)).toBe(5_000);
  });
});
