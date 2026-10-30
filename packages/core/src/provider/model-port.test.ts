/**
 * Tests for the AiSdkModelPort retry cycle (design §2.9, phase-1 §4 row 1.6
 * test plan). The AI SDK's `streamText` export is mocked so each attempt's
 * `fullStream` can be scripted to fail before/after yielding a part, or
 * succeed outright; `createAnthropicLanguageModel` is left real since it has
 * no side effects at construction time (no network call).
 */

import { APICallError, TypeValidationError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { DiagnosticEvent } from "../types/diagnostics.js";
import type { AnthropicEndpointConfig } from "./anthropic.js";
import type { EndpointConfig } from "./endpoint.js";

const mockStreamText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
  };
});

// TASK.168: records every `createLanguageModel` call while still DELEGATING
// to the real implementation (no behaviour change for any existing test in
// this file) — the include_usage probe's whole effect is baked into the
// EndpointConfig passed to this call, not into `streamText`'s own args, so
// this is the only seam that can observe whether a given attempt actually
// asked for the flag.
const mockCreateLanguageModel = vi.fn();

vi.mock("./language-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./language-model.js")>();
  return {
    ...actual,
    createLanguageModel: (...args: Parameters<typeof actual.createLanguageModel>) => {
      mockCreateLanguageModel(...args);
      return actual.createLanguageModel(...args);
    },
  };
});

const { AiSdkModelPort, reasoningRequestOptions } = await import("./model-port.js");

describe("reasoningRequestOptions", () => {
  it("is byte-dormant when effort is off", () => {
    expect(reasoningRequestOptions({ ...baseRequest }, "Anthropic")).toEqual({});
    expect(reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 8192, reasoningEffort: "off" }, "Z.AI (GLM)")).toEqual({ maxOutputTokens: 8192 });
  });

  it("maps Claude effort to Anthropic thinking and keeps max output above its budget", () => {
    expect(reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 512, reasoningEffort: "high" }, "Anthropic")).toEqual({
      maxOutputTokens: 25_600,
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 24_576 } } },
    });
    expect(reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 30_000, reasoningEffort: "high" }, "Anthropic")).toEqual({
      maxOutputTokens: 30_000,
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 24_576 } } },
    });
  });

  it("maps GLM through the Anthropic proxy to effort enum + thinking budget", () => {
    expect(reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 512, reasoningEffort: "high" }, "Z.AI (GLM)")).toEqual({
      maxOutputTokens: 512,
      providerOptions: { anthropic: { effort: "high", thinking: { type: "enabled", budgetTokens: 16_000 } } },
    });
    expect(reasoningRequestOptions({ ...baseRequest, reasoningEffort: "max" }, "Z.AI (GLM)")).toEqual({
      providerOptions: { anthropic: { effort: "max", thinking: { type: "enabled", budgetTokens: 32_000 } } },
    });
  });

  // TASK.163 (2026-08-28): docs.z.ai/guides/llm/glm-5.3 documents `low` as a
  // real, distinct effort tier (not just "off"), so the wire mapping must stop
  // silently upgrading it to `high` — that collapse would make the catalog's
  // now-honest `low` tier a fresh lie. z.ai documents no per-tier budget for
  // `low`; `high`'s 16_000 budget is reused as a CEILING (a cap on thinking
  // output, not a floor), so it cannot under-serve `low`'s lighter reasoning.
  it("maps GLM 'low' effort to the wire as 'low', reusing the high budget as a ceiling", () => {
    expect(reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 512, reasoningEffort: "low" }, "Z.AI (GLM)")).toEqual({
      maxOutputTokens: 512,
      providerOptions: { anthropic: { effort: "low", thinking: { type: "enabled", budgetTokens: 16_000 } } },
    });
  });

  it("still collapses GLM 'medium' effort to 'high' — no documented GLM equivalent", () => {
    expect(reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 512, reasoningEffort: "medium" }, "Z.AI (GLM)")).toEqual({
      maxOutputTokens: 512,
      providerOptions: { anthropic: { effort: "high", thinking: { type: "enabled", budgetTokens: 16_000 } } },
    });
  });

  it("keeps GLM reasoning requests within Z.AI's 131072 max_tokens wire ceiling", () => {
    const high = reasoningRequestOptions(
      { ...baseRequest, maxOutputTokens: 131_072, reasoningEffort: "high" },
      "Z.AI (GLM)",
    );
    expect(high.maxOutputTokens).toBe(115_072);
    expect(high.maxOutputTokens! + (high.providerOptions!.anthropic.thinking as { type: "enabled"; budgetTokens: number }).budgetTokens).toBe(131_072);

    const max = reasoningRequestOptions(
      { ...baseRequest, maxOutputTokens: 131_072, reasoningEffort: "max" },
      "Z.AI (GLM)",
    );
    expect(max.maxOutputTokens).toBe(99_072);
    expect(max.maxOutputTokens! + (max.providerOptions!.anthropic.thinking as { type: "enabled"; budgetTokens: number }).budgetTokens).toBe(131_072);
  });

  // TASK 4241 (2026-10-10): DeepSeek declares distinct low/high/max effort
  // tiers (live GET /models facts, default high). The wire mapping sends the
  // enum VERBATIM via providerOptions.anthropic.effort with NO thinking
  // budget (no DeepSeek budget fact exists) and NO maxOutputTokens
  // arithmetic — unlike the default Anthropic path, `max` is preserved.
  it("maps DeepSeek effort verbatim low/high/max with no thinking budget and untouched maxOutputTokens (TASK 4241)", () => {
    const low = reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 512, reasoningEffort: "low" }, "DeepSeek");
    expect(low).toEqual({ maxOutputTokens: 512, providerOptions: { anthropic: { effort: "low" } } });
    expect(low.providerOptions!.anthropic.thinking).toBeUndefined();

    const high = reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 512, reasoningEffort: "high" }, "DeepSeek");
    expect(high).toEqual({ maxOutputTokens: 512, providerOptions: { anthropic: { effort: "high" } } });
    expect(high.providerOptions!.anthropic.thinking).toBeUndefined();

    // Preserved verbatim — the default Anthropic path would collapse max to
    // high's budgetTokens instead of carrying the enum.
    const maxEffort = reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 512, reasoningEffort: "max" }, "DeepSeek");
    expect(maxEffort).toEqual({ maxOutputTokens: 512, providerOptions: { anthropic: { effort: "max" } } });
    expect(maxEffort.providerOptions!.anthropic.thinking).toBeUndefined();
  });

  it("collapses an undeclared DeepSeek 'medium' to 'high' (local precedent, mirrors the GLM branch)", () => {
    expect(reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 512, reasoningEffort: "medium" }, "DeepSeek")).toEqual({
      maxOutputTokens: 512,
      providerOptions: { anthropic: { effort: "high" } },
    });
  });

  it("provider isolation: the same request maps differently on Anthropic vs Z.AI (GLM) vs DeepSeek (TASK 4241)", () => {
    const request = { ...baseRequest, maxOutputTokens: 512, reasoningEffort: "high" } as const;
    const anthropic = reasoningRequestOptions({ ...request }, "Anthropic");
    expect(anthropic.providerOptions!.anthropic.thinking).toEqual({ type: "enabled", budgetTokens: 24_576 });
    expect("effort" in anthropic.providerOptions!.anthropic).toBe(false);

    const glm = reasoningRequestOptions({ ...request }, "Z.AI (GLM)");
    expect(glm.providerOptions!.anthropic.effort).toBe("high");
    expect(glm.providerOptions!.anthropic.thinking).toEqual({ type: "enabled", budgetTokens: 16_000 });

    const deepseek = reasoningRequestOptions({ ...request }, "DeepSeek");
    expect(deepseek.providerOptions!.anthropic.effort).toBe("high");
    expect(deepseek.providerOptions!.anthropic.thinking).toBeUndefined();
  });
});

describe("reasoningRequestOptions — prompt cache options (GitHub #15)", () => {
  const cache = { mode: "implicit", ttl: "30m" } as const;

  it("cache options survive absent and disabled reasoning", () => {
    expect(reasoningRequestOptions({ ...baseRequest }, "OpenAI", "openai-chat-completions", cache)).toEqual({
      providerOptions: { openaiCompatible: { prompt_cache_options: cache } },
    });
    expect(
      reasoningRequestOptions({ ...baseRequest, reasoningEffort: "off", maxOutputTokens: 4096 }, undefined, "openai-chat-completions", cache),
    ).toEqual({
      maxOutputTokens: 4096,
      providerOptions: { openaiCompatible: { prompt_cache_options: cache } },
    });
    expect(reasoningRequestOptions({ ...baseRequest }, "OpenAI", "openai-responses", cache)).toEqual({
      providerOptions: { openai: { store: false, promptCacheOptions: cache } },
    });
    expect(
      reasoningRequestOptions({ ...baseRequest, reasoningEffort: "off", maxOutputTokens: 4096 }, undefined, "openai-responses", cache),
    ).toEqual({
      maxOutputTokens: 4096,
      providerOptions: { openai: { store: false, promptCacheOptions: cache } },
    });
  });

  it("cache options merge with transport-specific effort", () => {
    expect(
      reasoningRequestOptions({ ...baseRequest, reasoningEffort: "high", maxOutputTokens: 2048 }, "custom", "openai-chat-completions", cache),
    ).toEqual({
      maxOutputTokens: 2048,
      providerOptions: { openaiCompatible: { reasoningEffort: "high", prompt_cache_options: cache } },
    });
    expect(
      reasoningRequestOptions({ ...baseRequest, reasoningEffort: "max" }, "custom", "openai-chat-completions", cache),
    ).toEqual({
      providerOptions: { openaiCompatible: { reasoningEffort: "max", prompt_cache_options: cache } },
    });
    expect(
      reasoningRequestOptions({ ...baseRequest, reasoningEffort: "max", maxOutputTokens: 2048 }, "OpenAI", "openai-responses", cache),
    ).toEqual({
      maxOutputTokens: 2048,
      providerOptions: { openai: { store: false, reasoningEffort: "max", promptCacheOptions: cache } },
    });
  });

  it("preserves caching with GPT-6 reasoning and disabled reasoning", () => {
    expect(reasoningRequestOptions({ ...baseRequest, reasoningEffort: "high" }, "OpenAI", "openai-responses", cache, "gpt-6-sol")).toEqual({
      providerOptions: { openai: { store: false, reasoningEffort: "high", forceReasoning: true, promptCacheOptions: cache } },
    });
    expect(reasoningRequestOptions({ ...baseRequest, reasoningEffort: "off" }, "OpenAI", "openai-responses", cache, "gpt-6-sol")).toEqual({
      providerOptions: { openai: { store: false, reasoningEffort: "none", forceReasoning: true, promptCacheOptions: cache } },
    });
    expect(reasoningRequestOptions({ ...baseRequest, reasoningEffort: "off" }, "OpenAI", "openai-chat-completions", cache, "gpt-6-sol")).toEqual({
      providerOptions: { openaiCompatible: { reasoningEffort: "none", prompt_cache_options: cache } },
    });
  });

  it("no cache options leaves the old option object exact", () => {
    expect(reasoningRequestOptions({ ...baseRequest }, "OpenAI", "openai-chat-completions")).toEqual({});
    expect(reasoningRequestOptions({ ...baseRequest }, "OpenAI", "openai-responses")).toEqual({
      providerOptions: { openai: { store: false } },
    });
    expect(reasoningRequestOptions({ ...baseRequest, reasoningEffort: "high", maxOutputTokens: 2048 }, "custom", "openai-chat-completions")).toEqual({
      maxOutputTokens: 2048,
      providerOptions: { openaiCompatible: { reasoningEffort: "high" } },
    });
    // Anthropic ignores the fourth argument entirely.
    expect(reasoningRequestOptions({ ...baseRequest }, "Anthropic", "anthropic-messages", cache)).toEqual({});
  });
});

