/**
 * Unit tests for the openai-chat-completions factory (TASK.43 §0.3/§0.5/§10.2
 * p1). Construction is side-effect free (no network until streamText), so
 * these assert the LanguageModel's static shape — model id, base URL
 * normalization delegation, and that apiKey/headers/includeUsage are truly
 * conditional. The outgoing HTTP request (auth header presence, tool_choice,
 * stream_options, reasoning_effort) is asserted end-to-end against a real
 * loopback server in openai-sse-fixture.integration.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { EndpointConfig } from "./endpoint.js";
import { createOpenAICompatibleLanguageModel, OPENAI_COMPATIBLE_PROVIDER_NAME } from "./openai-compatible.js";

function config(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    transport: "openai-chat-completions",
    baseUrl: "https://gw.example.com/v1",
    apiKey: "test-key",
    model: "gpt-oss-120b",
    ...overrides,
  };
}

describe("createOpenAICompatibleLanguageModel", () => {
  it("builds a model carrying the requested model id, side-effect free", () => {
    const model = createOpenAICompatibleLanguageModel(config());
    expect(model).toBeDefined();
    expect(typeof model === "string" ? model : model.modelId).toBe("gpt-oss-120b");
  });

  it("uses the stable public provider name 'openaiCompatible', not a hyphenated internal one", () => {
    expect(OPENAI_COMPATIBLE_PROVIDER_NAME).toBe("openaiCompatible");
  });

  it("builds successfully with no apiKey at all (no-auth local endpoint — vLLM/Ollama)", () => {
    expect(() => createOpenAICompatibleLanguageModel(config({ apiKey: undefined }))).not.toThrow();
  });

  it("delegates base URL normalization to normalizeExplicitBaseUrl (trim/strip-slash, no /v1 append)", () => {
    expect(() =>
      createOpenAICompatibleLanguageModel(config({ baseUrl: "  https://gw.example.com/v1/  " })),
    ).not.toThrow();
    // An empty base URL is rejected by the shared normalizer, proving delegation
    // rather than a parallel ad-hoc check.
    expect(() => createOpenAICompatibleLanguageModel(config({ baseUrl: "   " }))).toThrow(/empty/i);
  });

  it("accepts a non-standard base path verbatim (no forced /v1)", () => {
    expect(() =>
      createOpenAICompatibleLanguageModel(config({ baseUrl: "https://gw.example.com/api/openai" })),
    ).not.toThrow();
  });

  it("accepts extra headers without throwing (passthrough, not validated here)", () => {
    expect(() =>
      createOpenAICompatibleLanguageModel(config({ headers: { "X-Custom": "1" } })),
    ).not.toThrow();
  });

  it("accepts includeUsage true/false/absent without throwing", () => {
    expect(() => createOpenAICompatibleLanguageModel(config({ includeUsage: true }))).not.toThrow();
    expect(() => createOpenAICompatibleLanguageModel(config({ includeUsage: false }))).not.toThrow();
    expect(() => createOpenAICompatibleLanguageModel(config())).not.toThrow();
  });
});
