/**
 * Tests for stream error classification and backoff delay computation
 * (design §2.9, phase-1 §4 row 1.6 test plan).
 */

import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_AFTER_CAP_MS, DEFAULT_STREAM_STALL_TIMEOUT_MS } from "../types/config.js";
import {
  DEFAULT_RETRY_POLICY,
  isQuotaExhaustion,
  isRetryableStreamError,
  isTransientNetworkError,
  retryDelayMs,
  type RetryPolicy,
} from "./retry.js";

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
  // Taskana 4705: midStreamRetries added to the policy shape; 0 here — these
  // fixtures test delay math only, not replay accounting.
  const policy: RetryPolicy = {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    retryAfterCapMs: DEFAULT_RETRY_AFTER_CAP_MS,
    networkRetryBudgetMs: 0,
    networkWaitMaxMs: 0,
    stallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS,
    midStreamRetries: 0,
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

  it("matches DEFAULT_RETRY_POLICY shape (Taskana 4705/4772: maxRetries 8, max 60000ms, 5-min network budget, 30-min network wait, 2 mid-stream replays)", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxRetries: 8,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      retryAfterCapMs: DEFAULT_RETRY_AFTER_CAP_MS,
      stallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS,
      networkRetryBudgetMs: 300_000,
      networkWaitMaxMs: 1_800_000,
      midStreamRetries: 2,
    });
  });
});

describe("retryDelayMs — retry-after cap (design slice-2.3-cut.md, tail 4)", () => {
  const policy: RetryPolicy = {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    retryAfterCapMs: 60_000,
    networkRetryBudgetMs: 0,
    networkWaitMaxMs: 0,
    stallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS,
    midStreamRetries: 0,
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

describe("isTransientNetworkError", () => {
  it("accepts connect timeouts, errno codes and fetch failed with a cause", () => {
    const connect = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(isTransientNetworkError(connect)).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }))).toBe(true);
    expect(isTransientNetworkError(new TypeError("fetch failed", { cause: connect }))).toBe(true);
    expect(isTransientNetworkError(new Error("boom", { cause: connect }))).toBe(true);
  });

  it("accepts a bare ENETUNREACH (Taskana 4772: Wi-Fi off on macOS)", () => {
    expect(isTransientNetworkError(Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }))).toBe(true);
  });

  it("rejects HTTP-status failures and unrelated errors", () => {
    expect(isTransientNetworkError(Object.assign(new Error("rate"), { statusCode: 429 }))).toBe(false);
    expect(isTransientNetworkError(Object.assign(new Error("auth"), { statusCode: 401 }))).toBe(false);
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
    expect(isTransientNetworkError("fetch failed")).toBe(false);
  });
});

describe("isQuotaExhaustion — quota never auto-retries (Taskana 4705)", () => {
  it("z.ai 429 with quota text (code 1308) is quota and NOT auto-retryable", () => {
    const error = apiCallError({ statusCode: 429, isRetryable: false });
    error.message = "Insufficient quota for this account (code 1308)";
    expect(isQuotaExhaustion(error)).toBe(true);
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("quota code carried only in structured `data`, statusless, is quota and NOT auto-retryable", () => {
    const error = new APICallError({
      message: "request failed",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      isRetryable: false,
      data: { error: { code: "1308" } },
    });
    expect(isQuotaExhaustion(error)).toBe(true);
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("kimi 403 usage-limit message is quota and NOT auto-retryable", () => {
    const error = apiCallError({ statusCode: 403, isRetryable: false });
    error.message = "You've reached your usage limit for this billing cycle";
    expect(isQuotaExhaustion(error)).toBe(true);
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("a plain rate-limit 429 (no quota text) is NOT quota and stays retryable", () => {
    const error = apiCallError({ statusCode: 429, isRetryable: true });
    expect(isQuotaExhaustion(error)).toBe(false);
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("a 500 mentioning quota is NOT quota (status wins) and stays retryable", () => {
    const error = apiCallError({ statusCode: 500, isRetryable: false });
    error.message = "quota backend down";
    expect(isQuotaExhaustion(error)).toBe(false);
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("a 403 policy denial (no usage-limit phrase) is NOT quota; 403 is not in the retryable status set", () => {
    const error = apiCallError({ statusCode: 403, isRetryable: false });
    error.message = "quota policy denies this key";
    expect(isQuotaExhaustion(error)).toBe(false);
    expect(isRetryableStreamError(error)).toBe(false);
  });
});

describe("isQuotaExhaustion — rate limits stay retryable (Taskana 4705 review)", () => {
  it("a 429 'quota ... per minute' rate limit is NOT quota and stays retryable", () => {
    const error = apiCallError({ statusCode: 429, isRetryable: false });
    error.message = "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'requests' per minute";
    expect(isQuotaExhaustion(error)).toBe(false);
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("a 429 quota-worded error carrying Retry-After is a rate limit, NOT quota, and stays retryable", () => {
    const error = apiCallError({ statusCode: 429, isRetryable: false, responseHeaders: { "retry-after": "5" } });
    error.message = "Quota exceeded for this key";
    expect(isQuotaExhaustion(error)).toBe(false);
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("a 429 'rate limit' message is NOT quota even when it names a quota", () => {
    const error = apiCallError({ statusCode: 429, isRetryable: false });
    error.message = "rate limit reached, quota window resets soon";
    expect(isQuotaExhaustion(error)).toBe(false);
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("a bare 1308 inside an arbitrary body is NOT a quota code", () => {
    const error = apiCallError({ statusCode: 429, isRetryable: false });
    error.message = "Too many requests; request offset 1308 in body";
    expect(isQuotaExhaustion(error)).toBe(false);
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("z.ai quota code 1308 in structured data stays quota even with Retry-After", () => {
    const error = new APICallError({
      message: "request failed",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: false,
      responseHeaders: { "retry-after": "5" },
      data: { error: { code: "1308" } },
    });
    expect(isQuotaExhaustion(error)).toBe(true);
    expect(isRetryableStreamError(error)).toBe(false);
  });
});