type FakeStep = { kind: "part"; part: Record<string, unknown> } | { kind: "throw"; error: unknown };

function part(p: Record<string, unknown>): FakeStep {
  return { kind: "part", part: p };
}

function throwsWith(error: unknown): FakeStep {
  return { kind: "throw", error };
}

function fakeResult(steps: FakeStep[]) {
  return {
    fullStream: (async function* () {
      for (const step of steps) {
        if (step.kind === "throw") {
          throw step.error;
        }
        yield step.part;
      }
    })(),
  };
}

const startPart = { type: "start" };
const finishPart = {
  type: "finish",
  finishReason: "stop",
  totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function retryableError(): APICallError {
  return new APICallError({
    message: "overloaded",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: 529,
    isRetryable: false,
  });
}

function nonRetryableError(): APICallError {
  return new APICallError({
    message: "bad request",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  });
}

function baseConfig(retry?: Partial<AnthropicEndpointConfig["retry"]>): AnthropicEndpointConfig {
  return {
    transport: "anthropic-messages",
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    model: "claude-test",
    retry: { baseDelayMs: 1, maxDelayMs: 1, ...retry },
  };
}

const baseRequest: ModelRequest = {
  messages: [{ role: "user", content: "hi" }],
  tools: [],
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

beforeEach(() => {
  mockStreamText.mockReset();
  mockCreateLanguageModel.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AiSdkModelPort — happy path", () => {
  it("measures first output and generation duration on the successful stream attempt", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockStreamText.mockImplementationOnce(() => ({ fullStream: (async function* () {
      yield startPart;
      now = 300; yield { type: "reasoning-delta", id: "r", text: "thinking" };
      now = 1300; yield finishPart;
    })() }));
    const events = await collect(new AiSdkModelPort(baseConfig()).streamText(baseRequest));
    expect(events.find((event) => event.type === "finish")).toMatchObject({ timeToFirstTokenMs: 200, generationDurationMs: 1000 });
  });

  it("yields translated events for a single successful attempt with no retries", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));

    const port = new AiSdkModelPort(baseConfig());
    const events = await collect(port.streamText(baseRequest));

    expect(events).toEqual([
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("calls the SDK with maxRetries: 0 (adapter owns retries, not the SDK)", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    const port = new AiSdkModelPort(baseConfig());
    await collect(port.streamText(baseRequest));

    expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });

  it("puts reasoning effort on the outgoing SDK request", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    await collect(new AiSdkModelPort(baseConfig()).streamText({ ...baseRequest, reasoningEffort: "medium", maxOutputTokens: 20_000 }));
    expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 20_000,
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12_288 } } },
    }));
  });
});

describe("AiSdkModelPort — retry before model output (thrown exception)", () => {
  it("retries a connect failure that throws after the synthetic start, then succeeds", async () => {
    const error = retryableError();
    mockStreamText
      // Real SDK shape: `start` is yielded before the connect failure throws;
      // W7a keeps the gate open through `start`, so the throw still retries.
      .mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error)]))
      .mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    const events = await collect(port.streamText(baseRequest));

    // start (attempt 0) → retry → start (attempt 1) → finish. Each attempt
    // re-yields its own synthetic `start` (Fable §1 edge-case 4).
    expect(events[0]).toEqual({ type: "start" });
    expect(events[1]).toMatchObject({ type: "stream_retry", attempt: 1, maxAttempts: 3 });
    expect(events.slice(2)).toEqual([
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });

  it("redacts the raw error in stream_retry.reason — no secret reaches the reason string (W7b-FIX #2)", async () => {
    const poisoned = new APICallError({
      message: "overloaded Authorization: Bearer sk-test",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: { apiKey: "sk-test" },
      statusCode: 529,
      isRetryable: false,
    });
    mockStreamText
      .mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(poisoned)]))
      .mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    const events = await collect(port.streamText(baseRequest));

    const retry = events.find((e) => e.type === "stream_retry");
    expect(retry).toBeDefined();
    expect(JSON.stringify(retry)).not.toContain("sk-test");
    // The reason is the whitelist-derived safe message for the classified code.
    expect((retry as { reason: string }).reason).toBe("server error");
  });

  it("does not retry a non-retryable error (e.g. HTTP 400) even before any content", async () => {
    const error = nonRetryableError();
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error)]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    await expect(collect(port.streamText(baseRequest))).rejects.toBe(error);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once maxRetries is exhausted and propagates the final error", async () => {
    const error1 = retryableError();
    const error2 = retryableError();
    const error3 = retryableError();
    mockStreamText
      .mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error1)]))
      .mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error2)]))
      .mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error3)]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 2 }));
    const iterator = port.streamText(baseRequest)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    expect((await iterator.next()).value).toMatchObject({ type: "stream_retry", attempt: 1, maxAttempts: 2 });
    expect((await iterator.next()).value).toEqual({ type: "start" });
    expect((await iterator.next()).value).toMatchObject({ type: "stream_retry", attempt: 2, maxAttempts: 2 });
    expect((await iterator.next()).value).toEqual({ type: "start" });

    await expect(iterator.next()).rejects.toBe(error3);
    expect(mockStreamText).toHaveBeenCalledTimes(3);
  });

  it("disables retries entirely when maxRetries is 0 (ANYCODE_MAX_RETRIES=0)", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error)]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 0 }));
    await expect(collect(port.streamText(baseRequest))).rejects.toBe(error);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });
});

describe("AiSdkModelPort — no retry after model output (midStreamRetries disabled)", () => {
  it("propagates a mid-stream thrown error without retrying once MODEL OUTPUT has been yielded", async () => {
    const error = retryableError();
    // start alone no longer closes the gate (W7a); a text_delta does — the
    // subsequent throw must NOT retry when replay is disabled
    // (midStreamRetries: 0 = pre-4705 behavior).
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), part({ type: "text-delta", id: "t1", text: "hi" }), throwsWith(error)]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, midStreamRetries: 0 }));
    const iterator = port.streamText(baseRequest)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    expect((await iterator.next()).value).toEqual({ type: "text_delta", id: "t1", text: "hi" });
    await expect(iterator.next()).rejects.toBe(error);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });
});

describe("AiSdkModelPort — retryable/non-retryable `error` stream parts", () => {
  it("retries a retryable `error` part that arrives right after the synthetic start (the prod connect shape)", async () => {
    const error = retryableError();
    mockStreamText
      // Real connect-failure shape: start, then a translated retryable `error`
      // STREAM PART (not a throw) — the branch that was dead in prod pre-W7a.
      .mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error })]))
      .mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    const events = await collect(port.streamText(baseRequest));

    expect(events[0]).toEqual({ type: "start" });
    expect(events[1]).toMatchObject({ type: "stream_retry", attempt: 1, maxAttempts: 3 });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.find((e) => e.type === "finish")).toMatchObject({ type: "finish" });
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });

  it("yields a non-retryable `error` part as a normal error event with no retry", async () => {
    const error = nonRetryableError();
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error })]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    const events = await collect(port.streamText(baseRequest));

    expect(events).toEqual([{ type: "start" }, { type: "error", error }]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });
});

describe("AiSdkModelPort — W7a model-output retry gate (midStreamRetries disabled)", () => {
  const textDelta = (text: string) => ({ type: "text-delta", id: "t1", text });
  const toolCallPart = { type: "tool-call", toolCallId: "call_1", toolName: "Read", input: { file_path: "/a.txt" } };
  // Taskana 4705: these pin the gate for users who disable replay
  // (midStreamRetries: 0); with replay on, a bounded mid-stream retry fires.
  const gateConfig = () => baseConfig({ maxRetries: 3, midStreamRetries: 0 });

  it("start → text_delta → retryable error part ⇒ NO retry (content closed the gate)", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), part(textDelta("hi")), part({ type: "error", error })]),
    );

    const port = new AiSdkModelPort(gateConfig());
    const events = await collect(port.streamText(baseRequest));

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    expect(events).toEqual([
      { type: "start" },
      { type: "text_delta", id: "t1", text: "hi" },
      { type: "error", error },
    ]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("start → tool_call → error part ⇒ NO retry (tool activity closed the gate — invariant #1)", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), part(toolCallPart), part({ type: "error", error })]),
    );

    const port = new AiSdkModelPort(gateConfig());
    const events = await collect(port.streamText(baseRequest));

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toMatchObject({ type: "tool_call", toolCall: { id: "call_1", name: "Read" } });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("start → finish → error part ⇒ NO retry (a completed step is never replayed — Fable §1 edge-case 1)", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), part(finishPart), part({ type: "error", error })]),
    );

    const port = new AiSdkModelPort(gateConfig());
    const events = await collect(port.streamText(baseRequest));

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    expect(events.find((e) => e.type === "finish")).toMatchObject({ type: "finish", finishReason: "stop" });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });
});

describe("AiSdkModelPort — ignorable provider stream artifacts (slice 3.7 R1)", () => {
  /** A content-block-level chunk-parse failure (z.ai `tool_result` block): safe to drop. */
  function ignorableArtifact(): TypeValidationError {
    return new TypeValidationError({
      value: { type: "content_block_start", index: 1, content_block: { type: "tool_result" } },
      cause: new Error("no matching discriminator"),
    });
  }

  const textDelta = (text: string) => ({ type: "text-delta", id: "t1", text });

  it("drops an ignorable error mid-stream, keeps yielding, and warns once for a repeated signature", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([
        part(startPart),
        part(textDelta("a")),
        part({ type: "error", error: ignorableArtifact() }),
        part({ type: "error", error: ignorableArtifact() }),
        part(textDelta("b")),
        part(finishPart),
      ]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    const events = await collect(port.streamText(baseRequest));

    expect(events).toEqual([
      { type: "start" },
      { type: "text_delta", id: "t1", text: "a" },
      { type: "text_delta", id: "t1", text: "b" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, timeToFirstTokenMs: expect.any(Number), generationDurationMs: expect.any(Number) },
    ]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1); // deduped by signature
    expect(mockStreamText).toHaveBeenCalledTimes(1); // no retry consumed
  });

  it("still yields a NON-ignorable (message-level) chunk-parse error as before — behaviour unchanged", async () => {
    const fatal = new TypeValidationError({ value: { type: "message_delta" }, cause: new Error("bad") });
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), part({ type: "error", error: fatal })]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    const iterator = port.streamText(baseRequest)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    expect((await iterator.next()).value).toEqual({ type: "error", error: fatal });
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("drops an ignorable error that arrives BEFORE the first event without retrying or burning budget", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part({ type: "error", error: ignorableArtifact() }), part(startPart), part(finishPart)]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    const events = await collect(port.streamText(baseRequest));

    expect(events).toEqual([
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
    expect(events.some((e) => e.type === "stream_retry" || e.type === "error")).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(mockStreamText).toHaveBeenCalledTimes(1); // attempt never retried
  });
});

