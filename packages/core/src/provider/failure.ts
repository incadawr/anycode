/**
 * Provider-failure classification for the model port (TASK.33 W7a/W7b).
 *
 * `isModelOutputEvent` is the retry gate: a model step is safe to replay ONLY
 * while nothing MODEL-DERIVED has reached the consumer yet. The AI SDK's
 * `fullStream` unconditionally enqueues a synthetic `{type:"start"}` during
 * stream construction — synchronously, before any network I/O — so gating retry
 * on "any event yielded" closes the gate before a genuine connect/reset/HTTP-
 * error-before-content failure can ever be observed (the W7 verify finding: 0
 * `stream_retry`, exactly one TCP attempt, on every transport). Gating on "model
 * output yielded" instead keeps `start` (a transport artifact) and a same-attempt
 * `error` (the failure descriptor itself) from closing the gate, so those
 * before-content failures retry — while content/reasoning/tool-input/tool_call/
 * finish still close it, because replaying after real output would double-dispatch
 * a tool call, duplicate partial text, or re-bill a completed step (TASK.33
 * invariant #1).
 *
 * `stream_retry` is emitted by the adapter itself, outside an attempt, and never
 * flows through this predicate; it is listed only for union exhaustiveness.
 *
 * `classifyProviderFailure` (W7b) is the second half of this file: it LAYERS
 * OVER `isRetryableStreamError` (retry.ts) rather than replacing it — the retry
 * policy itself does not change — and adds a stable, redacted `code` plus a
 * `safe` descriptor the loop/CLI/desktop can surface without ever leaking a raw
 * response body or headers. This file is the single source of the model-output
 * definition shared by the port's retry gate, the loop's terminal metadata, and
 * the Try-again gate.
 */

import { APICallError } from "ai";
import type { ModelStreamEvent } from "../types/events.js";
import { isRetryableStreamError } from "./retry.js";

/** True when `e` is model-generated output (content/reasoning/tool/finish), false for `start`/`error`/`stream_retry`. */
export function isModelOutputEvent(e: ModelStreamEvent): boolean {
  switch (e.type) {
    case "text_start":
    case "text_delta":
    case "text_end":
    case "reasoning_start":
    case "reasoning_delta":
    case "reasoning_end":
    case "tool_input_start":
    case "tool_input_delta":
    case "tool_input_end":
    case "tool_call":
    case "finish":
      return true;
    case "start":
    case "error":
    case "stream_retry":
      return false;
    default: {
      // Compile-time exhaustiveness: a new ModelStreamEvent variant must be
      // classified explicitly above rather than defaulting silently.
      const unknown: never = e;
      throw new Error(`Unclassified model stream event: ${JSON.stringify(unknown)}`);
    }
  }
}

/** Stable failure bucket surfaced to the loop/CLI/desktop — never a raw provider error shape. */
export type ProviderFailureCode =
  | "connect_timeout"
  | "network"
  | "rate_limited"
  | "auth"
  | "forbidden"
  | "server"
  | "quota"
  | "unknown";

/** Redacted, serializable failure descriptor — NEVER the raw response body/headers. */
export interface ProviderFailureSafe {
  code: ProviderFailureCode;
  message: string;
  statusCode?: number;
}

export interface ProviderFailureClassification {
  code: ProviderFailureCode;
  retryable: boolean;
  safe: ProviderFailureSafe;
}

/** Undici/fetch wraps transient failures behind `TypeError: fetch failed`, cause carrying the errno. */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/** The AI SDK's undici-backed connect failure (TASK.33 owner dogfood: `api.z.ai` unreachable). */
const CONNECT_TIMEOUT_PATTERN = /connect timeout error|cannot connect to api/i;

/** Matches a quota-exhaustion message, or the z.ai-class numeric quota error code (TASK.33 §W7b). */
const QUOTA_PATTERN = /\bquota\b|\b1308\b/i;

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown provider error";
}

function extractStatusCode(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) return error.statusCode;
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { statusCode?: unknown; status?: unknown };
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.status === "number") return candidate.status;
  return undefined;
}

function extractErrorCode(value: unknown): string | undefined {
  if (value && typeof value === "object" && "code" in value) {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isNetworkFailure(error: unknown, message: string): boolean {
  if (/fetch failed/i.test(message)) return true;
  return (
    RETRYABLE_NETWORK_CODES.has(extractErrorCode(error) ?? "") ||
    RETRYABLE_NETWORK_CODES.has(extractErrorCode((error as { cause?: unknown })?.cause) ?? "")
  );
}

/** Quota exhaustion rides as a 429 on some providers (z.ai code 1308) — checked BEFORE the generic rate_limited bucket. */
function isQuotaFailure(error: unknown, message: string): boolean {
  if (QUOTA_PATTERN.test(message)) return true;
  if (APICallError.isInstance(error) && error.data !== undefined) {
    try {
      return QUOTA_PATTERN.test(JSON.stringify(error.data));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Classifies a provider failure into a stable `code` + `retryable` + redacted
 * `safe` descriptor. LAYERS OVER `isRetryableStreamError` — it does not change
 * the retry policy, only names the failure for terminal metadata (loop) and
 * health/UI surfaces: known non-retryable buckets (auth/forbidden/quota/400)
 * are consistent with `isRetryableStreamError` returning false for the same
 * error; known retryable buckets (connect_timeout/network/rate_limited/server)
 * are consistent with it returning true. `quota` is the one deliberate
 * OVERRIDE — a 429 quota-exhaustion response would otherwise fall into the
 * generically-retryable rate-limit bucket, but retrying it can never succeed.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureClassification {
  const statusCode = extractStatusCode(error);
  const message = extractMessage(error);

  const build = (code: ProviderFailureCode, retryable: boolean): ProviderFailureClassification => ({
    code,
    retryable,
    safe: { code, message, ...(statusCode !== undefined ? { statusCode } : {}) },
  });

  if (isQuotaFailure(error, message)) {
    return build("quota", false);
  }
  if (CONNECT_TIMEOUT_PATTERN.test(message)) {
    return build("connect_timeout", true);
  }
  if (statusCode === 401) {
    return build("auth", false);
  }
  if (statusCode === 403) {
    return build("forbidden", false);
  }
  if (statusCode === 429) {
    return build("rate_limited", true);
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
    return build("server", true);
  }
  if (statusCode === 400) {
    return build("unknown", false);
  }
  if (isNetworkFailure(error, message)) {
    return build("network", true);
  }
  return build("unknown", isRetryableStreamError(error));
}
