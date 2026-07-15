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

const mockStreamText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
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

  it("keeps GLM reasoning requests within Z.AI's 131072 max_tokens wire ceiling", () => {
    const high = reasoningRequestOptions(
      { ...baseRequest, maxOutputTokens: 131_072, reasoningEffort: "high" },
      "Z.AI (GLM)",
    );
    expect(high.maxOutputTokens).toBe(115_072);
    expect(high.maxOutputTokens! + high.providerOptions!.anthropic.thinking.budgetTokens).toBe(131_072);

    const max = reasoningRequestOptions(
      { ...baseRequest, maxOutputTokens: 131_072, reasoningEffort: "max" },
      "Z.AI (GLM)",
    );
    expect(max.maxOutputTokens).toBe(99_072);
    expect(max.maxOutputTokens! + max.providerOptions!.anthropic.thinking.budgetTokens).toBe(131_072);
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AiSdkModelPort — happy path", () => {
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

describe("AiSdkModelPort — no retry after model output", () => {
  it("propagates a mid-stream thrown error without retrying once MODEL OUTPUT has been yielded", async () => {
    const error = retryableError();
    // start alone no longer closes the gate (W7a); a text_delta does — the
    // subsequent throw must NOT retry (mid-stream replay could duplicate text).
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), part({ type: "text-delta", id: "t1", text: "hi" }), throwsWith(error)]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
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

describe("AiSdkModelPort — W7a model-output retry gate", () => {
  const textDelta = (text: string) => ({ type: "text-delta", id: "t1", text });
  const toolCallPart = { type: "tool-call", toolCallId: "call_1", toolName: "Read", input: { file_path: "/a.txt" } };

  it("start → text_delta → retryable error part ⇒ NO retry (content closed the gate)", async () => {
    const error = retryableError();
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([part(startPart), part(textDelta("hi")), part({ type: "error", error })]),
    );

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
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

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
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

    const port = new AiSdkModelPort(baseConfig({ maxRetries: 3 }));
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
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
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
        yield { type: "text-delta", id: "t1", text: "a" };
        yield { type: "text-delta", id: "t1", text: "b" };
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

    expect((await iterator.next()).value).toMatchObject({ type: "text_delta", text: "a" });
    expect((await iterator.next()).value).toMatchObject({ type: "text_delta", text: "b" });

    const stallPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(50);
    const retryEvent = await stallPromise;
    expect(retryEvent.value).toMatchObject({
      type: "stream_retry",
      attempt: 1,
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
    "passes openai-responses effort %s through VERBATIM (no chat-completions-style max->high collapse), alongside store:false",
    (effort) => {
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

  it("collapses openai-chat-completions effort max to high (no max/xhigh tier on chat-completions)", () => {
    expect(
      reasoningRequestOptions({ ...baseRequest, reasoningEffort: "max" }, "custom", "openai-chat-completions"),
    ).toEqual({
      providerOptions: { openaiCompatible: { reasoningEffort: "high" } },
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