describe("AiSdkModelPort — named diagnostics seam (slice 5.6 Wave B)", () => {
  /** A content-block-level chunk-parse failure (z.ai `tool_result` block): safe to drop. */
  function ignorableArtifact(): TypeValidationError {
    return new TypeValidationError({
      value: { type: "content_block_start", index: 1, content_block: { type: "tool_result" } },
      cause: new Error("no matching discriminator"),
    });
  }

  const textDelta = (text: string) => ({ type: "text-delta", id: "t1", text });

  it("invokes an injected sink with the typed provider_stream_artifact event on drop", async () => {
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([
        part(startPart),
        part(textDelta("a")),
        part({ type: "error", error: ignorableArtifact() }),
        part(textDelta("b")),
        part(finishPart),
      ]),
    );

    const events: DiagnosticEvent[] = [];
    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }), (event) => events.push(event));
    await collect(port.streamText(baseRequest));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "provider_stream_artifact",
      signature: expect.any(String),
    });
  });

  it("default path (no sink injected) still emits the legacy console.warn string, once per unique signature", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([
        part(startPart),
        part(textDelta("a")),
        part({ type: "error", error: ignorableArtifact() }),
        part({ type: "error", error: ignorableArtifact() }),
        part(textDelta("b")),
        part(finishPart),
      ]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    await collect(port.streamText(baseRequest));

    expect(warnSpy).toHaveBeenCalledTimes(1); // deduped by signature
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toMatch(/^\[anycode\] dropping unparsable provider stream artifact: /);
  });

  it("stays silent on console.warn when a custom sink is injected", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([
        part(startPart),
        part(textDelta("a")),
        part({ type: "error", error: ignorableArtifact() }),
        part(finishPart),
      ]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }), () => {});
    await collect(port.streamText(baseRequest));

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("AiSdkModelPort — abort wins over retry", () => {
  it("exits instantly when the abort signal fires during the backoff wait, without waiting the full delay", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error)]));

    const controller = new AbortController();
    // Deliberately large so a passing test proves the abort short-circuits the wait
    // rather than the delay having simply elapsed on its own.
    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, baseDelayMs: 5_000, maxDelayMs: 5_000 }));
    const iterator = port
      .streamText({ ...baseRequest, abortSignal: controller.signal })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "stream_retry" });

    const pending = iterator.next(); // resumes past the yield, into the abortable delay
    const abortReason = new Error("stopped by caller");
    controller.abort(abortReason);

    const start = Date.now();
    await expect(pending).rejects.toBe(abortReason);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(mockStreamText).toHaveBeenCalledTimes(1); // second attempt never started
  });

  it("rejects via the already-aborted fast path when the signal aborts between the retry announcement and the backoff wait", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error)]));

    const controller = new AbortController();
    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, baseDelayMs: 5_000, maxDelayMs: 5_000 }));
    const iterator = port
      .streamText({ ...baseRequest, abortSignal: controller.signal })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    expect((await iterator.next()).value).toMatchObject({ type: "stream_retry" });

    // Abort AFTER the retry was announced but BEFORE resuming into the wait, so
    // abortableDelay sees an already-aborted signal at entry (its synchronous
    // fast path).
    const abortReason = new Error("already gone");
    controller.abort(abortReason);

    await expect(iterator.next()).rejects.toBe(abortReason);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("rejects with the abort reason and does NOT retry when aborted during the connect phase (guard, Fable §1 edge-case 2)", async () => {
    // Real shape: the synthetic `start` fires, then the network read hangs —
    // an in-flight connect that never produced content. The abort settles it.
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield startPart;
        await new Promise(() => {});
      })(),
    }));

    const controller = new AbortController();
    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, stallTimeoutMs: 0 }));
    const iterator = port
      .streamText({ ...baseRequest, abortSignal: controller.signal })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    const pending = iterator.next(); // blocks on the hanging network read

    // Abort with a reason that WOULD classify retryable (HTTP 529): only the
    // explicit abort guard — not the classifier — keeps this from retrying.
    // `start` did not close the gate, so without the guard this would retry.
    const abortReason = retryableError();
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });
});

function responsesConfig(retry?: Partial<AnthropicEndpointConfig["retry"]>): EndpointConfig {
  return { ...baseConfig(retry), transport: "openai-responses", baseUrl: "https://gw.example/v1", model: "gpt-oss" };
}
function rawPart(rawValue: Record<string, unknown>): FakeStep { return part({type:"raw",rawValue}); }
function reasoningTextDelta(item_id: string, delta: string): FakeStep { return rawPart({type:"response.reasoning_text.delta",item_id,content_index:0,delta}); }

describe("AiSdkModelPort — openai-responses reasoning_text recovery (#27)", () => {
  it("yields reasoning events for raw reasoning_text deltas and closes the synthesized block before finish", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart),reasoningTextDelta("rs_1","Let me "),reasoningTextDelta("rs_1","think."),part({type:"text-delta",id:"msg_1",text:"Hi"}),part(finishPart)]));
    const events = await collect(new AiSdkModelPort(responsesConfig()).streamText(baseRequest));
    expect(events.map(e=>e.type)).toEqual(["start","reasoning_start","reasoning_delta","reasoning_delta","text_delta","reasoning_end","finish"]);
    expect(events.filter(e=>e.type.startsWith("reasoning_"))).toEqual([{type:"reasoning_start",id:"rs_1:0"},{type:"reasoning_delta",id:"rs_1:0",text:"Let me "},{type:"reasoning_delta",id:"rs_1:0",text:"think."},{type:"reasoning_end",id:"rs_1:0"}]);
  });
  it("ignores raw reasoning_text frames on anthropic-messages", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart),reasoningTextDelta("rs_1","x"),part(finishPart)]));
    expect((await collect(new AiSdkModelPort(baseConfig()).streamText(baseRequest))).filter(e=>e.type.startsWith("reasoning_"))).toEqual([]);
  });
  it("retries recovered reasoning even with the legacy replay cap disabled", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), reasoningTextDelta("rs_1", "old"), throwsWith(retryableError())]))
      .mockImplementationOnce(() => fakeResult([part(startPart), reasoningTextDelta("rs_1", "new"), part(finishPart)]));
    const events = await collect(new AiSdkModelPort(responsesConfig({ maxRetries: 3, midStreamRetries: 0 })).streamText(baseRequest));
    expect(events.filter(e => e.type === "stream_retry")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("finish");
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });
  it("hands no activity hook to the model factory on other transports or with the watchdog off", async () => {
    for (const config of [baseConfig(), responsesConfig({stallTimeoutMs:0}), {...baseConfig(),transport:"openai-chat-completions" as const}, responsesConfig({stallTimeoutMs:50})]) {
      mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)])); await collect(new AiSdkModelPort(config).streamText(baseRequest));
    }
    expect(mockCreateLanguageModel.mock.calls.slice(0,3).map(c=>c.length)).toEqual([1,1,1]); expect(mockCreateLanguageModel.mock.calls[3]!.length).toBe(2); expect(typeof mockCreateLanguageModel.mock.calls[3]![1]).toBe("function");
  });
});

describe("AiSdkModelPort — stall watchdog (design slice-2.3-cut.md, tail 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Yields two text_delta parts then hangs forever (never yields/resolves again). */
  function hangAfterTwoDeltas() {
    return {
      fullStream: (async function* () {
        yield { type: "reasoning-delta", id: "t1", text: "a" };
        yield { type: "reasoning-delta", id: "t1", text: "b" };
        await new Promise(() => {});
      })(),
    };
  }

  /** Yields `start` then hangs forever. */
  function hangAfterStart() {
    return {
      fullStream: (async function* () {
        yield startPart;
        await new Promise(() => {});
      })(),
    };
  }

  it("retries the whole step with a stall reason when the stream stops emitting events", async () => {
    mockStreamText
      .mockImplementationOnce(hangAfterTwoDeltas)
      .mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, stallTimeoutMs: 50 }));
    const iterator = port.streamText(baseRequest)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: "reasoning_delta", text: "a" });
    expect((await iterator.next()).value).toMatchObject({ type: "reasoning_delta", text: "b" });

    const stallPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(50);
    const retryEvent = await stallPromise;
    expect(retryEvent.value).toMatchObject({
      type: "stream_retry",
      attempt: 1,
      // Taskana 4705 review: replays count inside maxRetries, so the announced
      // total stays maxRetries even after a mid-stream stall replay.
      maxAttempts: 3,
      // W7b-FIX #3: the stall timeout is LOCALLY generated (never provider
      // text), so it gets its own fixed whitelist reason instead of being
      // routed through classifyProviderFailure's generic "unknown" ->
      // "request failed" bucket, which threw away the actionable diagnostic
      // for no safety benefit. The raw "stream stalled…" text (with the
      // interpolated timeout) still rides the final thrown error on
      // retry-exhaustion (asserted below) for the host log — only the
      // wire-crossing `reason` is the fixed, non-interpolated whitelist string.
      reason: "stream_stalled",
    });

    const afterRetry = iterator.next();
    await vi.advanceTimersByTimeAsync(10); // backoff wait (baseDelayMs/maxDelayMs: 1ms)
    expect((await afterRetry).value).toEqual({ type: "start" });
    expect((await iterator.next()).value).toMatchObject({ type: "finish" });
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });

  it("does not replay a stalled stream after text", async () => {
    mockStreamText.mockImplementationOnce(() => ({ fullStream: (async function* () { yield { type: "text-delta", id: "t", text: "visible" }; await new Promise(() => {}); })() }));
    const iterator = new AiSdkModelPort(baseConfig({ maxRetries: 8, stallTimeoutMs: 20 })).streamText(baseRequest)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "text_delta" });
    const pending = expect(iterator.next()).rejects.toThrow(/stream stalled/);
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once maxRetries is exhausted for repeated stalls and throws", async () => {
    mockStreamText.mockImplementationOnce(hangAfterStart).mockImplementationOnce(hangAfterStart);

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 1, stallTimeoutMs: 20 }));
    const iterator = port.streamText(baseRequest)[Symbol.asyncIterator]();

    // Attempt 0: yields "start", then stalls -> retryable (attempt 0 < maxRetries 1).
    expect((await iterator.next()).value).toEqual({ type: "start" });
    const stallPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    expect((await stallPromise).value).toMatchObject({ type: "stream_retry", attempt: 1, maxAttempts: 1 });

    // Attempt 1: after backoff, yields "start" again, then stalls -> exhausted -> throws.
    const startPromise2 = iterator.next();
    await vi.advanceTimersByTimeAsync(10);
    expect((await startPromise2).value).toEqual({ type: "start" });

    const finalPromise = iterator.next();
    // Registered synchronously (before the timer fires) so the rejection is
    // never observably "unhandled" for even a microtask under fake timers.
    const assertion = expect(finalPromise).rejects.toThrow(/stream stalled/);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });

  it("keeps an openai-responses attempt alive while response bytes arrive, then stalls once they stop (#27)", async () => {
    mockStreamText.mockImplementationOnce(hangAfterStart);
    const iterator = new AiSdkModelPort(responsesConfig({maxRetries:0,stallTimeoutMs:50})).streamText(baseRequest)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({type:"start"});
    const onActivity = mockCreateLanguageModel.mock.calls[0]![1] as () => void;
    let settled = false; const pending = iterator.next().finally(() => { settled = true; }); pending.catch(() => {});
    for (let i=0;i<3;i++) { await vi.advanceTimersByTimeAsync(30); onActivity(); }
    await vi.advanceTimersByTimeAsync(30); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(25); await expect(pending).rejects.toThrow(/stream stalled: no events for 50ms/);
  });

  it("does not arm the stall watchdog when stallTimeoutMs is 0", async () => {
    mockStreamText.mockImplementationOnce(hangAfterStart);

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, stallTimeoutMs: 0 }));
    const iterator = port.streamText(baseRequest)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    iterator.next(); // hangs; a watchdog timer would be scheduled synchronously if armed
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately with the abort reason if the caller aborts during a stall wait, without retrying", async () => {
    mockStreamText.mockImplementationOnce(hangAfterStart);

    const controller = new AbortController();
    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, stallTimeoutMs: 5_000 }));
    const iterator = port
      .streamText({ ...baseRequest, abortSignal: controller.signal })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    const pending = iterator.next();
    const abortReason = new Error("stopped by caller");
    controller.abort(abortReason);
    await expect(pending).rejects.toBe(abortReason);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });
});

