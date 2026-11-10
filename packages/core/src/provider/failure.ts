import { GoInputLimitError } from "./go-input-limit-error.js";
/**
 * Shared model-output and replay-safety classification plus safe provider errors.
 * Model output remains observable for manual retry decisions; reasoning alone
 * remains provisional for automatic retries.
 */

import { APICallError } from "ai";
import { scrubFailureText } from "../utils/scrub-approval-text.js";
import { classifyNetworkConfigurationFailure } from "./network-failure.js";
import type { ModelStreamEvent } from "../types/events.js";
import { isQuotaExhaustion, isRetryableStreamError, USAGE_LIMIT_PATTERN, matchesFailureText } from "./retry.js";

export { MiniMaxBalanceFailure } from "./minimax-failure.js";
import { MiniMaxBalanceFailure, unwrapMiniMaxFailure } from "./minimax-failure.js";

// Only the request boundary knows the actual key used for this attempt. Keep
// the sanitized text separately, without mutating SDK errors or retaining keys.
const providerMessages = new WeakMap<object, string>();

export function captureProviderMessage(error: unknown, apiKey: string | undefined): void {
  if (!APICallError.isInstance(error) || error.statusCode === undefined || error.statusCode < 400 || error.statusCode >= 500 || typeof error.responseBody !== "string") return;
  try {
    const body: unknown = JSON.parse(error.responseBody);
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const root = body as Record<string, unknown>;
    const nested = root.error && typeof root.error === "object" && !Array.isArray(root.error) ? root.error as Record<string, unknown> : undefined;
    const value = [nested?.message, root.message, root.detail].find(value => typeof value === "string" && value.trim());
    if (typeof value !== "string" || !value.trim()) return;
    // Normalize invisible separators before matching the connection's actual key.
    // Allow whitespace between every key character, including across lines.
    const visible = value.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
    const keyPattern = apiKey ? [...apiKey.replace(/[\s\u200b-\u200d\ufeff]/g, "")]
      .map(char => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*") : "";
    const withoutKey = keyPattern ? visible.replace(new RegExp(keyPattern, "gi"), "***") : visible;
    const oneLine = withoutKey
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
    const normalizedPrefixes = oneLine
      .replace(/\bo\s*c\s*_\s*s\s*k\s*_\s*(?=[A-Za-z0-9_-])/gi, "oc_sk_")
      .replace(/\bs\s*k\s*-\s*(?=[A-Za-z0-9_-])/gi, "sk-");
    const safe = scrubFailureText(normalizedPrefixes)
      .replace(/\boc_sk_[A-Za-z0-9_-]+/gi, "[redacted]")
      .replace(/\s+/g, " ").trim().slice(0, 300).trim();
    if (safe) providerMessages.set(error, safe);
  } catch { /* Non-JSON responses have no displayable provider message. */ }
}

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
    case "reasoning_replay_metadata":
    case "error":
    case "stream_retry":
    // a quota observation is transport telemetry, not model
    // output — it must never close the replay gate.
    case "provider_quota":
    // a waiting status is not output either; the replay gate
    // only closes on real model content.
    case "waiting_for_network":
    case "network_wait_end":
      return false;
    default: {
      // Compile-time exhaustiveness: a new ModelStreamEvent variant must be
      // classified explicitly above rather than defaulting silently.
      const unknown: never = e;
      throw new Error(`Unclassified model stream event: ${JSON.stringify(unknown)}`);
    }
  }
}

/** Output whose delivery makes an automatic replay unsafe. */
export function blocksAutomaticReplay(e: ModelStreamEvent): boolean {
  switch (e.type) {
    case "text_delta":
    case "tool_input_start": case "tool_input_delta": case "tool_input_end": case "tool_call":
      return true;
    default:
      return false;
  }
}

/** Stable failure bucket surfaced to the loop/CLI/desktop — never a raw provider error shape. */
export type ProviderFailureCode =
  | "proxy_unreachable"
  | "proxy_auth"
  | "tls"
  | "connect_timeout"
  | "network"
  | "rate_limited"
  | "auth"
  | "forbidden"
  | "server"
  | "quota"
  | "input_limit"
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
 * Stable fallback human string per failure code. Provider messages are only
 * accepted from JSON at the request boundary after key and secret redaction.
 */
const SAFE_MESSAGES: Record<ProviderFailureCode, string> = {
  proxy_unreachable: "Proxy unavailable. Check the connection proxy address and that the proxy is running, then try again.",
  proxy_auth: "Proxy authentication failed (407). Check the username and password in the connection proxy settings.",
  tls: "TLS certificate is not trusted. For a corporate proxy, configure NODE_EXTRA_CA_CERTS with your trusted CA certificate and restart AnyCode.",
  connect_timeout: "connect timeout",
  network: "network error",
  rate_limited: "rate limited",
  auth: "authentication failed",
  forbidden: "forbidden",
  server: "server error",
  quota: "quota exhausted",
  input_limit: "The estimated prompt exceeds the provider input limit. Reduce the prompt or compact the conversation.",
  unknown: "request failed",
};

