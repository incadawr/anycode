/**
 * Stream retry policy (design §2.9). The AiSdkModelPort retries a failed step
 * ONLY while no event has been yielded from the stream (connect/first-chunk
 * failures are safe to replay whole; mid-stream retry is Phase 2). Backoff
 * waits are abortable and each retry is announced with a stream_retry event.
 */

import { APICallError } from "ai";
import { DEFAULT_RETRY_AFTER_CAP_MS, DEFAULT_STREAM_STALL_TIMEOUT_MS } from "../types/config.js";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /* */
  retryAfterCapMs: number;
  /* */
  stallTimeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  retryAfterCapMs: DEFAULT_RETRY_AFTER_CAP_MS,
  stallTimeoutMs: DEFAULT_STREAM_STALL_TIMEOUT_MS,
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
]);

/**
 * Retryable: APICallError.isRetryable, HTTP 408/429/500/502/503/504/529, and
 * network-level failures (fetch failed / ECONNRESET). 4xx auth/validation
 * errors are NOT retryable.
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    return error.isRetryable || hasRetryableStatusCode(error.statusCode);
  }
  if (isNetworkError(error)) {
    return true;
  }
  return hasRetryableStatusCode(extractStatusCode(error));
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