describe("reasoningRequestOptions — transport branching (TASK.43 §0.7)", () => {
  it("keeps the GLM bytes byte-identical when the anthropic transport is passed explicitly", () => {
    // Negative regression against the transport branch displacing the providerName
    // branch: a GLM endpoint speaks the Anthropic wire protocol, so an explicit
    // `anthropic-messages` must reproduce the pre-transport bytes exactly — the
    // same numbers the pins above lock for the two-argument call.
    expect(
      reasoningRequestOptions(
        { ...baseRequest, maxOutputTokens: 512, reasoningEffort: "high" },
        "Z.AI (GLM)",
        "anthropic-messages",
      ),
    ).toEqual({
      maxOutputTokens: 512,
      providerOptions: { anthropic: { effort: "high", thinking: { type: "enabled", budgetTokens: 16_000 } } },
    });
    expect(
      reasoningRequestOptions(
        { ...baseRequest, maxOutputTokens: 131_072, reasoningEffort: "max" },
        "Z.AI (GLM)",
        "anthropic-messages",
      ),
    ).toEqual({
      maxOutputTokens: 99_072,
      providerOptions: { anthropic: { effort: "max", thinking: { type: "enabled", budgetTokens: 32_000 } } },
    });
  });

  it("treats an absent transport as anthropic-messages (legacy call sites)", () => {
    const request: ModelRequest = { ...baseRequest, maxOutputTokens: 512, reasoningEffort: "high" };
    expect(reasoningRequestOptions(request, "Anthropic")).toEqual(
      reasoningRequestOptions(request, "Anthropic", "anthropic-messages"),
    );
    expect(reasoningRequestOptions(request, "Z.AI (GLM)")).toEqual(
      reasoningRequestOptions(request, "Z.AI (GLM)", "anthropic-messages"),
    );
  });

  it("always carries store:false on openai-responses, even with no reasoning requested", () => {
    expect(reasoningRequestOptions({ ...baseRequest }, "OpenAI", "openai-responses")).toEqual({
      providerOptions: { openai: { store: false } },
    });
    expect(
      reasoningRequestOptions({ ...baseRequest, reasoningEffort: "off", maxOutputTokens: 4096 }, undefined, "openai-responses"),
    ).toEqual({ maxOutputTokens: 4096, providerOptions: { openai: { store: false } } });
  });

  it.each(["low", "medium", "high", "max"] as const)(
    "passes openai-responses effort %s through verbatim, alongside store:false",
    (effort) => {
      // forceReasoning rides along because @ai-sdk/openai decides whether to
      // emit reasoning.effort from an id-prefix heuristic (o1/o3/o4-mini/gpt-5*)
      // — the GPT-6 ids the catalog now ships fall outside it, and without the
      // flag the SDK drops the effort with an "unsupported" warning.
      expect(
        reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 4096, reasoningEffort: effort }, "OpenAI", "openai-responses"),
      ).toEqual({
        maxOutputTokens: 4096,
        providerOptions: { openai: { store: false, reasoningEffort: effort } },
      });
    },
  );

  it("is byte-dormant on openai-chat-completions when effort is off, regardless of providerName", () => {
    expect(
      reasoningRequestOptions({ ...baseRequest }, "Z.AI (GLM)", "openai-chat-completions"),
    ).toEqual({});
    expect(
      reasoningRequestOptions(
        { ...baseRequest, maxOutputTokens: 8192, reasoningEffort: "off" },
        undefined,
        "openai-chat-completions",
      ),
    ).toEqual({ maxOutputTokens: 8192 });
  });

  it.each(["low", "medium", "high"] as const)(
    "maps openai-chat-completions effort %s straight through as reasoning_effort, with no token-budget arithmetic",
    (effort) => {
      expect(
        reasoningRequestOptions({ ...baseRequest, maxOutputTokens: 4096, reasoningEffort: effort }, "custom", "openai-chat-completions"),
      ).toEqual({
        maxOutputTokens: 4096,
        providerOptions: { openaiCompatible: { reasoningEffort: effort } },
      });
    },
  );

  it("passes openai-chat-completions effort max through unchanged", () => {
    expect(
      reasoningRequestOptions({ ...baseRequest, reasoningEffort: "max" }, "custom", "openai-chat-completions"),
    ).toEqual({
      providerOptions: { openaiCompatible: { reasoningEffort: "max" } },
    });
  });

  it("omits maxOutputTokens on openai-chat-completions when the request didn't set one", () => {
    const result = reasoningRequestOptions(
      { ...baseRequest, reasoningEffort: "high" },
      undefined,
      "openai-chat-completions",
    );
    expect(result).toEqual({ providerOptions: { openaiCompatible: { reasoningEffort: "high" } } });
    expect("maxOutputTokens" in result).toBe(false);
  });
});

describe("AiSdkModelPort — outgoing request bytes per transport (TASK.43 §0.7)", () => {
  it("sends the pre-transport GLM request bytes for a GLM providerName on the anthropic transport", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    const port = new AiSdkModelPort({
      ...baseConfig(),
      transport: "anthropic-messages",
      providerName: "Z.AI (GLM)",
      model: "glm-5.2",
    });

    await collect(port.streamText({ ...baseRequest, reasoningEffort: "high", maxOutputTokens: 131_072 }));

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        maxOutputTokens: 115_072,
        providerOptions: { anthropic: { effort: "high", thinking: { type: "enabled", budgetTokens: 16_000 } } },
        messages: [{ role: "user", content: "hi" }],
      }),
    );
  });

  it("sends providerOptions.openaiCompatible reasoning_effort on the openai-chat-completions transport", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    const port = new AiSdkModelPort({
      ...baseConfig(),
      transport: "openai-chat-completions",
      baseUrl: "https://gw.example/v1",
      model: "gpt-oss",
    });

    await collect(port.streamText({ ...baseRequest, reasoningEffort: "medium", maxOutputTokens: 4096 }));

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        maxOutputTokens: 4096,
        providerOptions: { openaiCompatible: { reasoningEffort: "medium" } },
        messages: [{ role: "user", content: "hi" }],
      }),
    );
  });
});
describe("AiSdkModelPort — response-model provenance and identity readback", () => {
  function rawMessageStart(message: Record<string, unknown>): FakeStep {
    return part({ type: "raw", rawValue: { type: "message_start", message } });
  }

  it("reads back the id the port was constructed for", () => {
    expect(new AiSdkModelPort(baseConfig()).modelId).toBe("claude-test");
    expect(new AiSdkModelPort({ ...baseConfig(), model: "glm-5.3-flash" }).modelId).toBe("glm-5.3-flash");
  });

  it("has no response-model claim before anything has streamed", () => {
    expect(new AiSdkModelPort(baseConfig()).lastResponseModel).toBeUndefined();
  });

  it("captures the provider's claim from the raw message_start chunk", async () => {
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), rawMessageStart({ id: "msg_1", model: "glm-5.3" }), part(finishPart)]),
    );
    const port = new AiSdkModelPort({ ...baseConfig(), model: "glm-5.3-flash" });
    const events = await collect(port.streamText(baseRequest));

    expect(port.lastResponseModel).toBe("glm-5.3");
    // The claim differs from the constructed identity: that difference is the
    // only signal the product has that the provider answered for another model.
    expect(port.modelId).toBe("glm-5.3-flash");
    // Raw parts have no core-vocabulary counterpart and never reach the caller.
    expect(events).toEqual([
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
  });

  it("keeps the last claim observed across a retried step (last write wins)", async () => {
    mockStreamText
      .mockImplementationOnce(() =>
        fakeResult([part(startPart), rawMessageStart({ model: "model-A" }), throwsWith(retryableError())]),
      )
      .mockImplementationOnce(() =>
        fakeResult([part(startPart), rawMessageStart({ model: "model-B" }), part(finishPart)]),
      );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    const events = await collect(port.streamText(baseRequest));

    expect(events.some((e) => e.type === "stream_retry")).toBe(true);
    // The abandoned attempt's claim is superseded by the claim belonging to the
    // response the caller actually received.
    expect(port.lastResponseModel).toBe("model-B");
  });

  it("stays undefined when the stream carries no raw model claim", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));
    const port = new AiSdkModelPort(baseConfig());
    await collect(port.streamText(baseRequest));

    // Absence is preserved as absence: never backfilled with the requested id.
    expect(port.lastResponseModel).toBeUndefined();
  });

  it("ignores a raw message_start that carries no model, and raw chunks of other types", async () => {
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([
        part(startPart),
        rawMessageStart({ id: "msg_1", usage: { input_tokens: 3 } }),
        part({ type: "raw", rawValue: { type: "content_block_delta", model: "not-a-claim" } }),
        part(finishPart),
      ]),
    );
    const port = new AiSdkModelPort({ ...baseConfig(), model: "glm-5.3-flash" });
    await collect(port.streamText(baseRequest));

    expect(port.lastResponseModel).toBeUndefined();
  });

  it("asks the SDK for raw chunks on the anthropic-messages transport", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    await collect(new AiSdkModelPort(baseConfig()).streamText(baseRequest));

    expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({ includeRawChunks: true }));
  });

  it("does not ask for raw chunks on the openai-chat-completions transport", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    await collect(new AiSdkModelPort({ ...baseConfig(), transport: "openai-chat-completions" }).streamText(baseRequest));
    expect(mockStreamText.mock.calls[0]![0]).not.toHaveProperty("includeRawChunks");
  });
  it("asks the SDK for raw chunks on the openai-responses transport (reasoning_text recovery, #27)", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    await collect(new AiSdkModelPort(responsesConfig()).streamText(baseRequest));
    expect(mockStreamText.mock.calls[0]![0]).toHaveProperty("includeRawChunks", true);
  });
  it("keeps lastResponseModel undefined on openai-responses although raw chunks now flow", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), rawPart({type:"response.created", response:{model:"gpt-claimed"}}), part(finishPart)]));
    const port = new AiSdkModelPort(responsesConfig());
    await collect(port.streamText(baseRequest));
    expect(port.lastResponseModel).toBeUndefined();
  });
});