/** Undici/fetch wraps transient failures behind `TypeError: fetch failed`, cause carrying the errno. */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/** The AI SDK's undici-backed connect failure (owner dogfood: `api.z.ai` unreachable). */
const CONNECT_TIMEOUT_PATTERN = /connect timeout error|cannot connect to api/i;

// the quota patterns, USAGE_LIMIT_PATTERN and matchesFailureText
// live in retry.ts (single source) so isQuotaExhaustion — the AUTO-retry
// refusal — and the classification below share the exact same detection.

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown provider error";
}

/**
 * Exported so callers that need the raw HTTP status ahead of a full
 * classification (e.g. the model port's include_usage probe) reuse
 * this exact extraction instead of duplicating the `APICallError`/plain-object
 * fallback logic.
 */
export function extractStatusCode(error: unknown): number | undefined {
  error = unwrapMiniMaxFailure(error);
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

/** Locally generated watchdog failure; safe to show without provider text. */
export class StreamStallError extends Error {
  constructor(timeoutMs: number) {
    super(`stream stalled: no events for ${timeoutMs}ms`);
    this.name = "StreamStallError";
  }
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
 * terminal metadata's `attemptsMade`. The two INTENTIONALLY diverge in two
 * cases (removed the third — quota — by making
 * `isRetryableStreamError` refuse quota before the 429 status check):
 *   (a) a plain `Error` with connect-timeout text — it does NOT auto-retry (the
 *       form carries no statusCode/errno/isRetryable for the port to act on), yet
 *       the class is transient and a manual retry may succeed ⇒ `true`.
 *   (b) `APICallError{statusCode:400, isRetryable:true}` — the port auto-retries
 *       on the provider flag, but the 400 class is deterministic for re-sending
 *       the same message ⇒ `false`.
 * These divergences are pinned in failure.test.ts (double-assert pins).
 */
export function classifyProviderFailure(error: unknown): ProviderFailureClassification {
  if (error instanceof StreamStallError) return { code: "unknown", retryable: false, safe: { code: "unknown", message: "The provider stream stalled. Please try again; large files may need to be written in parts." } };
  if (error instanceof GoInputLimitError) return { code: "input_limit", retryable: false, safe: { code: "input_limit", message: SAFE_MESSAGES.input_limit } };
  if (error instanceof MiniMaxBalanceFailure) {
    const result = classifyProviderFailure(error.original);
    // A balance explanation does not identify the required subscription key.
    // Keep this local guidance for both HTTP-body and streaming errors.
    return { ...result, safe: { ...result.safe, message: `${result.safe.message}. This is a pay-as-you-go key; for the M Plan subscription use a key starting with sk-cp-.` } };
  }
  const statusCode = extractStatusCode(error);
  const message = extractMessage(error);

  const original = unwrapMiniMaxFailure(error);
  const providerMessage = original && typeof original === "object" ? providerMessages.get(original) : undefined;
  const build = (code: ProviderFailureCode, retryable: boolean): ProviderFailureClassification => {
    const hint = SAFE_MESSAGES[code];
    const repeatsHint = providerMessage?.toLowerCase() === hint.toLowerCase() ||
      providerMessage?.toLowerCase().startsWith(`${hint.toLowerCase()}:`);
    const message = providerMessage ? (repeatsHint ? providerMessage : `${hint}: ${providerMessage}`) : hint;
    return { code, retryable, safe: { code, message, ...(statusCode !== undefined ? { statusCode } : {}) } };
  };

  const networkConfiguration = classifyNetworkConfigurationFailure(error);
  if (networkConfiguration !== undefined) return build(networkConfiguration, false);

  // Quota-by-text is gated on status: a status code that already names a more
  // specific bucket (401/403/5xx) wins over quota-shaped text (M3,
  // W11-FIX). This preserves the two documented quota cases — z.ai's 1308
  // riding as a 429, and a status-less quota message — while a 401/403/5xx
  // whose message happens to mention "quota" classifies on its actual status.
  // Quota rides as a 429 on some providers (z.ai code 1308) or arrives with no
  // status code at all; isQuotaExhaustion also keeps a rate-limit 429 out of it.
  if ((statusCode === undefined || statusCode === 429) && isQuotaExhaustion(error)) {
    return build("quota", false);
  }
  // The one 403 carve-out from M3: a kimi-class subscription reports REAL quota
  // exhaustion as a 403 with an explicit usage-limit message. The narrow phrase
  // keeps policy denials that merely mention "quota" in the forbidden bucket.
  if (statusCode === 403 && matchesFailureText(error, message, USAGE_LIMIT_PATTERN)) {
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
