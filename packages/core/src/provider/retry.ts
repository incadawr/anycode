/**
 * Stream retry policy (design §2.9, Taskana 4705). The AiSdkModelPort retries
 * a failed step while no model output has reached the consumer (connect/reset/
 * HTTP-error-before-content failures are safe to replay whole) AND — since
 * Taskana 4705 — replays the whole step a bounded number of times after a
 * MID-STREAM failure, discarding the partial output (the discarded attempt's
 * tools were never dispatched: dispatch runs after the step's stream ends, so
 * a replay cannot double-execute a tool call). A transient-network wall-clock
 * budget (`networkRetryBudgetMs`) applies to every session by default and
 * lets pre-content network retries outlive `maxRetries`. Backoff waits are
 * abortable and each retry is announced with a stream_retry event.
 */

import { APICallError } from "ai";
import { classifyNetworkConfigurationFailure } from "./network-failure.js";
import { DEFAULT_RETRY_AFTER_CAP_MS, DEFAULT_STREAM_STALL_TIMEOUT_MS } from "../types/config.js";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /* */
  retryAfterCapMs: number;
  /* */
  stallTimeoutMs: number;
  /**
   * Extra wall-clock budget (ms) for riding out a transient NETWORK outage:
   * while a pre-content failure is `isTransientNetworkError` and less than
   * this much time has passed since the step's first failure, retrying goes on
   * past `maxRetries` (backoff still capped at `maxDelayMs`). HTTP-status
   * failures never use it. 0 = off; ignored when `maxRetries` is 0.
   * Default 300 000 (Taskana 4705): applies to every session, not just children.
   */
  networkRetryBudgetMs: number;
  /**
   * Whole-step replays allowed after a MID-STREAM failure (real model output
   * was already delivered). The replay discards the partial output — tools of
   * the discarded attempt were never dispatched (dispatch runs after the
   * step's stream ends), so a replay cannot double-execute a tool call. These
   * replays increment the SAME attempt counter as pre-content retries and are
   * additionally bounded by this number per streamText call. 0 disables
   * (pre-4705 behavior). Default DEFAULT_MIDSTREAM_RETRIES.
   */
  midStreamRetries: number;
}

export const DEFAULT_MIDSTREAM_RETRIES = 2;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  retryAfterCapMs: DEFAULT_RETRY_AFTER_CAP_MS,
  stallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS,
  networkRetryBudgetMs: 300_000,
  midStreamRetries: DEFAULT_MIDSTREAM_RETRIES,
};

/** HTTP status codes worth retrying: request timeout, rate limit, and server-side 5xx (529 = Anthropic "overloaded"). */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);

/** errno codes for transient network failures (connection reset/refused, DNS hiccups, timeouts). */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * A transient connectivity failure (connect timeout, reset, refused, DNS,
 * "fetch failed") as opposed to an HTTP-status failure: an APICallError with a
 * statusCode (or any error carrying one) is never network-transient, so quota
 * and auth errors cannot ride the network retry budget.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (classifyNetworkConfigurationFailure(error) !== undefined) return false;
  if (extractStatusCode(error) !== undefined) return false;
  if (!(error instanceof Error)) return false;
  if (isNetworkError(error)) return true;
  if (error.name === "ConnectTimeoutError" || /connect[ _]?timeout/i.test(error.message)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && cause !== error && isTransientNetworkError(cause);
}

/**
 * Retryable: APICallError.isRetryable, HTTP 408/429/500/502/503/504/529, and
 * network-level failures (fetch failed / ECONNRESET). 4xx auth/validation
 * errors are NOT retryable. Quota exhaustion is refused BEFORE the status
 * check (Taskana 4705): a quota-429 would otherwise ride the retryable
 * status set and pound an exhausted account.
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (isQuotaExhaustion(error)) return false;
  if (classifyNetworkConfigurationFailure(error) !== undefined) return false;
  if (APICallError.isInstance(error)) {
    return error.isRetryable || hasRetryableStatusCode(error.statusCode);
  }
  if (isNetworkError(error)) {
    return true;
  }
  return hasRetryableStatusCode(extractStatusCode(error));
}

/** Matches a quota-exhaustion message, or the z.ai-class numeric quota error code (TASK.33 §W7b). */
export const QUOTA_PATTERN = /\bquota\b|\b1308\b/i;