describe("AiSdkModelPort — TASK.168 include_usage probe (openai-chat-completions)", () => {
  function chatConfig(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
    return {
      transport: "openai-chat-completions",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "test-key",
      model: "gpt-oss",
      includeUsage: true,
      retry: { baseDelayMs: 1, maxDelayMs: 1, maxRetries: 3 },
      ...overrides,
    };
  }

  /** A strict server's rejection of the unrecognized `stream_options` field — always a plain pre-content 400. */
  function streamOptions400(message = "Unrecognized request argument supplied: stream_options"): APICallError {
    return new APICallError({
      message,
      url: "https://gw.example.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
  }

  it("(a) retries once without include_usage on a pre-content 400, warns exactly once, and a later request on the same port does not re-probe", async () => {
    const firstError = streamOptions400();
    mockStreamText
      .mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error: firstError })]))
      .mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));

    const diagnostics: DiagnosticEvent[] = [];
    const port = new AiSdkModelPort(chatConfig(), (event) => diagnostics.push(event));
    const events = await collect(port.streamText(baseRequest));

    // No stream_retry wire event for the probe: it is a silent, budget-exempt swap.
    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    expect(events).toEqual([
      { type: "start" },
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockCreateLanguageModel).toHaveBeenNthCalledWith(1, expect.objectContaining({ includeUsage: true }));
    expect(mockCreateLanguageModel).toHaveBeenNthCalledWith(2, expect.objectContaining({ includeUsage: false }));
    expect(diagnostics).toEqual([
      { kind: "include_usage_disabled", baseUrl: "https://gw.example.com/v1", model: "gpt-oss" },
    ]);

    // A second, independent request on the SAME port instance: the endpoint
    // is already confirmed disabled, so it must build with the flag off from
    // attempt zero — no error, no second mockStreamText call, no new warning.
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));
    const events2 = await collect(port.streamText(baseRequest));

    expect(events2).toEqual([
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
    expect(mockStreamText).toHaveBeenCalledTimes(3); // 2 above + this 1 — no re-probe attempt
    expect(mockCreateLanguageModel).toHaveBeenNthCalledWith(3, expect.objectContaining({ includeUsage: false }));
    expect(diagnostics).toHaveLength(1); // still exactly once
  });

  it("(a-thrown) also retries a pre-content 400 that arrives as a THROWN exception rather than a stream error part", async () => {
    const error = streamOptions400();
    mockStreamText
      .mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(error)]))
      .mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));

    const diagnostics: DiagnosticEvent[] = [];
    const port = new AiSdkModelPort(chatConfig(), (event) => diagnostics.push(event));
    const events = await collect(port.streamText(baseRequest));

    expect(events).toEqual([
      { type: "start" },
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockCreateLanguageModel).toHaveBeenNthCalledWith(2, expect.objectContaining({ includeUsage: false }));
    expect(diagnostics).toHaveLength(1);
  });

  it("(b) propagates the ORIGINAL 400 unchanged when the retry also 400s — the flag was not the cause", async () => {
    const firstError = streamOptions400("stream_options rejected — attempt 1");
    const secondError = streamOptions400("stream_options rejected — attempt 2");
    mockStreamText
      .mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error: firstError })]))
      .mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error: secondError })]));

    const diagnostics: DiagnosticEvent[] = [];
    const port = new AiSdkModelPort(chatConfig(), (event) => diagnostics.push(event));
    const events = await collect(port.streamText(baseRequest));

    // The FIRST error, byte-identical — never the retry's own (second) error.
    expect(events).toEqual([{ type: "start" }, { type: "start" }, { type: "error", error: firstError }]);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockCreateLanguageModel).toHaveBeenNthCalledWith(2, expect.objectContaining({ includeUsage: false }));
    expect(diagnostics).toEqual([]); // never confirmed as the cause — no warning

    // The optimistic disable was rolled back: a LATER, independent request on
    // the same port probes again from includeUsage: true.
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));
    await collect(port.streamText(baseRequest));
    expect(mockCreateLanguageModel).toHaveBeenNthCalledWith(3, expect.objectContaining({ includeUsage: true }));
  });

  it("(b-thrown) propagates the ORIGINAL thrown 400 unchanged when the retry also throws a 400", async () => {
    const firstError = streamOptions400("attempt 1");
    const secondError = streamOptions400("attempt 2");
    mockStreamText
      .mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(firstError)]))
      .mockImplementationOnce(() => fakeResult([part(startPart), throwsWith(secondError)]));

    const port = new AiSdkModelPort(chatConfig());
    await expect(collect(port.streamText(baseRequest))).rejects.toBe(firstError);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });

  it("(c) does not engage the probe for a non-400 failure, even pre-content on chat-completions with the flag on", async () => {
    const error = new APICallError({
      message: "forbidden",
      url: "https://gw.example.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 403,
      isRetryable: false,
    });
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error })]));

    const diagnostics: DiagnosticEvent[] = [];
    const port = new AiSdkModelPort(chatConfig(), (event) => diagnostics.push(event));
    const events = await collect(port.streamText(baseRequest));

    expect(events).toEqual([{ type: "start" }, { type: "error", error }]);
    expect(mockStreamText).toHaveBeenCalledTimes(1); // no probe retry, no generic retry either
    expect(diagnostics).toEqual([]);
  });

  it("(d) ANYCODE_INCLUDE_USAGE=0 (includeUsage already false): a 400 propagates immediately, no probe attempted", async () => {
    const error = streamOptions400("some other 400, unrelated to stream_options");
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error })]));

    const diagnostics: DiagnosticEvent[] = [];
    const port = new AiSdkModelPort(chatConfig({ includeUsage: false }), (event) => diagnostics.push(event));
    const events = await collect(port.streamText(baseRequest));

    expect(events).toEqual([{ type: "start" }, { type: "error", error }]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(mockCreateLanguageModel).toHaveBeenCalledWith(expect.objectContaining({ includeUsage: false }));
    expect(diagnostics).toEqual([]);
  });

  it("confirms the probe and hands off to the NORMAL retry mechanism when the retry pass hits a DIFFERENT (retryable) failure instead of another 400", async () => {
    const first400 = streamOptions400();
    const overloaded = retryableError(); // 529, existing retryable-error fixture
    mockStreamText
      .mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error: first400 })]))
      .mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "error", error: overloaded })]))
      .mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));

    const diagnostics: DiagnosticEvent[] = [];
    const port = new AiSdkModelPort(chatConfig(), (event) => diagnostics.push(event));
    const events = await collect(port.streamText(baseRequest));

    // The probe is confirmed (warned once) even though the retry pass itself
    // then hit an UNRELATED failure, which goes through the ordinary
    // stream_retry/backoff mechanism exactly as it would without TASK.168.
    expect(diagnostics).toHaveLength(1);
    expect(events.filter((e) => e.type === "stream_retry")).toHaveLength(1);
    expect(events.find((e) => e.type === "finish")).toMatchObject({ type: "finish" });
    expect(mockStreamText).toHaveBeenCalledTimes(3);
  });
  it.each(["reasoning", "text"] as const)("reclassifies a probe failure after %s", async (kind) => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part({ type: "error", error: streamOptions400() })]))
      .mockImplementationOnce(() => fakeResult([part({ type: kind === "reasoning" ? "reasoning-delta" : "text-delta", id: "x", text: "output" }), part({ type: "error", error: retryableError() })]))
      .mockImplementationOnce(() => fakeResult([part(finishPart)]));
    const events = await collect(new AiSdkModelPort(chatConfig({ retry: { maxRetries: 3, midStreamRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } }), () => {}).streamText(baseRequest));
    expect(events.filter(e => e.type === "stream_retry")).toHaveLength(kind === "reasoning" ? 1 : 0);
    expect(events.at(-1)?.type).toBe(kind === "reasoning" ? "finish" : "error");
    expect(mockStreamText).toHaveBeenCalledTimes(kind === "reasoning" ? 3 : 2);
  });

});

it("TASK.134 makes only one attempt for a measured proxy-auth failure", async () => {
  const error = new TypeError("fetch failed", { cause: new Error("Proxy response (407) !== 200 when HTTP Tunneling") });
  mockStreamText.mockImplementation(() => fakeResult([part(startPart), throwsWith(error)]));
  const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
  await expect(collect(port.streamText(baseRequest))).rejects.toBe(error);
  expect(mockStreamText).toHaveBeenCalledTimes(1);
});

it("does not retry a DNS proxy refusal whose cause carries only the resolved IP", async () => {
  vi.stubEnv("NODE_USE_ENV_PROXY", "1");
  vi.stubEnv("HTTPS_PROXY", "http://user:secret-poison@proxy.invalid:9911");
  vi.stubEnv("https_proxy", "");
  vi.stubEnv("NO_PROXY", "localhost");
  vi.stubEnv("no_proxy", "localhost");
  try {
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED", address: "192.0.2.5", port: 9911 }) });
    mockStreamText.mockImplementation(() => fakeResult([part(startPart), throwsWith(error)]));
    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
    await expect(collect(port.streamText(baseRequest))).rejects.toMatchObject({ configurationCode: "proxy_unreachable" });
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllEnvs(); }
});

