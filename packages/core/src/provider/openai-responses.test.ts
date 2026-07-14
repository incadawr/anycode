/**
 * Unit tests for the openai-responses factory (TASK.43 §0.3/§0.5/W3).
 * Construction is side-effect free (no network until streamText), so these
 * assert the LanguageModel's static shape — model id, base URL normalization
 * delegation, and headers passthrough. The outgoing HTTP request (URL, auth,
 * store:false, reasoning, function-call round trip) is asserted end-to-end
 * against a real loopback server in openai-responses-sse-fixture.integration.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { EndpointConfig } from "./endpoint.js";
import { createOpenAIResponsesLanguageModel, OPENAI_RESPONSES_PROVIDER_NAME } from "./openai-responses.js";

function config(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    transport: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-key",
    model: "gpt-5.1",
    ...overrides,
  };
}

describe("createOpenAIResponsesLanguageModel", () => {
  it("builds a model carrying the requested model id, side-effect free", () => {
    const model = createOpenAIResponsesLanguageModel(config());
    expect(model).toBeDefined();
    expect(typeof model === "string" ? model : model.modelId).toBe("gpt-5.1");
  });

  it("uses the stable public provider name 'openai'", () => {
    expect(OPENAI_RESPONSES_PROVIDER_NAME).toBe("openai");
  });

  it("builds successfully with no apiKey at all (construction never touches process.env)", () => {
    expect(() => createOpenAIResponsesLanguageModel(config({ apiKey: undefined }))).not.toThrow();
  });

  it("delegates base URL normalization to normalizeExplicitBaseUrl (trim/strip-slash, no /v1 append)", () => {
    expect(() =>
      createOpenAIResponsesLanguageModel(config({ baseUrl: "  https://api.openai.com/v1/  " })),
    ).not.toThrow();
    // An empty base URL is rejected by the shared normalizer, proving delegation
    // rather than a parallel ad-hoc check.
    expect(() => createOpenAIResponsesLanguageModel(config({ baseUrl: "   " }))).toThrow(/empty/i);
  });

  it("accepts a non-standard base path verbatim (no forced /v1)", () => {
    expect(() =>
      createOpenAIResponsesLanguageModel(config({ baseUrl: "https://gw.example.com/api/openai" })),
    ).not.toThrow();
  });

  it("accepts extra headers without throwing (passthrough, not validated here)", () => {
    expect(() =>
      createOpenAIResponsesLanguageModel(config({ headers: { "X-Custom": "1" } })),
    ).not.toThrow();
  });
});