/**
 * Kimi-class subscription exhaustion rides as a 403 whose message explicitly
 * names a usage limit ("You've reached your usage limit for this billing
 * cycle"). The phrase is deliberately narrower than QUOTA_PATTERN so a policy
 * denial that merely mentions "quota" still classifies as forbidden (M3).
 */
export const USAGE_LIMIT_PATTERN = /usage limit|billing cycle/i;

/** Tests the message, and — for structured provider errors — the stringified `data` payload too. */
export function matchesFailureText(error: unknown, message: string, pattern: RegExp): boolean {
  if (pattern.test(message)) return true;
  if (APICallError.isInstance(error) && error.data !== undefined) {
    try {
      return pattern.test(JSON.stringify(error.data));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Quota exhaustion (z.ai 1308-on-429 text, kimi 403 usage-limit, or the code
 * carried only in structured `data`): retrying cannot succeed and must not
 * pound the API. Mirrors classifyProviderFailure's quota branch (failure.ts)
 * but lives here so isRetryableStreamError — the AUTO-retry decision — can
 * refuse quota before the 429 status check classifies it retryable.
 */
export function isQuotaExhaustion(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined && statusCode !== 429 && statusCode !== 403) return false;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (statusCode === 403) return matchesFailureText(error, message, USAGE_LIMIT_PATTERN);
  return matchesFailureText(error, message, QUOTA_PATTERN);
}

function hasRetryableStatusCode(statusCode: number | undefined): boolean {
  return statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode);
}

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { statusCode?: unknown; status?: unknown };
  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode;
  }
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  return undefined;
}

/** Undici/fetch throws `TypeError: fetch failed` with a `cause` carrying the errno code. */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (/fetch failed/i.test(error.message)) {
    return true;
  }
  return (
    RETRYABLE_NETWORK_CODES.has(extractErrorCode(error) ?? "") ||
    RETRYABLE_NETWORK_CODES.has(extractErrorCode((error as { cause?: unknown }).cause) ?? "")
  );
}

function extractErrorCode(value: unknown): string | undefined {
  if (value && typeof value === "object" && "code" in value) {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Delay before the given retry attempt: a retry-after header (seconds or HTTP
 * date) wins; otherwise base * 2^attempt with full jitter, capped at maxDelayMs.
 * `attempt` is 0-indexed (0 = delay before the first retry).
 */
export function retryDelayMs(attempt: number, error: unknown, policy: RetryPolicy): number {
  const retryAfterMs = extractRetryAfterMs(error);
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(0, retryAfterMs), policy.retryAfterCapMs);
  }
  const exponentialMs = policy.baseDelayMs * 2 ** attempt;
  const cappedMs = Math.min(exponentialMs, policy.maxDelayMs);
  // Full jitter (AWS backoff pattern): uniform random in [0, cappedMs].
  return Math.random() * cappedMs;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  const headers = extractResponseHeaders(error);
  if (!headers) {
    return undefined;
  }
  const raw = findHeaderCaseInsensitive(headers, "retry-after");
  return raw === undefined ? undefined : parseRetryAfter(raw);
}

function extractResponseHeaders(error: unknown): Record<string, string> | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const headers = (error as { responseHeaders?: unknown }).responseHeaders;
  return headers && typeof headers === "object" ? (headers as Record<string, string>) : undefined;
}

function findHeaderCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

/** `retry-after` is either a non-negative integer of seconds or an HTTP-date. */
function parseRetryAfter(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }
  const dateMs = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}