describe("AiSdkModelPort — networkRetryBudgetMs (transient network outage)", () => {
  function connectTimeout(): TypeError {
    return Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
  }
  function statusError(statusCode: number): APICallError {
    return new APICallError({
      message: `http ${statusCode}`,
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode,
      isRetryable: statusCode === 429,
    });
  }
  // 10 s fixed backoff (jitter pinned to its ceiling).
  const slow = { baseDelayMs: 10_000, maxDelayMs: 10_000 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function failThenSucceed(failures: number, makeError: () => unknown): void {
    let calls = 0;
    mockStreamText.mockImplementation(() => {
      calls += 1;
      return calls <= failures
        ? fakeResult([part(startPart), throwsWith(makeError())])
        : fakeResult([part(startPart), part(finishPart)]);
    });
  }

  async function settle(promise: Promise<unknown>, ms: number): Promise<{ ok: boolean; value: unknown }> {
    const outcome = promise.then(
      (value) => ({ ok: true, value }),
      (value) => ({ ok: false, value }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return outcome;
  }

  it("with a 180 s budget survives ~90 s of connect timeouts and then succeeds", async () => {
    failThenSucceed(9, connectTimeout);
    const port = new AiSdkModelPort(baseConfig({ ...slow, networkRetryBudgetMs: 180_000 }));
    const result = await settle(collect(port.streamText(baseRequest)), 200_000);
    expect(result.ok).toBe(true);
    const events = result.value as Array<{ type: string }>;
    expect(events.filter((e) => e.type === "stream_retry")).toHaveLength(9);
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("fails after 3 retries when maxRetries is an explicit 3 and the budget is off (Taskana 4705: default is now 8 + budget)", async () => {
    failThenSucceed(9, connectTimeout);
    const port = new AiSdkModelPort(baseConfig({ ...slow, maxRetries: 3, networkRetryBudgetMs: 0 }));
    const result = await settle(collect(port.streamText(baseRequest)), 200_000);
    expect(result.ok).toBe(false);
    expect(mockStreamText).toHaveBeenCalledTimes(4);
  });

  it("gives up once the budget is spent", async () => {
    failThenSucceed(1_000, connectTimeout);
    const port = new AiSdkModelPort(baseConfig({ ...slow, networkRetryBudgetMs: 60_000 }));
    const result = await settle(collect(port.streamText(baseRequest)), 300_000);
    expect(result.ok).toBe(false);
    expect(mockStreamText.mock.calls.length).toBeLessThan(10);
  });

  it.each([429, 401, 403, 500])(`never extends an HTTP %i beyond maxRetries`, async (status) => {
    failThenSucceed(9, () => statusError(status));
    // Taskana 4705: maxRetries pinned to 3 (the new default is 8) so the
    // <= 4 assertion keeps its original meaning: status errors never ride
    // the network budget.
    const port = new AiSdkModelPort(baseConfig({ ...slow, maxRetries: 3, networkRetryBudgetMs: 180_000 }));
    const result = await settle(collect(port.streamText(baseRequest)), 200_000);
    expect(result.ok).toBe(false);
    expect(mockStreamText.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("maxRetries 0 plus a budget does not retry", async () => {
    failThenSucceed(9, connectTimeout);
    const port = new AiSdkModelPort(baseConfig({ ...slow, maxRetries: 0, networkRetryBudgetMs: 180_000 }));
    const result = await settle(collect(port.streamText(baseRequest)), 200_000);
    expect(result.ok).toBe(false);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("an abort during a budget wait stops at once", async () => {
    failThenSucceed(9, connectTimeout);
    const controller = new AbortController();
    const port = new AiSdkModelPort(baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 180_000 }));
    const iterator = port.streamText({ ...baseRequest, abortSignal: controller.signal })[Symbol.asyncIterator]();
    const step = async () => {
      const next = iterator.next();
      await vi.advanceTimersByTimeAsync(10_000);
      return next;
    };
    await step(); // start
    await step(); // retry 1 (count-bounded), then waits
    await step(); // start of 2nd attempt
    const retry = await iterator.next(); // budget retry announced (past maxRetries)
    expect(retry.value).toMatchObject({ type: "stream_retry", attempt: 2 });
    const pending = iterator.next();
    const reason = new Error("stop");
    const caught = pending.catch((e) => e);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(await caught).toBe(reason);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });
});

// Taskana 4772: pre-content transient network failures park the turn in a
// "waiting for network" state (probe ladder 5 s -> 60 s, hint-woken) instead of
// failing it, bounded by networkWaitMaxMs on a monotonic clock.
describe("AiSdkModelPort — networkWaitMaxMs (Taskana 4772: wait for the network)", () => {
  function connectTimeout(): TypeError {
    return Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
  }
  function statusError(statusCode: number): APICallError {
    return new APICallError({
      message: `http ${statusCode}`,
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode,
      isRetryable: statusCode === 429,
    });
  }
  const slow = { baseDelayMs: 10_000, maxDelayMs: 10_000 };

  /** Scriptable waiter: `online` answers probes; hints fan out to every listener. */
  function makeWaiter(initiallyOnline: boolean, monotonic: () => number = () => Date.now()) {
    const listeners = new Set<() => void>();
    const waiter = {
      online: initiallyOnline,
      probes: 0,
      probe: vi.fn(async () => {
        waiter.probes += 1;
        return waiter.online;
      }),
      onHint: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      monotonicNow: monotonic,
      hint(): void {
        for (const listener of [...listeners]) listener();
      },
      listenerCount: () => listeners.size,
    };
    return waiter;
  }

  /**
   * Forces the first `answers.length` probes (by call order) to the scripted
   * verdicts; later probes fall back to `waiter.online`. The gate probe and
   * the wait's own t=0 probe run inside one microtask cascade, so a test
   * cannot flip `online` between them — it must script by call index.
   */
  function scriptProbes(waiter: ReturnType<typeof makeWaiter>, answers: boolean[]): void {
    let n = 0;
    waiter.probe.mockImplementation(async () => {
      const answer = n < answers.length ? answers[n]! : waiter.online;
      n += 1;
      waiter.probes += 1;
      return answer;
    });
  }

  function failThenSucceed(failures: number, makeError: () => unknown): void {
    let calls = 0;
    mockStreamText.mockImplementation(() => {
      calls += 1;
      return calls <= failures
        ? fakeResult([part(startPart), throwsWith(makeError())])
        : fakeResult([part(startPart), part(finishPart)]);
    });
  }

  async function settle(promise: Promise<unknown>, ms: number): Promise<{ ok: boolean; value: unknown }> {
    const outcome = promise.then(
      (value) => ({ ok: true, value }),
      (value) => ({ ok: false, value }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return outcome;
  }

  /** Type of the run's last event ("" before any event lands). */
  function typesEnd(run: { events: Array<{ type: string }> }): string {
    return run.events.at(-1)?.type ?? "";
  }

  /** Pumps an event stream in the background so the test can drive fake time between events. */
  function pumpEvents(iterable: AsyncIterable<unknown>) {
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const state: { done: boolean; error?: unknown } = { done: false };
    const pump = (async () => {
      try {
        for await (const event of iterable) events.push(event as { type: string });
      } catch (error) {
        state.error = error;
      }
      state.done = true;
    })();
    return { events, state, pump };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("transient failure + offline probe ⇒ waiting_for_network instead of failing; rejects only at the deadline", async () => {
    const original = connectTimeout();
    mockStreamText.mockImplementation(() => fakeResult([part(startPart), throwsWith(original)]));
    const waiter = makeWaiter(false);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 60_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText(baseRequest));

    await vi.advanceTimersByTimeAsync(59_000);
    expect(run.state.done).toBe(false);
    expect(run.events.filter((e) => e.type === "waiting_for_network")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.state.done).toBe(true);
    expect((run.state.error as Error).message).toBe("fetch failed");
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(waiter.probes).toBeGreaterThan(1);
    await run.pump;
  });

  it("waiting exits on probe success and replays the same step once", async () => {
    failThenSucceed(1, connectTimeout);
    const waiter = makeWaiter(false);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 60_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText(baseRequest));
    setTimeout(() => {
      waiter.online = true;
    }, 10_000);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(run.state.done).toBe(true);
    expect(run.state.error).toBeUndefined();
    const types = run.events.map((e) => e.type);
    expect(types.indexOf("waiting_for_network")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("waiting_for_network")).toBeLessThan(types.indexOf("stream_retry"));
    expect(run.events.find((e) => e.type === "stream_retry")).toMatchObject({ attempt: 1, maxAttempts: 1, delayMs: 0, waitedMs: 15_000 });
    expect(types.at(-1)).toBe("finish");
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    await run.pump;
  });

  it("a hint fires an immediate probe without waiting out the 5 s tick", async () => {
    failThenSucceed(1, connectTimeout);
    const waiter = makeWaiter(false);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 60_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText(baseRequest));

    await vi.advanceTimersByTimeAsync(0);
    expect(run.events.map((e) => e.type)).toContain("waiting_for_network");
    waiter.online = true;
    waiter.hint();
    await vi.advanceTimersByTimeAsync(0);

    expect(run.events.map((e) => e.type)).toContain("stream_retry");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    await run.pump;
    expect(waiter.listenerCount()).toBe(0);
  });

  // Review F4: the first probe fires at t=0, before the first 5 s tick — with
  // the network already back the moment the wait starts, recovery must not
  // sit out an arbitrary tick to notice.
  it("probes at once on entering the wait: an already-back network recovers without a tick", async () => {
    failThenSucceed(1, connectTimeout);
    const waiter = makeWaiter(false);
    // Probe #1 is the GATE probe (attempt 0 < maxRetries): offline, so the
    // wait starts. Probe #2 is the wait's own t=0 probe: online — recovered.
    scriptProbes(waiter, [false, true]);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 60_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText(baseRequest));

    // Zero time advanced: the gate probe parked the turn and the wait's own
    // t=0 probe recovered it — no 5 s tick was ever waited out.
    await vi.advanceTimersByTimeAsync(0);
    expect(run.events.map((e) => e.type)).toContain("waiting_for_network");
    const retry = run.events.find((e) => e.type === "stream_retry");
    expect(retry).toMatchObject({ delayMs: 0 });
    expect(retry).not.toHaveProperty("waitedMs", 5_000);
    await run.pump;
    expect(typesEnd(run)).toBe("finish");
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(waiter.probes).toBe(2);
  });

  // Review F8(a): the `attempt < policy.maxRetries` short-circuit on the gate
  // probe — a transient failure with the count budget exhausted must SKIP the
  // gate probe, go straight into waiting_for_network, and replay via the
  // wait's own first probe (which passes).
  it("count budget exhausted skips the gate probe and waits; the first wait probe recovers (delayMs 0, waitedMs set)", async () => {
    // call 1: transient failure (episode 1); call 2: transient failure again
    // (episode 2, count budget spent); call 3: success.
    failThenSucceed(2, connectTimeout);
    const waiter = makeWaiter(false);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 60_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText(baseRequest));

    // Park: the gate probe (attempt 0 < maxRetries) answers offline and the
    // wait starts; episode 1's own t=0 probe also answers offline.
    await vi.advanceTimersByTimeAsync(0);
    expect(waiter.probes).toBe(2); // gate probe + the wait's t=0 probe
    expect(run.events.map((e) => e.type)).toContain("waiting_for_network");
    expect(run.state.done).toBe(false);

    // Network returns: episode 1 recovers on the first tick probe (~5 s),
    // the replay (call 2) fails transiently with attempt == maxRetries — the
    // gate probe is SKIPPED, so the ONLY probe that fires for episode 2 is
    // its own t=0 probe. Both episodes resolve inside this one cascade.
    waiter.online = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.events.filter((e) => e.type === "stream_retry")).toHaveLength(2);
    expect(mockStreamText).toHaveBeenCalledTimes(3);
    // Park probes: gate(1) + episode-1 t=0(1) + episode-1 first tick(1) +
    // episode-2 t=0(1) = 4 — a gate probe for episode 2 would have made it 5.
    expect(waiter.probes).toBe(4);
    expect(run.events.filter((e) => e.type === "waiting_for_network")).toHaveLength(2);

    const retries = run.events.filter((e) => e.type === "stream_retry");
    expect(retries[1]).toMatchObject({ attempt: 2, maxAttempts: 1, delayMs: 0 });
    expect(typeof (retries[1] as { waitedMs?: number }).waitedMs).toBe("number");
    await run.pump;
    expect(typesEnd(run)).toBe("finish");
  });

  // Review F8(b): TWO waiting episodes in one step — the second episode's
  // deadline must subtract episode 1 through networkWaitSpentMs.
  it("a second waiting episode's deadline subtracts the first episode (networkWaitSpentMs accumulation)", async () => {
    // call 1: transient failure (episode 1); call 2: transient failure again
    // (episode 2, count budget spent — no gate probe); call 3 never runs.
    failThenSucceed(2, connectTimeout);
    const waiter = makeWaiter(false);
    // probe #1: gate (offline — parks episode 1).
    // probe #2: episode-1 t=0 (offline — stays parked).
    // probe #3: episode-1 first tick (ONLINE at ~5 s — episode 1 recovers,
    //   waitedMs ≈ 5 s lands in networkWaitSpentMs).
    // probe #4: episode-2 t=0 (offline — parks episode 2 for good; a gate
    //   probe would have consumed this slot and answered online differently).
    scriptProbes(waiter, [false, false, true, false]);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 40_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText(baseRequest));

    // Drive past the first recovery: episode 1 recovered at ~5 s, the replay
    // failed transiently, episode 2 parked offline.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.events.filter((e) => e.type === "waiting_for_network")).toHaveLength(2);
    expect(run.events.filter((e) => e.type === "stream_retry")).toHaveLength(1);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(run.state.done).toBe(false);

    // Episode 1 spent ~5 s of the 40 s bound; the second episode must exhaust
    // the REMAINING ~35 s, not a fresh 40 s. At 25 s more (~30 s total) the
    // bounded run is still parked...
    await vi.advanceTimersByTimeAsync(25_000);
    expect(run.state.done).toBe(false);
    // ...and the next ticks (up to +45 s, past even a full fresh episode's
    // 40 s) see the cumulative bound crossed: the turn rejects with the
    // ORIGINAL error. The rejection itself is the pin — the timer ladder
    // never goes silent before it fires.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(run.state.done).toBe(true);
    expect((run.state.error as Error).message).toBe("fetch failed");
    expect(run.events.filter((e) => e.type === "waiting_for_network")).toHaveLength(2);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    await run.pump;
  });

  it("an abort during waiting rejects at once with the abort reason and stops probing", async () => {
    mockStreamText.mockImplementation(() => fakeResult([part(startPart), throwsWith(connectTimeout())]));
    const waiter = makeWaiter(false);
    const controller = new AbortController();
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 600_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText({ ...baseRequest, abortSignal: controller.signal }));

    await vi.advanceTimersByTimeAsync(0);
    const probesBefore = waiter.probes;
    const reason = new Error("stop");
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(run.state.done).toBe(true);
    expect(run.state.error).toBe(reason);
    expect(waiter.probes).toBe(probesBefore);
    expect(waiter.listenerCount()).toBe(0);
    await run.pump;
  });

  it("the deadline is measured on the monotonic clock, so wall time spent asleep does not count", async () => {
    mockStreamText.mockImplementation(() => fakeResult([part(startPart), throwsWith(connectTimeout())]));
    let monotonic = 0;
    const waiter = makeWaiter(false, () => monotonic);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 1_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText(baseRequest));

    // Wall clock runs 5 s while the monotonic clock is frozen (system asleep).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.state.done).toBe(false);
    // Awake time reaches the bound: the next wake-up ends the wait.
    monotonic = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.state.done).toBe(true);
    expect((run.state.error as Error).message).toBe("fetch failed");
    await run.pump;
  });

  it("a probe that rejects counts as offline (never throws into the turn)", async () => {
    mockStreamText.mockImplementation(() => fakeResult([part(startPart), throwsWith(connectTimeout())]));
    const waiter = makeWaiter(false);
    waiter.probe.mockRejectedValue(new Error("probe exploded"));
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, networkRetryBudgetMs: 0, networkWaitMaxMs: 10_000 }), networkWaiter: waiter });
    const run = pumpEvents(port.streamText(baseRequest));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.events.map((e) => e.type)).toContain("waiting_for_network");
    expect(run.state.done).toBe(true);
    expect((run.state.error as Error).message).toBe("fetch failed");
    await run.pump;
  });

  it.each([429, 401, 403, 500])("HTTP %i never waits, even with a waiter present (guard)", async (status) => {
    failThenSucceed(9, () => statusError(status));
    const waiter = makeWaiter(false);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 3, networkRetryBudgetMs: 0, networkWaitMaxMs: 600_000 }), networkWaiter: waiter });
    const result = await settle(collect(port.streamText(baseRequest)), 200_000);
    expect(result.ok).toBe(false);
    expect(waiter.probes).toBe(0);
    expect(mockStreamText.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("a transient failure with the probe online keeps the ordinary jittered retry (guard)", async () => {
    failThenSucceed(1, connectTimeout);
    const waiter = makeWaiter(true);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 2, networkRetryBudgetMs: 0, networkWaitMaxMs: 600_000 }), networkWaiter: waiter });
    const result = await settle(collect(port.streamText(baseRequest)), 20_000);
    expect(result.ok).toBe(true);
    const events = result.value as Array<{ type: string }>;
    expect(events.map((e) => e.type)).not.toContain("waiting_for_network");
    expect(events.find((e) => e.type === "stream_retry")).toMatchObject({ attempt: 1, delayMs: 10_000 });
  });

  it("a mid-stream failure (model output already delivered) is never waited out (guard)", async () => {
    const textDelta = { type: "text-delta", id: "t", text: "partial" };
    mockStreamText.mockImplementation(() => fakeResult([part(startPart), part(textDelta), throwsWith(connectTimeout())]));
    const waiter = makeWaiter(false);
    const port = new AiSdkModelPort({ ...baseConfig({ ...slow, maxRetries: 1, midStreamRetries: 0, networkRetryBudgetMs: 0, networkWaitMaxMs: 600_000 }), networkWaiter: waiter });
    const result = await settle(collect(port.streamText(baseRequest)), 60_000);
    expect(waiter.probes).toBe(0);
    expect(result.ok).toBe(false);
  });
});

