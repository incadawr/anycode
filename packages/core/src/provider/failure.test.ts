/**
 * `isModelOutputEvent` — the W7a retry gate. Pins the full table so a
 * new ModelStreamEvent variant cannot silently change which events keep the gate
 * open (retryable before-content window) vs close it (no auto-retry). The
 * behavioral consequences are exercised end-to-end in model-port.test.ts and
 * transport-contract.integration.test.ts; this pins the classification directly.
 */

import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "../types/events.js";
import { captureProviderMessage, classifyProviderFailure, extractStatusCode, MiniMaxBalanceFailure, isModelOutputEvent } from "./failure.js";
import { isQuotaExhaustion, isRetryableStreamError } from "./retry.js";

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
  // quota telemetry is transport metadata, not model output.
  { type: "provider_quota", quota: { primary: { usedPercent: 42 }, sources: ["x-ratelimit-requests-remaining"] }, baseUrl: "https://api.example.com" },
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
 * `classifyProviderFailure` (W7b) — layers over `isRetryableStreamError`
 * (retry.ts): known buckets never disagree with it (asserted per case below).
 * Since quota no longer auto-retries: `isRetryableStreamError`
 * refuses quota before the 429 status check, so quota's non-auto-retry
 * behavior is pinned by retry.test.ts (`isQuotaExhaustion` describe); the
 * divergence pins below cover the cases that still diverge.
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
  it("classifies a real connect-timeout APICallError (owner dogfood) as connect_timeout/retryable", () => {
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

  it("classifies a kimi-style 403 usage-limit as quota, not forbidden (subscription exhaustion rides a 403)", () => {
    const error = apiCallError({
      message:
        "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing",
      statusCode: 403,
    });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "quota", retryable: false });
    // safe.message stays the whitelisted per-code string — the raw text (and its
    // pricing URL) never reaches the redacted descriptor.
    expect(result.safe).toEqual({ code: "quota", message: "quota exhausted", statusCode: 403 });
  });

  it("classifies a 403 usage-limit carried only in structured `data` as quota", () => {
    const error = apiCallError({
      message: "request failed",
      statusCode: 403,
      data: { error: { message: "You've reached your usage limit for this billing cycle." } },
    });

    expect(classifyProviderFailure(error)).toMatchObject({ code: "quota", retryable: false });
  });

  it("classifies a 403 that merely mentions quota (no usage-limit phrase) as forbidden (M3 boundary holds)", () => {
    const error = apiCallError({ message: "quota policy denies this key", statusCode: 403 });

    expect(classifyProviderFailure(error)).toMatchObject({ code: "forbidden", retryable: false });
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
    // quota no longer auto-retries — isRetryableStreamError now
    // refuses quota (isQuotaExhaustion) before the 429 status check.
    expect(isQuotaExhaustion(error)).toBe(true);
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("classifies a quota error carrying the code only in structured `data`, not the message", () => {
    const error = apiCallError({
      message: "request failed",
      statusCode: 429,
      data: { error: { code: "1308", message: "quota exceeded" } },
    });

    expect(classifyProviderFailure(error)).toMatchObject({ code: "quota", retryable: false });
  });

  it("classifies a 401 whose message happens to mention quota as auth, not quota (M3: status wins over quota text)", () => {
    const error = apiCallError({ message: "insufficient quota", statusCode: 401 });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "auth", retryable: false });
  });

  it("classifies a 500 whose message happens to mention quota as server, not quota (M3: status wins over quota text)", () => {
    const error = apiCallError({ message: "quota backend down", statusCode: 500 });

    const result = classifyProviderFailure(error);

    expect(result).toMatchObject({ code: "server", retryable: true });
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

  it("classifies an undici mid-stream socket drop (UND_ERR_SOCKET) as network, retryable (review)", () => {
    const error = Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });

    expect(classifyProviderFailure(error)).toMatchObject({ code: "network", retryable: true });
    expect(isRetryableStreamError(error)).toBe(true);
  });

  it("classifies a bare ENETUNREACH as network, retryable", () => {
    const error = Object.assign(new Error("connect ENETUNREACH 1.2.3.4:443"), { code: "ENETUNREACH" });

    expect(classifyProviderFailure(error)).toMatchObject({ code: "network", retryable: true });
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
 * The cases where `retryable` (manual-retry worthiness — the Try-again
 * gate) INTENTIONALLY diverges from `isRetryableStreamError` (the auto-retry
 * decision). Each is a DOUBLE assert so it goes red if EITHER side is later
 * "fixed" to match the other: the divergence is the contract, not a bug
 * (W7b-FIX #2). removed the quota divergence (quota no longer
 * auto-retries — see isQuotaExhaustion in retry.test.ts); (b) and (c) remain.
 */
describe("classifyProviderFailure — intentional divergence from isRetryableStreamError (W7b-FIX #2 pins)", () => {
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


describe("MiniMax balance failure", () => {
  it("preserves retry, status and quota decisions when adding a MiniMax hint", () => {
    for (const error of [Object.assign(new Error("insufficient_balance_error"), { statusCode: 503 }), new Error("insufficient_balance_error quota")]) {
      const wrapped = new MiniMaxBalanceFailure(error);
      expect(isRetryableStreamError(wrapped)).toBe(isRetryableStreamError(error));
      expect(extractStatusCode(wrapped)).toBe(extractStatusCode(error));
      expect(isQuotaExhaustion(wrapped)).toBe(isQuotaExhaustion(error));
      const original = classifyProviderFailure(error);
      const result = classifyProviderFailure(wrapped);
      expect(result).toMatchObject({ code: original.code, retryable: original.retryable, safe: original.safe.statusCode === undefined ? {} : { statusCode: original.safe.statusCode } });
      expect(result.safe.message).toContain("M Plan");
    }
  });
});


describe("provider explanations", () => {
  const expired = "This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key.";
  function captured(body: unknown, statusCode = 401, key?: string) {
    const error = new APICallError({ message: "request failed", url: "https://fixture.invalid", requestBodyValues: {}, statusCode,
      responseBody: JSON.stringify(body), responseHeaders: { authorization: "Bearer header-secret" } });
    captureProviderMessage(error, key);
    return { error, result: classifyProviderFailure(error) };
  }
  it("keeps the auth category beside the OpenCode expired-key explanation", () => {
    const { result } = captured({ error: { type: "authentication_error", code: "api_key_expired", message: expired } });
    expect(result.safe).toEqual({ code: "auth", statusCode: 401, message: `authentication failed: ${expired}` });
  });
  it.each([{ error: { code: "invalid_api_key", type: "authentication_error" } }, {}, { error: { message: " " } }])("keeps the old text without a message: %j", body => {
    expect(captured(body).result.safe.message).toBe("authentication failed");
  });
  it.each([{ error: { message: "Model unavailable", code: "invalid_request" } }, { type: "error", error: { type: "invalid_request_error", message: "Model unavailable" } }, { message: "Model unavailable" }, { detail: "Model unavailable" }])("accepts a message from %j", body => {
    expect(captured(body, 400).result.safe.message).toBe("request failed: Model unavailable");
  });
  it("redacts keys before truncation and removes control and bidi characters", () => {
    const secrets = ["own.$key", "sk-short", "oc_sk_short", "private-token", "x".repeat(64), "a.b~".repeat(20)];
    const { result } = captured({ error: { message: `Expired\n\u202e\u2066\u200f\u001b ${secrets[0]} ${secrets[1]} ${secrets[2]} Bearer ${secrets[3]} ${secrets[4]} ${secrets[5]}` } }, 401, secrets[0]);
    const text = JSON.stringify(result.safe);
    for (const secret of [...secrets, "header-secret"]) expect(text).not.toContain(secret);
    expect(result.safe.message).toContain("Expired");
    expect(result.safe.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/);
  });
  it.each([
    "https://platform.openai.com/docs/guides/error-codes/api-errors",
    "https://opencode.ai/workspace/keys/new-after-expiry-today",
    "/workspace/provider/documentation/renewing-api-credentials.md",
    "docs/provider/documentation/renewing-api-credentials.md",
  ])("keeps documentation URLs and paths readable: %s", location => {
    expect(captured({ message: `See ${location} for details` }).result.safe.message).toBe(`authentication failed: See ${location} for details`);
  });
  it.each([" ", "\n", "\u200b", "\u200c", "\u200d", "\ufeff", "\u202e"])("redacts the connection key with inserted separators: %j", separator => {
    const key = "own.Key-1234567890ABCDEF9876543210";
    const split = key.match(/.{1,10}/g)!.join(separator);
    expect(captured({ message: `Expired ${split} today` }, 401, key).result.safe.message).toBe("authentication failed: Expired *** today");
  });
  it.each(["s k - abc123secret", "o c _ s k _ abc123secret"])("redacts a spaced key prefix: %s", key => {
    expect(captured({ message: `Expired ${key} today` }).result.safe.message).toBe("authentication failed: Expired [redacted] today");
  });
  it("bounds long messages while preserving the category", () => {
    const text = captured({ message: "Long message ".repeat(1000) }).result.safe.message;
    expect(text).toContain("authentication failed: Long message");
    expect(text.length).toBeLessThanOrEqual(323);
  });
  it("keeps actionable billing guidance beside provider explanations", () => {
    const explained = captured({ error: { message: "insufficient balance" } }, 403);
    const unexplained = captured({ error: { code: "insufficient_balance_error" } }, 403);
    expect(classifyProviderFailure(new MiniMaxBalanceFailure(explained.error)).safe.message).toBe("forbidden: insufficient balance. This is a pay-as-you-go key; for the M Plan subscription use a key starting with sk-cp-.");
    expect(classifyProviderFailure(new MiniMaxBalanceFailure(unexplained.error)).safe.message).toBe("forbidden. This is a pay-as-you-go key; for the M Plan subscription use a key starting with sk-cp-.");
  });
  it("keeps explanations and raw bodies out of telemetry", async () => {
    const { telemetryRecordFor } = await import("../telemetry/records.js");
    const { error, result } = captured({ error: { message: expired } });
    expect(telemetryRecordFor({ type: "error", error, safe: result.safe })).toEqual({ t: "error" });
  });
});
