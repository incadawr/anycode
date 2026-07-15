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
  /**
   * Whether a MANUAL retry (W8's Try-again button) has a chance of succeeding —
   * NOT the auto-retry decision. Auto-retry is decided solely by
   * `isRetryableStreamError` (retry.ts) and is observable via the terminal
   * metadata's `attemptsMade`; the two fields intentionally diverge (see
   * `classifyProviderFailure`).
   */
  retryable: boolean;
  safe: ProviderFailureSafe;
}

/**
 * Stable, whitelisted human string per failure code. `safe.message` is derived
 * from the classified `code`, NEVER from the raw provider error text — a
 * provider or custom error that embeds a response body or auth header in its
 * `.message` can therefore never leak it through the redacted descriptor
 * (TASK.33 W7b-FIX #1). `safe.code`/`safe.statusCode` are already safe.
 */
const SAFE_MESSAGES: Record<ProviderFailureCode, string> = {
  connect_timeout: "connect timeout",
  network: "network error",
  rate_limited: "rate limited",
  auth: "authentication failed",
  forbidden: "forbidden",
  server: "server error",
  quota: "quota exhausted",
  unknown: "request failed",
};

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

/** Quota exhaustion rides as a 429 on some providers (z.ai code 1308), or arrives with no status code at all. */
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
 * `safe` descriptor. LAYERS OVER `isRetryableStreamError` (retry.ts) without
 * changing the retry policy; it only names the failure for terminal metadata
 * (loop) and health/UI surfaces.
 *
 * `retryable` means whether a MANUAL retry has a chance of succeeding — it gates
 * W8's Try-again button. It is NOT the auto-retry decision: auto-retry is made
 * solely by `isRetryableStreamError` in the model port and is observable via the
 * terminal metadata's `attemptsMade`. The two INTENTIONALLY diverge in three
 * cases:
 *   (a) quota-429 — 429 is a retryable status code, so the port auto-retries, but
 *       a manual retry of a quota-exhausted account can never succeed ⇒ `false`.
 *   (b) a plain `Error` with connect-timeout text — it does NOT auto-retry (the
 *       form carries no statusCode/errno/isRetryable for the port to act on), yet
 *       the class is transient and a manual retry may succeed ⇒ `true`.
 *   (c) `APICallError{statusCode:400, isRetryable:true}` — the port auto-retries
 *       on the provider flag, but the 400 class is deterministic for re-sending
 *       the same message ⇒ `false`.
 * These three divergences are pinned in failure.test.ts (double-assert pins).
 */
export function classifyProviderFailure(error: unknown): ProviderFailureClassification {
  const statusCode = extractStatusCode(error);
  const message = extractMessage(error);

  // `safe.message` is derived from the classified `code` (SAFE_MESSAGES), NEVER
  // from `message` — the raw text is used only for classification below.
  const build = (code: ProviderFailureCode, retryable: boolean): ProviderFailureClassification => ({
    code,
    retryable,
    safe: { code, message: SAFE_MESSAGES[code], ...(statusCode !== undefined ? { statusCode } : {}) },
  });

  // Quota-by-text is gated on status: a status code that already names a more
  // specific bucket (401/403/5xx) wins over quota-shaped text (M3, TASK.45
  // W11-FIX). This preserves the two documented quota cases — z.ai's 1308
  // riding as a 429, and a status-less quota message — while a 401/403/5xx
  // whose message happens to mention "quota" classifies on its actual status.
  if ((statusCode === undefined || statusCode === 429) && isQuotaFailure(error, message)) {
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