// Taskana 4090 (TASK.71): the port's quota observation lifecycle. The
// constructor installs a port-owned shim over `config.onQuotaHeaders` (the
// shim writes `#lastQuota` then forwards); the factories see that shim via
// the config. Tests capture the shim from the config the factory received,
// then drive it like the wrapped fetch would (fetch resolves before the SDK
// decodes any body part), with a DEFERRED scripted stream so the observation
// lands between `start` and `finish`.
function deferredQuotaResult(
  parts: () => unknown[],
): { result: ReturnType<typeof fakeResult>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = {
    fullStream: (async function* () {
      await gate;
      for (const p of parts()) {
        yield p as never;
      }
    })(),
  } as unknown as ReturnType<typeof fakeResult>;
  return { result, release };
}

type QuotaCb = (update: import("./quota.js").ProviderQuotaUpdate | null, baseUrl: string) => void;

describe("AiSdkModelPort — provider_quota emission (Taskana 4090)", () => {
  it("yields exactly one provider_quota immediately after finish, carrying the port's baseUrl", async () => {
    const onQuotaHeaders = vi.fn();
    const { result, release } = deferredQuotaResult(() => [startPart, finishPart]);
    mockStreamText.mockImplementationOnce(() => result);

    // Capture the shim from the config handed to the factory.
    let shim: QuotaCb | undefined;
    const realCreate = mockCreateLanguageModel.getMockImplementation();
    mockCreateLanguageModel.mockImplementationOnce((seen: EndpointConfig) => {
      shim = seen.onQuotaHeaders;
      return realCreate ? realCreate(seen) : ({} as never);
    });

    const port = new AiSdkModelPort({ ...baseConfig(), onQuotaHeaders });
    const eventsPromise = collect(port.streamText(baseRequest));
    await vi.waitFor(() => expect(shim).toBeDefined());

    // The wrapped fetch resolves before the SDK decodes the body: the
    // observation arrives while the stream is gated between parts.
    shim!({ primary: { usedPercent: 80 }, sources: ["x-ratelimit-requests-remaining"] }, "https://api.example.com");
    release();
    const events = await eventsPromise;

    const finishIndex = events.findIndex((e) => e.type === "finish");
    expect(finishIndex).toBeGreaterThanOrEqual(0);
    expect(events[finishIndex + 1]).toEqual({
      type: "provider_quota",
      quota: { primary: { usedPercent: 80 }, sources: ["x-ratelimit-requests-remaining"] },
      baseUrl: "https://api.example.com",
    });
    expect(events.filter((e) => e.type === "provider_quota")).toHaveLength(1);
    // The original observer still receives the forwarded update (host-side
    // forwarder contract) — and the port shim did not loop it back.
    expect(onQuotaHeaders).toHaveBeenCalledTimes(1);
    expect(onQuotaHeaders).toHaveBeenCalledWith(
      { primary: { usedPercent: 80 }, sources: ["x-ratelimit-requests-remaining"] },
      "https://api.example.com",
    );
  });

  it("re-emits with the NEW value on a retried attempt", async () => {
    const error = retryableError();
    // Attempt 0: retryable throw before any finish (ungated). Attempt 1:
    // gated between `start` and `finish` so the fresh observation can land.
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), throwsWith(error)]),
    );
    const { result: r1, release: rel1 } = deferredQuotaResult(() => [startPart, finishPart]);
    mockStreamText.mockImplementationOnce(() => r1);

    let shim: QuotaCb | undefined;
    const realCreate = mockCreateLanguageModel.getMockImplementation();
    mockCreateLanguageModel.mockImplementation((seen: EndpointConfig) => {
      shim = seen.onQuotaHeaders;
      return realCreate ? realCreate(seen) : ({} as never);
    });

    const port = new AiSdkModelPort({ ...baseConfig({ maxRetries: 1 }), onQuotaHeaders: () => {} });

    const events: unknown[] = [];
    const iterating = (async () => {
      for await (const e of port.streamText(baseRequest)) events.push(e);
    })();
    await vi.waitFor(() => expect(shim).toBeDefined());
    await vi.waitFor(() => expect(mockStreamText).toHaveBeenCalledTimes(2));
    // Attempt 0 threw before finish → no emission even if headers arrived;
    // attempt 1 reports a FRESH value which IS emitted after its finish.
    shim!({ primary: { usedPercent: 95 }, sources: ["x-ratelimit-requests-remaining"] }, "https://api.example.com");
    rel1();
    await iterating;

    const quotaEvents = events.filter((e) => (e as { type: string }).type === "provider_quota") as Array<{
      type: "provider_quota";
      quota: import("./quota.js").ProviderQuotaUpdate;
    }>;
    expect(quotaEvents).toHaveLength(1);
    expect(quotaEvents[0]!.quota.primary?.usedPercent).toBe(95);
  });

  it("emits no provider_quota when the callback was never called", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));
    const port = new AiSdkModelPort({ ...baseConfig(), onQuotaHeaders: () => {} });
    const events = await collect(port.streamText(baseRequest));
    expect(events.some((e) => e.type === "provider_quota")).toBe(false);
  });

  it("forwards the SAME config object identity when no onQuotaHeaders is set (dormancy)", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    const config = baseConfig();
    const port = new AiSdkModelPort(config);
    await collect(port.streamText(baseRequest));
    const seen = mockCreateLanguageModel.mock.calls[0]![0] as EndpointConfig;
    expect(seen).toBe(config); // identity passthrough — no rewrap, no spread
    expect(seen.onQuotaHeaders).toBeUndefined();
  });
});

