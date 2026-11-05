import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSdkModelPort } from "./model-port.js";
import { classifyProviderFailure } from "./failure.js";
import type { ProviderTransport } from "./catalog.js";

const key = "fixture-key-with-special.$chars";
afterEach(() => vi.unstubAllGlobals());

describe("provider HTTP errors", () => {
  it.each([
    ["anthropic-messages", { type: "error", error: { type: "invalid_request_error", message: `Model unavailable for ${key}` } }],
    ["openai-chat-completions", { error: { code: "invalid_request", message: `Model unavailable for ${key}` } }],
    ["openai-responses", { error: { code: "invalid_request", message: `Model unavailable for ${key}` } }],
  ] as const)("shows a sanitized JSON message for %s", async (transport, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } })));
    const port = new AiSdkModelPort({ transport, baseUrl: "https://fixture.invalid/v1", apiKey: "old-key", resolveApiKey: async () => key, model: "fixture", includeUsage: false, retry: { maxRetries: 0 } });
    let failure: unknown;
    try {
      for await (const event of port.streamText({ messages: [{ role: "user", content: "hello" }], tools: [] })) {
        if (event.type === "error") failure = event.error;
      }
    } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(classifyProviderFailure(failure).safe.message).toBe("Model unavailable for ***");
  });

  it.each([
    [JSON.stringify({ message: `Invalid model ${key}` }), "Invalid model ***"],
    [JSON.stringify({ error: { message: "bad model ".repeat(50) } }), "bad model ".repeat(30)],
    [JSON.stringify({ error: { type: "invalid_request_error" } }), "invalid_request_error"],
    [JSON.stringify({ error: { code: "invalid_request" } }), "invalid_request"],
    ["not JSON, contains " + key, "request failed"],
    [JSON.stringify({ error: { message: "Bearer private-token" } }), "[redacted]"],
  ])("limits and redacts message from fixture", async (body, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 400, headers: { "content-type": "application/json" } })));
    const port = new AiSdkModelPort({ transport: "openai-chat-completions" as ProviderTransport, baseUrl: "https://fixture.invalid/v1", apiKey: key, model: "fixture", includeUsage: false, retry: { maxRetries: 0 } });
    let failure: unknown;
    try {
      for await (const event of port.streamText({ messages: [{ role: "user", content: "hello" }], tools: [] })) if (event.type === "error") failure = event.error;
    } catch (error) { failure = error; }
    expect(classifyProviderFailure(failure).safe.message).toBe(expected);
  });
});
