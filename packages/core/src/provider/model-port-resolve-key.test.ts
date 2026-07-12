/**
 * Per-attempt api-key resolution tests (slice 2.5 §3.3). AiSdkModelPort resolves
 * a fresh key at the START of each attempt when `resolveApiKey` is configured, so
 * a mid-session-refreshed OAuth token is picked up on a retry. Both the AI SDK
 * `streamText` and `createAnthropicLanguageModel` are mocked so we can (a) script
 * an attempt to fail-before-yield (forcing a retry) and (b) observe the exact
 * apiKey each attempt hands to the client factory.
 */

import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { AnthropicEndpointConfig } from "./anthropic.js";

const mockStreamText = vi.fn();

const hoisted = vi.hoisted(() => ({
  capturedApiKeys: [] as string[],
  capturedConfigs: [] as unknown[],
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
  };
});

vi.mock("./anthropic.js", () => ({
  createAnthropicLanguageModel: (config: { apiKey: string }) => {
    hoisted.capturedApiKeys.push(config.apiKey);
    hoisted.capturedConfigs.push(config);
    return { __fakeModel: true };
  },
}));

const { AiSdkModelPort } = await import("./model-port.js");

type FakeStep = { kind: "part"; part: Record<string, unknown> } | { kind: "throw"; error: unknown };

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

function config(overrides: Partial<AnthropicEndpointConfig>): AnthropicEndpointConfig {
  return {
    baseUrl: "https://api.example.com",
    apiKey: "static-key",
    model: "claude-test",
    retry: { baseDelayMs: 1, maxDelayMs: 1 },
    ...overrides,
  };
}

const baseRequest: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

async function collect(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

beforeEach(() => {
  mockStreamText.mockReset();
  hoisted.capturedApiKeys.length = 0;
  hoisted.capturedConfigs.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AiSdkModelPort — per-attempt resolveApiKey (slice 2.5 §3.3)", () => {
  it("resolves a fresh key at the start of each attempt (new value is visible on retry)", async () => {
    // Attempt 1 fails before yielding (retryable) -> attempt 2 succeeds. The
    // resolver returns a DIFFERENT key each call, proving each attempt re-resolves.
    mockStreamText
      .mockImplementationOnce(() => fakeResult([{ kind: "throw", error: retryableError() }]))
      .mockImplementationOnce(() =>
        fakeResult([{ kind: "part", part: startPart }, { kind: "part", part: finishPart }]),
      );

    const resolveApiKey = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("key-attempt-1")
      .mockResolvedValueOnce("key-attempt-2");

    const port = new AiSdkModelPort(config({ resolveApiKey, retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } }));
    const events = await collect(port.streamText(baseRequest));

    expect(resolveApiKey).toHaveBeenCalledTimes(2);
    expect(hoisted.capturedApiKeys).toEqual(["key-attempt-1", "key-attempt-2"]);
    // The successful second attempt still produced real events.
    expect(events.some((e) => e.type === "finish")).toBe(true);
    expect(events.some((e) => e.type === "stream_retry")).toBe(true);
  });

  it("falls back to the static apiKey when the resolver rejects", async () => {
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([{ kind: "part", part: startPart }, { kind: "part", part: finishPart }]),
    );
    const resolveApiKey = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("refresh failed"));

    const port = new AiSdkModelPort(config({ resolveApiKey }));
    await collect(port.streamText(baseRequest));

    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    expect(hoisted.capturedApiKeys).toEqual(["static-key"]);
  });

  it("falls back to the static apiKey when the resolver returns blank", async () => {
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([{ kind: "part", part: startPart }, { kind: "part", part: finishPart }]),
    );
    const resolveApiKey = vi.fn<() => Promise<string>>().mockResolvedValue("   ");

    const port = new AiSdkModelPort(config({ resolveApiKey }));
    await collect(port.streamText(baseRequest));

    expect(hoisted.capturedApiKeys).toEqual(["static-key"]);
  });

  it("with no resolver, passes the config object through unchanged (byte-for-byte 2.2)", async () => {
    mockStreamText.mockImplementationOnce(() =>
      fakeResult([{ kind: "part", part: startPart }, { kind: "part", part: finishPart }]),
    );

    const cfg = config({});
    const port = new AiSdkModelPort(cfg);
    await collect(port.streamText(baseRequest));

    expect(hoisted.capturedApiKeys).toEqual(["static-key"]);
    // Identity check: the not-set path hands the ORIGINAL config to the factory,
    // never a `{...config, apiKey}` copy.
    expect(hoisted.capturedConfigs[0]).toBe(cfg);
  });
});