describe("AiSdkModelPort — mid-stream replay (Taskana 4705)", () => {
  const textDelta = (text: string) => ({ type: "text-delta", id: "t1", text });
  const toolCallPart = { type: "tool-call", toolCallId: "call_1", toolName: "Read", input: { file_path: "/a.txt" } };

  it("midStreamRetries: 0 preserves pre-4705 behavior — an error part after a text_delta never retries", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), part(textDelta("hi")), part({ type: "error", error })]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, midStreamRetries: 0 }));
    const events = await collect(port.streamText(baseRequest));

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    expect(events).toEqual([
      { type: "start" },
      { type: "text_delta", id: "t1", text: "hi" },
      { type: "error", error },
    ]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it.each(["yielded", "thrown"] as const)("retries reasoning failures through the %s path using the shared budget", async (path) => {
    const failure = () => path === "yielded" ? part({ type: "error", error: retryableError() }) : throwsWith(retryableError());
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), failure()]));
    for (let i = 0; i < 4; i++) mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part({ type: "reasoning-delta", id: "r", text: "partial" }), failure()]));
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part(finishPart)]));
    const events = await collect(new AiSdkModelPort(baseConfig({ maxRetries: 8, midStreamRetries: 0, networkRetryBudgetMs: 0 })).streamText(baseRequest));
    expect(events.filter(e => e.type === "stream_retry")).toHaveLength(5);
    expect(events.at(-1)?.type).toBe("finish");
    expect(mockStreamText).toHaveBeenCalledTimes(6);
  });

  it("retries a reasoning drop after an empty text block", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([
      part(startPart), part({ type: "text-start", id: "t" }), part({ type: "text-end", id: "t" }),
      part({ type: "reasoning-delta", id: "r", text: "partial" }), part({ type: "error", error: retryableError() }),
    ])).mockImplementationOnce(() => fakeResult([part(startPart), part(textDelta("recovered")), part(finishPart)]));
    const events = await collect(new AiSdkModelPort(baseConfig({ maxRetries: 1, networkRetryBudgetMs: 0 })).streamText(baseRequest));
    expect(events.filter(e => e.type === "stream_retry")).toHaveLength(1);
    expect(events).toContainEqual({ type: "text_delta", id: "t1", text: "recovered" });
    expect(events.at(-1)?.type).toBe("finish");
  });

  it.each(["text", "tool input", "tool call"] as const)("does not replay after %s", async (kind) => {
    const output = kind === "text" ? textDelta("hi") : kind === "tool input" ? { type: "tool-input-start", id: "call_1", toolName: "Read" } : toolCallPart;
    mockStreamText.mockImplementationOnce(() => fakeResult([part(startPart), part(output), part({ type: "error", error: retryableError() })]));
    const events = await collect(new AiSdkModelPort(baseConfig({ maxRetries: 8 })).streamText(baseRequest));
    expect(events.some(e => e.type === "stream_retry")).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("stops after the exact count of reasoning retries", async () => {
    mockStreamText.mockImplementation(() => fakeResult([part({ type: "reasoning-delta", id: "r", text: "partial" }), part({ type: "error", error: retryableError() })]));
    const events = await collect(new AiSdkModelPort(baseConfig({ maxRetries: 8, midStreamRetries: 0, networkRetryBudgetMs: 0 })).streamText(baseRequest));
    expect(events.filter(e => e.type === "stream_retry")).toHaveLength(8);
    expect(events.at(-1)?.type).toBe("error");
    expect(mockStreamText).toHaveBeenCalledTimes(9);
  });

  it("stops after a reasoning retry followed by partial tool input and a thrown error", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() => fakeResult([part({ type: "reasoning-delta", id: "r", text: "partial" }), throwsWith(error)]))
      .mockImplementationOnce(() => fakeResult([part({ type: "tool-input-start", id: "call", toolName: "Read" }), part({ type: "tool-input-delta", id: "call", delta: "{" }), throwsWith(error)]));
    const events: import("../types/events.js").ModelStreamEvent[] = [];
    await expect((async () => { for await (const event of new AiSdkModelPort(baseConfig({ maxRetries: 8, midStreamRetries: 0 })).streamText(baseRequest)) events.push(event); })()).rejects.toBe(error);
    expect(events.filter(e => e.type === "stream_retry")).toHaveLength(1);
    expect(events.some(e => e.type === "tool_input_delta")).toBe(true);
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });

  it("cancels during the backoff after provisional reasoning", async () => {
    mockStreamText.mockImplementationOnce(() => fakeResult([part({ type: "reasoning-delta", id: "r", text: "partial" }), part({ type: "error", error: retryableError() })]));
    const controller = new AbortController();
    const iterator = new AiSdkModelPort(baseConfig({ maxRetries: 8, baseDelayMs: 1000, maxDelayMs: 1000 })).streamText({ ...baseRequest, abortSignal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("reasoning_delta");
    expect((await iterator.next()).value?.type).toBe("stream_retry");
    controller.abort(new Error("cancelled"));
    await expect(iterator.next()).rejects.toThrow("cancelled");
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("refuses reasoning retries when the count is zero", async () => {
    mockStreamText.mockImplementation(() => fakeResult([part({ type: "reasoning-delta", id: "r", text: "x" }), part({ type: "error", error: retryableError() })]));
    const events = await collect(new AiSdkModelPort(baseConfig({ maxRetries: 0, networkRetryBudgetMs: 1000 })).streamText(baseRequest));
    expect(events.some(e => e.type === "stream_retry")).toBe(false);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429])("does not retry a non-retryable %s after reasoning", async (statusCode) => {
    const error = new APICallError({ message: statusCode === 429 ? "Insufficient quota" : "invalid key", url: "https://example.com", requestBodyValues: {}, statusCode, isRetryable: false });
    mockStreamText.mockImplementationOnce(() => fakeResult([part({ type: "reasoning-delta", id: "r", text: "x" }), part({ type: "error", error })]));
    const events = await collect(new AiSdkModelPort(baseConfig({ maxRetries: 8 })).streamText(baseRequest));
    expect(events.some(e => e.type === "stream_retry")).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not park or replay a thrown network failure after text", async () => {
    const waiter = { probe: vi.fn(async () => false), subscribe: vi.fn(() => () => {}), monotonicNow: () => 0 };
    const error = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    mockStreamText.mockImplementationOnce(() => fakeResult([part(textDelta("delivered")), throwsWith(error)]));
    const port = new AiSdkModelPort({ ...baseConfig({ maxRetries: 8, networkWaitMaxMs: 60000 }), networkWaiter: waiter });
    await expect(collect(port.streamText(baseRequest))).rejects.toThrow("socket hang up");
    expect(waiter.probe).not.toHaveBeenCalled();
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh retry budget for each model step", async () => {
    for (let step = 0; step < 2; step++) {
      mockStreamText.mockImplementationOnce(() => fakeResult([part({ type: "reasoning-delta", id: "r", text: "x" }), part({ type: "error", error: retryableError() })]));
      mockStreamText.mockImplementationOnce(() => fakeResult([part(finishPart)]));
    }
    const port = new AiSdkModelPort(baseConfig({ maxRetries: 1, midStreamRetries: 0 }));
    for (let step = 0; step < 2; step++) expect((await collect(port.streamText(baseRequest))).filter(e => e.type === "stream_retry")).toHaveLength(1);
    expect(mockStreamText).toHaveBeenCalledTimes(4);
  });

  it("a quota-429 error part never auto-retries, even mid-stream-disabled defaults aside (maxRetries 8, replay on)", async () => {
    const quota = new APICallError({
      message: "Insufficient quota for this account (code 1308)",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: false,
    });
    mockStreamText.mockImplementation(() => fakeResult([part(startPart), part({ type: "error", error: quota })]));

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 8, midStreamRetries: 2 }));
    const events = await collect(port.streamText(baseRequest));

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    expect(events).toEqual([{ type: "start" }, { type: "error", error: quota }]);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });


});

describe("AiSdkModelPort — Taskana 4705 review: replay gates", () => {
  const textDelta = (text: string) => ({ type: "text-delta", id: "t1", text });

  it("never replays a step once a non-error finish was seen, even with replay enabled (error part)", async () => {
    const error = retryableError();
    mockStreamText.mockImplementation(() =>
      fakeResult([part(startPart), part(textDelta("hi")), part(finishPart), part({ type: "error", error })]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, midStreamRetries: 2 }));
    const events = await collect(port.streamText(baseRequest));

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "error", error });
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it("never replays a step once a non-error finish was seen, even with replay enabled (thrown)", async () => {
    const error = retryableError();
    mockStreamText.mockImplementation(() =>
      fakeResult([part(startPart), part(textDelta("hi")), part(finishPart), throwsWith(error)]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, midStreamRetries: 2 }));
    await expect(collect(port.streamText(baseRequest))).rejects.toThrow("overloaded");
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  describe("stall path", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("maxRetries: 0 disables a mid-stream replay on the stall path too (Taskana 4705 review)", async () => {
      mockStreamText.mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: "text-delta", id: "t1", text: "a" };
          await new Promise(() => {});
        })(),
      }));

      const port = new AiSdkModelPort(baseConfig({ maxRetries: 0, midStreamRetries: 2, stallTimeoutMs: 20 }));
      const iterator = port.streamText(baseRequest)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: "text_delta", text: "a" });

      const finalPromise = iterator.next();
      const assertion = expect(finalPromise).rejects.toThrow(/stream stalled/);
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(mockStreamText).toHaveBeenCalledTimes(1);
    });

    it("a mid-stream stall counts inside maxRetries: after the pre-content stall spent it, the post-output stall throws", async () => {
      mockStreamText
        .mockImplementationOnce(() => ({
          fullStream: (async function* () {
            yield startPart;
            await new Promise(() => {});
          })(),
        }))
        .mockImplementationOnce(() => ({
          fullStream: (async function* () {
            yield startPart;
            yield { type: "text-delta", id: "t1", text: "a" };
            await new Promise(() => {});
          })(),
        }));

      const port = new AiSdkModelPort(baseConfig({ maxRetries: 1, midStreamRetries: 2, stallTimeoutMs: 20 }));
      const iterator = port.streamText(baseRequest)[Symbol.asyncIterator]();

      expect((await iterator.next()).value).toEqual({ type: "start" });
      const stallPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(20);
      expect((await stallPromise).value).toMatchObject({ type: "stream_retry", attempt: 1, maxAttempts: 1 });

      const afterRetry = iterator.next();
      await vi.advanceTimersByTimeAsync(10);
      expect((await afterRetry).value).toEqual({ type: "start" });
      expect((await iterator.next()).value).toMatchObject({ type: "text_delta", text: "a" });

      const finalPromise = iterator.next();
      const assertion = expect(finalPromise).rejects.toThrow(/stream stalled/);
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(mockStreamText).toHaveBeenCalledTimes(2);
    });

    it("a stall after a non-error finish ends the step without replaying it (Taskana 4705 review)", async () => {
      mockStreamText.mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield startPart;
          yield { type: "text-delta", id: "t1", text: "hi" };
          yield finishPart;
          await new Promise(() => {});
        })(),
      }));

      const port = new AiSdkModelPort(baseConfig({ maxRetries: 3, midStreamRetries: 2, stallTimeoutMs: 20 }));
      const done = collect(port.streamText(baseRequest));
      await vi.advanceTimersByTimeAsync(20);
      const events = await done;

      expect(events.some((e) => e.type === "stream_retry")).toBe(false);
      expect(events.at(-1)?.type).toBe("finish");
      expect(mockStreamText).toHaveBeenCalledTimes(1);
    });
  });
});
